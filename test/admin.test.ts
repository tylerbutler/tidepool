import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { type AdminBindings, adminResponse } from "../src/admin.js";
import { directoryPrefix } from "../src/directory.js";
import { api, connect, createDocument, startRuntime } from "./runtime.js";

let environment: Awaited<ReturnType<typeof startRuntime>>;
let bindings: Required<AdminBindings>;

beforeAll(async () => {
	environment = await startRuntime();
	bindings = await environment.runtime.getBindings<Required<AdminBindings>>();
});

afterAll(async () => environment?.runtime.dispose());

function admin(query = "") {
	return adminResponse(new Request(`https://issuer.example/admin${query}`), {
		...bindings,
		TENANT_ID: "fluid",
	});
}

it("indexes persisted documents, bounds listing, filters prefixes, and escapes identifiers", async () => {
	const { base } = environment;
	for (const id of [
		"admin-alpha",
		"admin-beta",
		'<script>alert("x")</script>',
	]) {
		await createDocument(base, id);
	}
	const prefix = await directoryPrefix("fluid");
	const listed = await bindings.CONTENT.list({ prefix });
	expect(listed.objects).toHaveLength(3);
	const response = await admin();
	const markup = await response.text();
	expect(response.status).toBe(200);
	expect(markup).toContain("admin-alpha");
	expect(markup).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
	expect(markup).not.toContain('<script>alert("x")</script>');
	expect(markup).toContain("Select a document");
	expect(markup).toContain('<a href="#lookup">Open by ID</a>');
	expect(response.headers.get("Content-Security-Policy")).toContain(
		"frame-ancestors 'none'",
	);
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	const filtered = await (await admin("?prefix=admin-a")).text();
	expect(filtered).toContain("admin-alpha");
	expect(filtered).not.toContain("admin-beta");
	const empty = await (await admin("?prefix=not-present")).text();
	expect(empty).toContain("No matching documents");
	for (let i = 0; i < 51; i++) {
		await bindings.CONTENT.put(
			await directoryPrefix("fluid", `paged-${String(i).padStart(2, "0")}`),
			"{}",
		);
	}
	const first = await admin("?prefix=paged-");
	const firstPage = await first.text();
	expect(firstPage.match(/class="row-link"/g)).toHaveLength(50);
	const next = /href="([^"]+)">Next page/.exec(firstPage)?.[1];
	expect(next).toBeDefined();
	const nextUrl = new URL(
		next?.replaceAll("&amp;", "&") ?? "",
		"https://issuer.example",
	);
	const lastPage = await (await admin(nextUrl.search)).text();
	expect(lastPage.match(/class="row-link"/g)).toHaveLength(1);
	expect(lastPage).not.toContain(">Next page</a>");
});

it("opens an exact legacy ID, shows live metadata without sequencing changes, and survives hibernation", async () => {
	const { runtime, base } = environment;
	const id = "legacy-admin";
	await createDocument(base, id);
	const sql = await runtime.unsafeGetDurableObjectStorage(
		"tidepool-tests",
		"DocumentDO",
		{
			name: JSON.stringify(["fluid", id]),
		},
	);
	await sql.exec(
		"UPDATE state SET body=json_remove(body,'$.directoryRegistered','$.createdAt')",
	);
	await bindings.CONTENT.delete(await directoryPrefix("fluid", id));
	const writer = await connect(base, id);
	const reader = await connect(base, id, "read");
	try {
		expect(
			await bindings.CONTENT.head(await directoryPrefix("fluid", id)),
		).not.toBeNull();
		await sql.exec(
			"UPDATE state SET body=json_remove(body,'$.directoryRegistered')",
		);
		await bindings.CONTENT.delete(await directoryPrefix("fluid", id));
		await runtime.unsafeEvictDurableObject("tidepool-tests", "DocumentDO", {
			name: JSON.stringify(["fluid", id]),
			webSockets: "hibernate",
		});
		const before = await sql.exec<{ body: string }>("SELECT body FROM state");
		const response = await admin(`?document=${encodeURIComponent(id)}`);
		expect(response.status).toBe(200);
		const markup = await response.text();
		expect(markup).toContain(id);
		expect(markup).toContain("Not recorded for this document");
		expect(markup).toContain("Current sequence");
		expect(markup).toContain("No summary stored");
		const stub = bindings.DOCUMENTS.get(
			bindings.DOCUMENTS.idFromName(JSON.stringify(["fluid", id])),
		);
		const info = await stub.inspect("fluid", id);
		expect(info).toMatchObject({
			id,
			createdAt: null,
			connections: { readers: 1, writers: 1, limit: 128 },
			storage: { budgetBytes: 67_108_864, cleanupReserveBytes: 1_048_576 },
		});
		const after = await sql.exec<{ body: string }>("SELECT body FROM state");
		expect(JSON.parse(after[0]?.body ?? "{}")).toEqual({
			...JSON.parse(before[0]?.body ?? "{}"),
			directoryRegistered: true,
		});
		expect(
			await bindings.CONTENT.head(await directoryPrefix("fluid", id)),
		).not.toBeNull();
		await expect(stub.inspect("other-tenant", id)).rejects.toThrow();
		await expect(stub.inspect("fluid", "other-document")).rejects.toThrow();
	} finally {
		writer.connection.dispose();
		writer.service.dispose();
		reader.connection.dispose();
		reader.service.dispose();
	}
});

it("does not create or index missing documents and reports lookup failures safely", async () => {
	const id = '<img src=x onerror="alert(1)">';
	const response = await admin(`?document=${encodeURIComponent(id)}`);
	expect(response.status).toBe(404);
	const markup = await response.text();
	expect(markup).toContain("Document not found");
	expect(markup).toContain('id="lookup"');
	expect(markup).toContain(
		'value="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"',
	);
	expect(markup).not.toContain(">Try again</a>");
	expect(markup).not.toContain("<img");
	expect(
		await bindings.CONTENT.head(await directoryPrefix("fluid", id)),
	).toBeNull();
	const metadata = await api(
		environment.base,
		id,
		`/documents/fluid/${encodeURIComponent(id)}`,
	);
	expect(metadata.status).toBe(404);
});

it("retries a failed directory checkpoint without publishing a false creation success", async () => {
	const { runtime, base } = environment;
	const id = "index-failure";
	const sql = await runtime.unsafeGetDurableObjectStorage(
		"tidepool-tests",
		"DocumentDO",
		{
			name: JSON.stringify(["fluid", id]),
		},
	);
	// Start schema initialization without creating a document.
	await api(base, id, `/documents/fluid/${id}`);
	await sql.exec(
		"CREATE TRIGGER fail_index BEFORE INSERT ON state WHEN json_extract(NEW.body,'$.directoryRegistered')=1 BEGIN SELECT RAISE(FAIL,'injected index checkpoint failure'); END",
	);
	const response = await api(base, id, "/documents/fluid", { id });
	expect(response.status).toBe(503);
	expect(response.headers.get("Retry-After")).toBe("1");
	await sql.exec("DROP TRIGGER fail_index");
	expect((await admin(`?document=${id}`)).status).toBe(200);
	const [state] = await sql.exec<{ registered: number; created: number }>(
		"SELECT json_extract(body,'$.directoryRegistered') AS registered,json_extract(body,'$.created') AS created FROM state",
	);
	expect(state).toEqual({ registered: 1, created: 1 });
});

it("rejects oversized queries and mutations, and reports directory outages instead of an empty list", async () => {
	expect(
		(await admin(`?prefix=${encodeURIComponent("é".repeat(129))}`)).status,
	).toBe(400);
	expect((await admin("?document=")).status).toBe(400);
	expect((await admin(`?cursor=${"a".repeat(2049)}`)).status).toBe(400);
	await expect(
		adminResponse(
			new Request("https://issuer.example/admin", { method: "POST" }),
			{ ...bindings, TENANT_ID: "fluid" },
		),
	).rejects.toMatchObject({ status: 405 });
	const spy = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const failed = await adminResponse(
			new Request("https://issuer.example/admin"),
			{
				TENANT_ID: "fluid",
				DOCUMENTS: bindings.DOCUMENTS,
				CONTENT: new Proxy(bindings.CONTENT, {
					get(target, key) {
						if (key === "list")
							return async () => {
								throw new Error("R2 unavailable");
							};
						return Reflect.get(target, key);
					},
				}),
			},
		);
		expect(failed.status).toBe(503);
		expect(failed.headers.get("Retry-After")).toBe("1");
		expect(await failed.text()).toContain("Could not load documents");
		expect(spy).toHaveBeenCalled();
	} finally {
		spy.mockRestore();
	}
});
