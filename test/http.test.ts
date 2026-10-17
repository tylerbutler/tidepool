import { SignJWT } from "jose";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MAX_CLIENTS, MAX_DOCUMENT_BYTES } from "../src/common.js";
import { CLEANUP_RESERVE } from "../src/storage.js";
import {
	api,
	connect,
	createDocument,
	createTestClient,
	secret,
	service,
	startRuntime,
} from "./runtime.js";

let environment: Awaited<ReturnType<typeof startRuntime>>;
beforeAll(async () => {
	environment = await startRuntime();
});
afterAll(async () => environment?.runtime.dispose());

it("distinguishes document and discovery routes for reserved words and encoded identifiers", async () => {
	const { base } = environment;
	for (const document of ["session", "deltas", "session/sub document"]) {
		await createDocument(base, document);
		const id = encodeURIComponent(document);
		const metadata = await api(base, document, `/documents/fluid/${id}`);
		expect(metadata.status).toBe(200);
		expect(await metadata.json()).toMatchObject({ id: document });
		const discovery = await api(
			base,
			document,
			`/documents/fluid/session/${id}`,
		);
		expect(discovery.status).toBe(200);
		expect(await discovery.json()).toMatchObject({
			ordererUrl: base,
			deltaStreamUrl: base,
		});
		for (const path of [
			`/deltas/fluid/${id}`,
			`/documents/fluid/${id}/deltas`,
		]) {
			const response = await api(base, document, path);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual([]);
		}
	}
	expect(
		(await api(base, "foreign", "/documents/fluid/session/deltas")).status,
	).toBe(401);
	for (const path of [
		"/deltas/fluid/session/extra",
		"/documents/fluid/session/extra/segment",
		"/documents/fluid/session/deltas/extra",
	]) {
		expect((await api(base, "session", path)).status).toBe(404);
	}
});

it("returns authorization errors with CORS only for an allowed origin", async () => {
	const { base } = environment;
	const rejected = await fetch(`${base}/deltas/fluid/auth`, {
		headers: { Origin: base },
	});
	expect(rejected.status).toBe(401);
	expect(rejected.headers.get("Access-Control-Allow-Origin")).toBe(base);
	expect(await rejected.json()).not.toHaveProperty("retryAfter");
	expect(rejected.headers.has("Retry-After")).toBe(false);
	const blocked = await fetch(`${base}/health`, {
		headers: { Origin: "https://untrusted.example" },
	});
	expect(blocked.status).toBe(403);
	expect(blocked.headers.has("Access-Control-Allow-Origin")).toBe(false);
	const preflight = await fetch(`${base}/deltas/fluid/auth`, {
		method: "OPTIONS",
		headers: { Origin: base },
	});
	expect(preflight.status).toBe(204);
	expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain(
		"Authorization",
	);
});

it("reports authenticated logical capacity as operations and content consume the budget", async () => {
	const { base, runtime } = environment;
	const document = "capacity";
	const path = `/documents/fluid/${document}`;
	await createDocument(base, document);
	const metadata = () => api(base, document, path, undefined, ["doc:read"]);
	expect(await (await metadata()).json()).toEqual({
		id: document,
		tenantId: "fluid",
		sequenceNumber: 0,
		storage: {
			usedBytes: 0,
			budgetBytes: MAX_DOCUMENT_BYTES,
			cleanupReserveBytes: CLEANUP_RESERVE,
			remainingWriteBytes: MAX_DOCUMENT_BYTES - CLEANUP_RESERVE,
		},
	});
	expect((await fetch(`${base}${path}`)).status).toBe(401);
	expect((await api(base, "foreign", path)).status).toBe(401);
	const peer = await connect(base, document);
	try {
		peer.connection.submit([
			{
				clientSequenceNumber: 1,
				referenceSequenceNumber: 0,
				type: "op",
				contents: "capacity-edit",
			},
		]);
		const sql = await runtime.unsafeGetDurableObjectStorage(
			"tidepool-tests",
			"DocumentDO",
			{ name: JSON.stringify(["fluid", document]) },
		);
		await expect
			.poll(
				async () =>
					(
						await sql.exec<{ sn: number }>(
							"SELECT json_extract(body,'$.sn') AS sn FROM state",
						)
					)[0]?.sn,
			)
			.toBe(2);
		const before = (await (await metadata()).json()) as {
			storage: { usedBytes: number };
		};
		const upload = await api(base, document, "/repos/fluid/git/blobs", {
			content: "capacity-content",
			encoding: "utf-8",
		});
		expect(upload.status).toBe(201);
		const rows = await sql.exec<{ used: number; sn: number }>(
			"SELECT json_extract(body,'$.used') AS used,json_extract(body,'$.sn') AS sn FROM state",
		);
		const state = rows[0];
		if (!state) throw new Error("Missing document state");
		expect(state.used).toBeGreaterThan(before.storage.usedBytes);
		expect(await (await metadata()).json()).toMatchObject({
			sequenceNumber: state.sn,
			storage: {
				usedBytes: state.used,
				remainingWriteBytes: MAX_DOCUMENT_BYTES - CLEANUP_RESERVE - state.used,
			},
		});
	} finally {
		peer.connection.dispose();
		peer.service.dispose();
	}
});

it("makes temporary admission and REST storage failures retryable in the official driver", async () => {
	const document = "retryable-storage";
	const { base, runtime } = environment;
	await createDocument(base, document);
	const sql = await runtime.unsafeGetDurableObjectStorage(
		"tidepool-tests",
		"DocumentDO",
		{ name: JSON.stringify(["fluid", document]) },
	);
	const docService = await service(base, document);
	try {
		await sql.exec(
			"CREATE TRIGGER fail_admission BEFORE INSERT ON clients BEGIN SELECT RAISE(FAIL,'temporary admission failure'); END",
		);
		await expect(
			docService.connectToDeltaStream(createTestClient("client")),
		).rejects.toMatchObject({
			statusCode: 503,
			canRetry: true,
			retryAfterSeconds: 1,
		});
		await sql.exec("DROP TRIGGER fail_admission");
		const connection = await docService.connectToDeltaStream(
			createTestClient("client"),
		);
		connection.dispose();
		await expect
			.poll(async () => (await sql.exec("SELECT id FROM clients")).length)
			.toBe(0);
		await sql.exec(
			"CREATE TRIGGER fail_upload BEFORE INSERT ON state WHEN json_extract(NEW.body,'$.used')>0 BEGIN SELECT RAISE(FAIL,'temporary upload failure'); END",
		);
		const body = { content: "retryable-blob", encoding: "utf-8" };
		const rejected = await api(base, document, "/repos/fluid/git/blobs", body);
		expect(rejected.status).toBe(503);
		expect(rejected.headers.get("Retry-After")).toBe("1");
		expect(await rejected.json()).toMatchObject({ retryAfter: 1000 });
		const storage = await docService.connectToStorage();
		const content = new TextEncoder().encode(body.content).buffer;
		await expect(storage.createBlob(content)).rejects.toMatchObject({
			statusCode: 503,
			canRetry: true,
			retryAfterSeconds: 1,
		});
		await sql.exec("DROP TRIGGER fail_upload");
		expect(await storage.createBlob(content)).toHaveProperty("id");
	} finally {
		docService.dispose();
	}
});

it("rejects signed tokens with invalid user claims as unauthorized", async () => {
	await createDocument(environment.base, "invalid-user");
	const jwt = await new SignJWT({
		tenantId: "fluid",
		documentId: "invalid-user",
		scopes: ["doc:read"],
		user: null,
	})
		.setProtectedHeader({ alg: "HS256" })
		.setIssuedAt()
		.setExpirationTime("1h")
		.sign(new TextEncoder().encode(secret));
	const response = await fetch(
		`${environment.base}/deltas/fluid/invalid-user`,
		{ headers: { Authorization: `Bearer ${jwt}` } },
	);
	expect(response.status).toBe(401);
});

it("bounds unauthenticated sockets per document", async () => {
	const sockets = [];
	try {
		const url = `${environment.base}/socket.io/?EIO=4&transport=websocket&tenantId=fluid&documentId=preauth-cap`;
		for (let i = 0; i < MAX_CLIENTS; i++) {
			const response = await environment.runtime.dispatchFetch(url, {
				headers: { Upgrade: "websocket" },
			});
			expect(response.status).toBe(101);
			if (!response.webSocket) throw new Error("Missing WebSocket");
			response.webSocket.accept();
			sockets.push(response.webSocket);
		}
		const overflow = await environment.runtime.dispatchFetch(url, {
			headers: { Upgrade: "websocket" },
		});
		expect(overflow.status).toBe(429);
	} finally {
		for (const socket of sockets) socket.close();
	}
});
