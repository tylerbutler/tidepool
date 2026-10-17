import { expect, it, vi } from "vitest";
import { verify } from "../src/auth.js";
import { integer, record, text } from "../src/common.js";
import tokenWorker, { type TokenEnv } from "../src/token-worker.js";

const env: TokenEnv = {
	TENANT_ID: "fluid",
	JWT_SECRET: "tidepool-token-test-signing-secret-32-bytes",
	ACCESS_AUDIENCE: "token-application",
};

function access(
	identity: CloudflareAccessIdentity | undefined = { user_uuid: "native-user" },
	aud = env.ACCESS_AUDIENCE,
) {
	return {
		access: {
			aud,
			getIdentity: vi
				.fn<CloudflareAccessContext["getIdentity"]>()
				.mockResolvedValue(identity),
		},
	};
}

function request(body: unknown, headers: Record<string, string> = {}) {
	return new Request("https://issuer.example/tokens", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

it.each([
	"document",
	"",
	"é".repeat(128),
])("mints a short-lived Fluid-compatible token for document %j from verified Access identity", async (documentId) => {
	const response = await tokenWorker.fetch(
		request({ documentId }),
		env,
		access(),
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	const result = record(await response.json());
	const claims = await verify(text(result.jwt), env, "fluid", documentId, [
		"doc:read",
		"doc:write",
		"summary:write",
	]);
	expect(claims.user).toEqual({ id: "native-user" });
	expect(claims.scopes).toEqual(["doc:read", "doc:write", "summary:write"]);
	expect(integer(claims.exp) - integer(claims.iat)).toBe(900);
	expect(result.expiresAt).toBe(claims.exp);
});

it("rejects forged Access headers and an authenticated context for another application", async () => {
	const forged = await tokenWorker.fetch(
		request(
			{ documentId: "doc" },
			{
				"Cf-Access-Jwt-Assertion": "forged",
				"Cf-Access-Authenticated-User-Email": "forged@example.test",
			},
		),
		env,
		{},
	);
	expect(forged.status).toBe(403);
	expect(await forged.json()).not.toHaveProperty("jwt");
	const other = access({ user_uuid: "other-user" }, "other-application");
	expect(
		(await tokenWorker.fetch(request({ documentId: "doc" }), env, other))
			.status,
	).toBe(403);
	expect(other.access.getIdentity).not.toHaveBeenCalled();
});

it.each([
	{},
	{ user_uuid: "" },
])("requires a stable Access user identity: %j", async (identity) => {
	const response = await tokenWorker.fetch(
		request({ documentId: "doc" }),
		env,
		access(identity),
	);
	expect(response.status).toBe(403);
	expect(await response.json()).not.toHaveProperty("jwt");
});

it.each([
	{ documentId: 1 },
	{ documentId: "é".repeat(129) },
	{
		documentId: "doc",
		scopes: ["admin"],
		user: { id: "forged" },
		tenantId: "other",
		exp: 9999999999,
	},
])("rejects invalid document requests and caller-selected claims", async (body) => {
	const response = await tokenWorker.fetch(request(body), env, access());
	expect(response.status).toBe(400);
	expect(await response.json()).not.toHaveProperty("jwt");
});

it("enforces the streamed body limit at the exact UTF-8 boundary", async () => {
	const body = JSON.stringify({ documentId: "doc" }).padEnd(2048, " ");
	const exact = await tokenWorker.fetch(
		new Request("https://issuer.example/tokens", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		}),
		env,
		access(),
	);
	expect(exact.status).toBe(200);
	const init: RequestInit & { duplex: "half" } = {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(body));
				controller.enqueue(new TextEncoder().encode(" "));
				controller.close();
			},
		}),
		duplex: "half",
	};
	const oversized = new Request("https://issuer.example/tokens", init);
	const response = await tokenWorker.fetch(oversized, env, access());
	expect(response.status).toBe(413);
	expect(await response.json()).not.toHaveProperty("jwt");
});

it("requires POST and JSON rather than accepting form submissions", async () => {
	for (const [input, status] of [
		[new Request("https://issuer.example/tokens"), 405],
		[request({ documentId: "doc" }, { "Content-Type": "text/plain" }), 415],
		[
			new Request("https://issuer.example/tokens", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{",
			}),
			400,
		],
	] as const) {
		const response = await tokenWorker.fetch(input, env, access());
		expect(response.status).toBe(status);
	}
});

it("checks browser origins and supports credentialed preflight only for an allowed origin", async () => {
	const blocked = await tokenWorker.fetch(
		request({ documentId: "doc" }, { Origin: "https://untrusted.example" }),
		env,
		access(),
	);
	expect(blocked.status).toBe(403);
	expect(blocked.headers.has("Access-Control-Allow-Origin")).toBe(false);
	const browserEnv = { ...env, ALLOWED_ORIGIN: "https://app.example" };
	const preflight = await tokenWorker.fetch(
		new Request("https://issuer.example/tokens", {
			method: "OPTIONS",
			headers: { Origin: browserEnv.ALLOWED_ORIGIN },
		}),
		browserEnv,
		{},
	);
	expect(preflight.status).toBe(204);
	expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
		browserEnv.ALLOWED_ORIGIN,
	);
	expect(preflight.headers.get("Access-Control-Allow-Credentials")).toBe(
		"true",
	);
	const token = await tokenWorker.fetch(
		request({ documentId: "doc" }, { Origin: browserEnv.ALLOWED_ORIGIN }),
		browserEnv,
		access(),
	);
	expect(token.status).toBe(200);
	expect(token.headers.get("Access-Control-Allow-Credentials")).toBe("true");
});

it.each([
	{ ...env, ACCESS_AUDIENCE: "" },
	{ ...env, JWT_SECRET: "" },
	{ ...env, JWT_SECRET: "short" },
])("fails closed when signing or Access configuration is missing", async (settings) => {
	const response = await tokenWorker.fetch(
		request({ documentId: "doc" }),
		settings,
		access(),
	);
	expect(response.status).toBe(503);
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	expect(await response.json()).not.toHaveProperty("jwt");
});

it("reports identity-service failures without minting a token", async () => {
	const ctx = access();
	ctx.access.getIdentity.mockRejectedValueOnce(
		new Error("Identity unavailable"),
	);
	const response = await tokenWorker.fetch(
		request({ documentId: "doc" }),
		env,
		ctx,
	);
	expect(response.status).toBe(503);
	expect(response.headers.get("Retry-After")).toBe("1");
	expect(await response.json()).not.toHaveProperty("jwt");
});
