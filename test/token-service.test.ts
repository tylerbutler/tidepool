import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { verify } from "../src/auth.js";
import { integer, record, text } from "../src/common.js";
import adminWorker from "../src/token-worker.js";
import tokenWorker, { type TokenEnv } from "../token-service/src/worker.js";

const demo = {
	TENANT_ID: "fluid",
	JWT_SECRET: "public-demo-signing-key-at-least-32-bytes",
	TOKEN_AUTH_MODE: "anonymous",
} satisfies TokenEnv;

function request(body: unknown, headers: Record<string, string> = {}) {
	return new Request("https://mint.example/tokens", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

it.each([
	"",
	"demo",
])("issues anonymous tokens for %j only after explicit opt-in", async (documentId) => {
	const ctx = {
		access: {
			aud: "irrelevant",
			getIdentity: vi.fn().mockRejectedValue(new Error("not used")),
		},
	};
	const response = await tokenWorker.fetch(request({ documentId }), demo, ctx);
	expect(response.status).toBe(200);
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	const result = record(await response.json());
	const claims = await verify(text(result.jwt), demo, "fluid", documentId, [
		"doc:read",
		"doc:write",
		"summary:write",
	]);
	expect(claims.user.id).toMatch(/^anonymous:[0-9a-f-]{36}$/);
	expect(claims.scopes).toEqual(["doc:read", "doc:write", "summary:write"]);
	expect(integer(claims.exp) - integer(claims.iat)).toBe(900);
	expect(result.expiresAt).toBe(claims.exp);
	expect(ctx.access.getIdentity).not.toHaveBeenCalled();
	const next = await tokenWorker.fetch(request({ documentId }), demo, {});
	const nextClaims = await verify(
		text(record(await next.json()).jwt),
		demo,
		"fluid",
		documentId,
		["doc:read"],
	);
	expect(nextClaims.user.id).not.toBe(claims.user.id);
});

it.each([
	undefined,
	"",
	"public",
	"Anonymous",
])("does not fall back to anonymous issuance for mode %j", async (mode) => {
	const response = await tokenWorker.fetch(
		request({ documentId: "demo" }),
		{ ...demo, TOKEN_AUTH_MODE: mode },
		{},
	);
	expect(response.status).toBe(503);
	expect(await response.json()).not.toHaveProperty("jwt");
});

it.each([
	{ ...demo, JWT_SECRET: undefined },
	{ ...demo, JWT_SECRET: "short" },
	{ ...demo, TENANT_ID: undefined },
])("still requires valid signing configuration in anonymous mode", async (env) => {
	const response = await tokenWorker.fetch(
		request({ documentId: "demo" }),
		env,
		{},
	);
	expect(response.status).toBe(503);
	expect(await response.json()).not.toHaveProperty("jwt");
});

it("rejects caller-selected identities and claims, ignoring forged Access headers", async () => {
	const forged = await tokenWorker.fetch(
		request(
			{ documentId: "demo" },
			{
				"Cf-Access-Authenticated-User-Email": "forged@example.test",
				"Cf-Access-Jwt-Assertion": "forged",
			},
		),
		demo,
		{},
	);
	const claims = await verify(
		text(record(await forged.json()).jwt),
		demo,
		"fluid",
		"demo",
		["doc:read"],
	);
	expect(claims.user.id).toMatch(/^anonymous:/);
	const altered = await tokenWorker.fetch(
		request({
			documentId: "demo",
			user: { id: "chosen" },
			tenantId: "other",
			scopes: ["admin"],
			exp: 9999999999,
		}),
		demo,
		{},
	);
	expect(altered.status).toBe(400);
	expect(await altered.json()).not.toHaveProperty("jwt");
});

it("keeps origin, JSON, and streamed body limits in anonymous mode", async () => {
	const allowed = { ...demo, ALLOWED_ORIGIN: "https://app.example" };
	const blocked = await tokenWorker.fetch(
		request({ documentId: "demo" }, { Origin: "https://other.example" }),
		allowed,
		{},
	);
	expect(blocked.status).toBe(403);
	expect(blocked.headers.has("Access-Control-Allow-Origin")).toBe(false);
	const preflight = await tokenWorker.fetch(
		new Request("https://mint.example/tokens", {
			method: "OPTIONS",
			headers: { Origin: allowed.ALLOWED_ORIGIN },
		}),
		allowed,
		{},
	);
	expect(preflight.status).toBe(204);
	expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
		allowed.ALLOWED_ORIGIN,
	);
	const form = await tokenWorker.fetch(
		request({ documentId: "demo" }, { "Content-Type": "text/plain" }),
		demo,
		{},
	);
	expect(form.status).toBe(415);
	const encoded = new TextEncoder().encode(
		JSON.stringify({ documentId: "demo" }).padEnd(2048, " "),
	);
	for (const extra of [false, true]) {
		const init: RequestInit & { duplex: "half" } = {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(encoded);
					if (extra) controller.enqueue(new Uint8Array([32]));
					controller.close();
				},
			}),
			duplex: "half",
		};
		const response = await tokenWorker.fetch(
			new Request("https://mint.example/tokens", init),
			demo,
			{},
		);
		expect(response.status).toBe(extra ? 413 : 200);
	}
	const invalidUtf8 = await tokenWorker.fetch(
		new Request("https://mint.example/tokens", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: new Uint8Array([0xff]),
		}),
		demo,
		{},
	);
	expect(invalidUtf8.status).toBe(400);
});

it.each([
	"/admin",
	"/admin/",
	"/admin/style.css",
	"/admin/unknown",
])("requires explicit anonymous opt-in before exposing %s in the combined Worker", async (path) => {
	const input = new Request(`https://mint.example${path}`, {
		headers: { "Cf-Access-Authenticated-User-Email": "forged@example.test" },
	});
	for (const mode of [undefined, "access", "", "public"]) {
		const response = await adminWorker.fetch(
			input,
			{ ...demo, TOKEN_AUTH_MODE: mode, ACCESS_AUDIENCE: "admin-app" },
			{},
		);
		expect(response.status).toBe(
			mode === undefined || mode === "access" ? 403 : 503,
		);
		if (response.status === 503)
			expect(await response.clone().json()).toEqual({
				message: "TOKEN_AUTH_MODE must be access or anonymous",
			});
		expect(await response.text()).not.toContain("<!doctype html>");
	}
});

it("serves the admin stylesheet anonymously and still checks origins", async () => {
	const ctx = { access: { aud: "unused", getIdentity: vi.fn() } };
	const response = await adminWorker.fetch(
		new Request("https://mint.example/admin/style.css"),
		demo,
		ctx,
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("Content-Type")).toContain("text/css");
	expect(ctx.access.getIdentity).not.toHaveBeenCalled();
	const blocked = await adminWorker.fetch(
		new Request("https://mint.example/admin/style.css", {
			headers: { Origin: "https://other.example" },
		}),
		demo,
		{},
	);
	expect(blocked.status).toBe(403);
	const unknown = await adminWorker.fetch(
		new Request("https://mint.example/admin/unknown"),
		demo,
		{},
	);
	expect(unknown.status).toBe(404);
});

let runtime: Miniflare;

beforeAll(async () => {
	runtime = new Miniflare({
		workers: [
			{
				name: "demo-core",
				modules: true,
				scriptPath: fileURLToPath(
					new URL("../dist/worker.js", import.meta.url),
				),
				compatibilityDate: "2026-07-30",
				durableObjects: {
					DOCUMENTS: { className: "DocumentDO", useSQLite: true },
				},
				r2Buckets: ["CONTENT"],
				bindings: { TENANT_ID: demo.TENANT_ID, JWT_SECRET: demo.JWT_SECRET },
			},
			{
				name: "demo-mint",
				modules: true,
				scriptPath: fileURLToPath(
					new URL("../token-service/dist/worker.js", import.meta.url),
				),
				compatibilityDate: "2026-07-30",
				bindings: demo,
			},
		],
	});
	await runtime.ready;
});

afterAll(async () => runtime?.dispose());

it("accepts tokens from the standalone anonymous mint in real core workerd without exposing admin routes", async () => {
	const mint = await runtime.getWorker("demo-mint");
	const core = await runtime.getWorker("demo-core");
	const issued = await mint.fetch("https://mint.example/tokens", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ documentId: "public-demo" }),
	});
	expect(issued.status).toBe(200);
	const jwt = text(record(await issued.json()).jwt);
	const created = await core.fetch("https://core.example/documents/fluid", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${jwt}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ id: "public-demo" }),
	});
	expect(created.status).toBe(201);
	const read = await core.fetch(
		"https://core.example/documents/fluid/public-demo",
		{ headers: { Authorization: `Bearer ${jwt}` } },
	);
	expect(read.status).toBe(200);
	for (const path of ["/admin", "/admin/style.css"]) {
		const response = await mint.fetch(`https://mint.example${path}`);
		expect(response.status).toBe(404);
	}
});
