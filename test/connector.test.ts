import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { ConnectorClient } from "../src/connector.js";
import { secret, token } from "./runtime.js";

let runtime: Miniflare;
let connectors: { POOL_A: ConnectorClient; POOL_B: ConnectorClient };

beforeAll(async () => {
	const root = fileURLToPath(new URL("../", import.meta.url));
	const core = (name: string) => ({
		name,
		rootPath: root,
		modulesRoot: root,
		modules: true,
		scriptPath: `${root}/dist/worker.js`,
		compatibilityDate: "2026-07-30",
		durableObjects: { DOCUMENTS: { className: "DocumentDO", useSQLite: true } },
		r2Buckets: { CONTENT: `${name}-content` },
		bindings: { TENANT_ID: "fluid", JWT_SECRET: secret },
	});
	runtime = new Miniflare({
		unsafeInspectDurableObjects: true,
		workers: [
			core("pool-a"),
			core("pool-b"),
			{
				name: "admin",
				rootPath: root,
				modulesRoot: root,
				modules: true,
				scriptPath: `${root}/connector-harness.js`,
				script: `
					import admin from "./dist/admin/token-worker.js";
					export default {
						fetch(request, env) {
							return admin.fetch(request, env, {
								access: {
									aud: "test-access",
									async getIdentity() { return { user_uuid: "operator" }; }
								}
							});
						}
					};
				`,
				modulesRules: [
					{ type: "ESModule", include: ["**/*.js"] },
					{ type: "Text", include: ["**/*.css"] },
				],
				compatibilityDate: "2026-07-30",
				serviceBindings: {
					POOL_A: { name: "pool-a", entrypoint: "TidepoolConnector" },
					POOL_B: { name: "pool-b", entrypoint: "TidepoolConnector" },
				},
				bindings: {
					ACCESS_AUDIENCE: "test-access",
					TIDEPOOLS: [
						{ id: "a", label: "Pool A", binding: "POOL_A" },
						{ id: "b", label: "Pool B", binding: "POOL_B" },
					],
				},
			},
		],
	});
	await runtime.ready;
	connectors = await runtime.getBindings<typeof connectors>("admin");
	for (const [worker, ids] of [
		["pool-a", ["shared", "a-only"]],
		["pool-b", ["shared", "b-only"]],
	] as const) {
		const binding = await runtime.getWorker(worker);
		for (const id of ids) {
			const response = await binding.fetch(
				"https://documents.example/documents/fluid",
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${await token(id)}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ id }),
				},
			);
			expect(response.status).toBe(201);
		}
	}
});

afterAll(async () => runtime?.dispose());

it("keeps same-tenant deployments separate through actual named service bindings", async () => {
	expect(await connectors.POOL_A.describe()).toEqual({
		ok: true,
		value: { apiVersion: 1, tenantId: "fluid" },
	});
	for (const [connector, own, other] of [
		[connectors.POOL_A, "a-only", "b-only"],
		[connectors.POOL_B, "b-only", "a-only"],
	] as const) {
		const page = await connector.listDocuments();
		expect(page.ok).toBe(true);
		if (!page.ok) throw new Error(page.error.message);
		expect(page.value.documents.map((document) => document.id)).toEqual([
			own,
			"shared",
		]);
		expect(page.value.cursor).toBeNull();
		expect(await connector.inspectDocument("shared")).toMatchObject({
			ok: true,
			value: { id: "shared", tenantId: "fluid", sequenceNumber: 0 },
		});
		expect(await connector.inspectDocument(other)).toMatchObject({
			ok: false,
			error: { status: 404 },
		});
	}
});

it("uses the admin Access identity without a signing key and scopes all navigation to the chosen Tidepool", async () => {
	const admin = await runtime.getWorker("admin");
	const response = await admin.fetch(
		"https://issuer.example/admin?tidepool=b&document=shared&prefix=b",
	);
	expect(response.status).toBe(200);
	const markup = await response.text();
	expect(markup).toContain("Inspect Pool B");
	expect(markup).toContain("b-only");
	expect(markup).not.toContain("a-only");
	expect(markup).toContain('<option value="b" selected>Pool B</option>');
	expect(markup).toContain('name="tidepool" value="b"');
	const links = [...markup.matchAll(/href="([^"]+)"/g)]
		.map((match) => match[1]?.replaceAll("&amp;", "&") ?? "")
		.filter((href) => href.startsWith("/admin?"));
	expect(links.length).toBeGreaterThan(3);
	for (const href of links)
		expect(
			new URL(href, "https://issuer.example").searchParams.get("tidepool"),
		).toBe("b");
	const error = await admin.fetch(
		"https://issuer.example/admin?tidepool=b&document=a-only",
	);
	expect(error.status).toBe(404);
	expect(await error.text()).toContain(
		'href="/admin?tidepool=b">Back to directory</a>',
	);
	const unknown = await admin.fetch(
		"https://issuer.example/admin?tidepool=unconfigured",
	);
	expect(unknown.status).toBe(400);
	expect(await unknown.text()).not.toContain('class="row-link"');
	const tokens = await admin.fetch("https://issuer.example/tokens", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ documentId: "shared" }),
	});
	expect(tokens.status).toBe(503);
	expect(await tokens.json()).not.toHaveProperty("jwt");
});

it("validates RPC inputs at the core boundary, including UTF-8 limits and caller-selected tenants", async () => {
	for (const options of [
		{ prefix: "é".repeat(129) },
		{ cursor: "a".repeat(2049) },
		{ tenantId: "another-tenant" },
		{ prefix: null },
		null,
		"invalid",
	]) {
		expect(
			await Reflect.apply(connectors.POOL_A.listDocuments, connectors.POOL_A, [
				options,
			]),
		).toMatchObject({ ok: false, error: { status: 400 } });
	}
	for (const id of ["", "é".repeat(129)])
		expect(await connectors.POOL_A.inspectDocument(id)).toMatchObject({
			ok: false,
			error: { status: 400 },
		});
	expect(
		await connectors.POOL_A.listDocuments({ prefix: "é".repeat(128) }),
	).toEqual({ ok: true, value: { documents: [], cursor: null } });
	expect(
		await connectors.POOL_A.inspectDocument("é".repeat(128)),
	).toMatchObject({ ok: false, error: { status: 404 } });
});

it("does not expose connector operations on the public document HTTP handler", async () => {
	const documents = await runtime.getWorker("pool-a");
	for (const path of ["/admin", "/connector", "/describe", "/listDocuments"]) {
		const response = await documents.fetch(`https://documents.example${path}`);
		expect(response.status).toBe(404);
		expect(await response.text()).not.toContain("a-only");
	}
});

it("preserves core storage errors and retry hints without blocking another connection", async () => {
	const sql = await runtime.unsafeGetDurableObjectStorage(
		"pool-a",
		"DocumentDO",
		{ name: JSON.stringify(["fluid", "shared"]) },
	);
	await sql.exec(
		"UPDATE state SET body=json_remove(body,'$.directoryRegistered')",
	);
	await sql.exec(
		"CREATE TRIGGER fail_index BEFORE INSERT ON state WHEN json_extract(NEW.body,'$.directoryRegistered')=1 BEGIN SELECT RAISE(FAIL,'injected connector checkpoint failure'); END",
	);
	await runtime.unsafeEvictDurableObject("pool-a", "DocumentDO", {
		name: JSON.stringify(["fluid", "shared"]),
	});
	try {
		expect(await connectors.POOL_A.inspectDocument("shared")).toEqual({
			ok: false,
			error: {
				status: 503,
				message: "Storage or runtime failure",
				retryAfter: "1",
			},
		});
		const admin = await runtime.getWorker("admin");
		const failed = await admin.fetch(
			"https://issuer.example/admin?tidepool=a&document=shared",
		);
		expect(failed.status).toBe(503);
		expect(failed.headers.get("Retry-After")).toBe("1");
		const markup = await failed.text();
		expect(markup).toContain('name="tidepool"');
		expect(markup).not.toContain("injected connector");
		const other = await admin.fetch(
			"https://issuer.example/admin?tidepool=b&document=shared",
		);
		expect(other.status).toBe(200);
	} finally {
		await sql.exec("DROP TRIGGER fail_index");
	}
});
