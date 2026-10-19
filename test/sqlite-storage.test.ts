import { afterAll, beforeAll, expect, it } from "vitest";
import { bytes, MAX_DOCUMENT_BYTES, MAX_FRAME_BYTES } from "../src/common.js";
import type { ConnectorClient } from "../src/connector.js";
import { CLEANUP_RESERVE } from "../src/storage.js";
import { api, createDocument, startRuntime } from "./runtime.js";

let environment: Awaited<ReturnType<typeof startRuntime>>;
let connector: ConnectorClient;

beforeAll(async () => {
	environment = await startRuntime(undefined, true, false);
	({ TIDEPOOL: connector } = await environment.runtime.getBindings<{
		TIDEPOOL: ConnectorClient;
	}>());
});

afterAll(async () => environment?.runtime.dispose());

function inspect(document: string) {
	return environment.runtime.unsafeGetDurableObjectStorage(
		"tidepool-tests",
		"DocumentDO",
		{ name: JSON.stringify(["fluid", document]) },
	);
}

function directoryStorage() {
	return environment.runtime.unsafeGetDurableObjectStorage(
		"tidepool-tests",
		"DocumentDO",
		{ name: JSON.stringify(["directory", "v1", "fluid"]) },
	);
}

async function upload(document: string, content: string, encoding = "utf-8") {
	return api(environment.base, document, "/repos/fluid/git/blobs", {
		content,
		encoding,
	});
}

it("stores large UTF-8 blobs across bounded SQLite rows, reuses immutable content, and survives eviction", async () => {
	const document = "sqlite-large-content";
	await createDocument(environment.base, document);
	const content = `x${"\u{1f30a}".repeat(600_000)}`;
	const response = await upload(document, content);
	expect(response.status).toBe(201);
	const { sha } = await response.json<{ sha: string }>();
	const sql = await inspect(document);
	const rows = await sql.exec<{ size: number }>(
		"SELECT length(body) AS size FROM content_objects ORDER BY part",
	);
	expect(rows).toHaveLength(3);
	expect(rows.every(({ size }) => size <= MAX_FRAME_BYTES)).toBe(true);
	const before = await sql.exec("SELECT body FROM state");
	const retry = await upload(
		document,
		Buffer.from(content).toString("base64"),
		"base64",
	);
	expect(retry.status).toBe(201);
	expect(await retry.json()).toMatchObject({ sha });
	expect(await sql.exec("SELECT body FROM state")).toEqual(before);
	await environment.runtime.unsafeEvictDurableObject(
		"tidepool-tests",
		"DocumentDO",
		{ name: JSON.stringify(["fluid", document]) },
	);
	const read = await api(
		environment.base,
		document,
		`/repos/fluid/git/blobs/${sha}`,
	);
	expect(read.status).toBe(200);
	expect(await read.json()).toMatchObject({
		sha,
		content,
		encoding: "utf-8",
		size: bytes(content),
	});
	await createDocument(environment.base, "sqlite-other-document");
	expect(
		(
			await api(
				environment.base,
				"sqlite-other-document",
				`/repos/fluid/git/blobs/${sha}`,
			)
		).status,
	).toBe(404);
});

it("rolls back every chunk on a write failure and retries without charging the reservation twice", async () => {
	const document = "sqlite-content-failure";
	await createDocument(environment.base, document);
	const sql = await inspect(document);
	await sql.exec(
		"CREATE TRIGGER fail_chunk BEFORE INSERT ON content_objects WHEN NEW.part=1 BEGIN SELECT RAISE(FAIL,'injected chunk failure'); END",
	);
	const content = "x".repeat(MAX_FRAME_BYTES + 100);
	try {
		const failed = await upload(document, content);
		expect(failed.status).toBe(503);
		expect(failed.headers.get("Retry-After")).toBe("1");
		expect(await sql.exec("SELECT * FROM content_objects")).toEqual([]);
		expect(await sql.exec("SELECT * FROM commits")).toEqual([]);
		expect(await sql.exec("SELECT * FROM refs")).toEqual([]);
		expect(await sql.exec("SELECT * FROM content")).toHaveLength(1);
	} finally {
		await sql.exec("DROP TRIGGER fail_chunk");
	}
	const reserved = await sql.exec("SELECT body FROM state");
	expect((await upload(document, content)).status).toBe(201);
	expect(await sql.exec("SELECT body FROM state")).toEqual(reserved);
	expect(await sql.exec("SELECT * FROM content_objects")).toHaveLength(2);
});

it("enforces the same document budget before writing content and permits free immutable retries at the limit", async () => {
	const document = "sqlite-content-budget";
	await createDocument(environment.base, document);
	const sql = await inspect(document);
	const body = { content: "fits", encoding: "utf-8" };
	await sql.exec(
		"UPDATE state SET body=json_set(body,'$.used',?)",
		MAX_DOCUMENT_BYTES - CLEANUP_RESERVE - bytes(JSON.stringify(body)),
	);
	expect((await upload(document, body.content)).status).toBe(201);
	const full = await sql.exec("SELECT body FROM state");
	expect((await upload(document, body.content)).status).toBe(201);
	expect((await upload(document, "does not fit")).status).toBe(507);
	expect(await sql.exec("SELECT body FROM state")).toEqual(full);
	expect(await sql.exec("SELECT * FROM content")).toHaveLength(1);
	expect(await sql.exec("SELECT * FROM content_objects")).toHaveLength(1);
});

it("lists and pages SQLite directory entries with literal UTF-8 prefixes after eviction", async () => {
	const prefix = "paged-%_é/";
	for (let index = 0; index < 51; index++)
		await createDocument(
			environment.base,
			`${prefix}${String(index).padStart(2, "0")}`,
		);
	await environment.runtime.unsafeEvictDurableObject(
		"tidepool-tests",
		"DocumentDO",
		{ name: JSON.stringify(["directory", "v1", "fluid"]) },
	);
	const first = await connector.listDocuments({ prefix });
	if (!first.ok) throw new Error(first.error.message);
	expect(first.value.documents.map(({ id }) => id)).toEqual(
		Array.from(
			{ length: 50 },
			(_, index) => `${prefix}${String(index).padStart(2, "0")}`,
		),
	);
	expect(first.value.documents[0]?.indexedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	if (!first.value.cursor) throw new Error("Missing next-page cursor");
	const last = await connector.listDocuments({
		prefix,
		cursor: first.value.cursor,
	});
	expect(last).toMatchObject({
		ok: true,
		value: { documents: [{ id: `${prefix}50` }], cursor: null },
	});
	expect(
		await connector.listDocuments({
			prefix: "other",
			cursor: first.value.cursor,
		}),
	).toMatchObject({ ok: false, error: { status: 400 } });
	expect(await connector.inspectDocument(`${prefix}00`)).toMatchObject({
		ok: true,
		value: { id: `${prefix}00`, sequenceNumber: 0 },
	});
	expect(await connector.inspectDocument("sqlite-missing")).toMatchObject({
		ok: false,
		error: { status: 404 },
	});
	expect(await connector.listDocuments({ prefix: "sqlite-missing" })).toEqual({
		ok: true,
		value: { documents: [], cursor: null },
	});
});

it("reports directory failures and retries registration after durable document creation", async () => {
	const sql = await directoryStorage();
	await sql.exec(
		"CREATE TRIGGER fail_directory BEFORE INSERT ON directory BEGIN SELECT RAISE(FAIL,'injected directory failure'); END",
	);
	const document = "sqlite-directory-failure";
	try {
		const failed = await api(environment.base, document, "/documents/fluid", {
			id: document,
		});
		expect(failed.status).toBe(503);
		const documentSql = await inspect(document);
		expect(
			await documentSql.exec<{ created: number; registered: number | null }>(
				"SELECT json_extract(body,'$.created') AS created,json_extract(body,'$.sqliteDirectoryRegistered') AS registered FROM state",
			),
		).toEqual([{ created: 1, registered: null }]);
	} finally {
		await sql.exec("DROP TRIGGER fail_directory");
	}
	expect(await connector.inspectDocument(document)).toMatchObject({
		ok: true,
		value: { id: document },
	});
	await sql.exec(
		"ALTER TABLE directory RENAME COLUMN indexedAt TO unavailable",
	);
	try {
		expect(await connector.listDocuments()).toEqual({
			ok: false,
			error: {
				status: 503,
				message: "Storage or runtime failure",
				retryAfter: "1",
			},
		});
	} finally {
		await sql.exec(
			"ALTER TABLE directory RENAME COLUMN unavailable TO indexedAt",
		);
	}
	expect(await connector.listDocuments({ prefix: document })).toMatchObject({
		ok: true,
		value: { documents: [{ id: document }], cursor: null },
	});
});
