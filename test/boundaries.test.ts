import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	bytes,
	MAX_DOCUMENT_BYTES,
	MAX_FRAME_BYTES,
	MAX_HTTP_BYTES,
} from "../src/common.js";
import { protocol } from "../src/protocol.js";
import {
	api,
	connect,
	createDocument,
	deltas,
	startRuntime,
	token,
} from "./runtime.js";

let environment: Awaited<ReturnType<typeof startRuntime>>;
beforeAll(async () => {
	environment = await startRuntime();
});
afterAll(async () => environment?.runtime.dispose());

async function inspect(document: string) {
	return environment.runtime.unsafeGetDurableObjectStorage(
		"tidepool-tests",
		"DocumentDO",
		{
			name: JSON.stringify(["fluid", document]),
		},
	);
}

async function rawSocket(document: string) {
	const response = await environment.runtime.dispatchFetch(
		`${environment.base}/socket.io/?EIO=4&transport=websocket&tenantId=fluid&documentId=${document}`,
		{ headers: { Upgrade: "websocket" } },
	);
	if (!response.webSocket) throw new Error(`Upgrade failed ${response.status}`);
	const socket = response.webSocket;
	const received: string[] = [];
	socket.addEventListener("message", (event) =>
		received.push(String(event.data)),
	);
	socket.accept();
	socket.send("40");
	socket.send(
		`42${JSON.stringify([
			"connect_document",
			{
				tenantId: "fluid",
				id: document,
				token: await token(document),
				mode: "write",
				client: {
					mode: "write",
					details: { capabilities: { interactive: true } },
					permission: [],
					scopes: [],
					user: { id: "raw" },
				},
			},
		])}`,
	);
	await expect
		.poll(() =>
			received.some((v) => v.startsWith('42["connect_document_success"')),
		)
		.toBe(true);
	const success = received.find((v) =>
		v.startsWith('42["connect_document_success"'),
	);
	if (!success) throw new Error("Missing connect response");
	const parsed = JSON.parse(success.slice(2)) as [string, { clientId: string }];
	return { socket, received, id: parsed[1].clientId };
}

it("accepts exactly the stored message limit and rejects one byte more without an extra op", async () => {
	const document = "message-boundary";
	await createDocument(environment.base, document);
	const peer = await rawSocket(document);
	try {
		const input = {
			clientSequenceNumber: 1,
			referenceSequenceNumber: 0,
			type: "op",
			contents: "",
		};
		const checkpoint = {
			sn: 1,
			msn: 0,
			clients: [{ id: peer.id, csn: 0, rsn: 0 }],
		};
		const template = protocol.assign(checkpoint, peer.id, "write", input, 0);
		input.contents = "x".repeat(
			MAX_FRAME_BYTES - bytes(JSON.stringify(template)),
		);
		peer.socket.send(`42${JSON.stringify(["submitOp", peer.id, [[input]]])}`);
		await expect
			.poll(async () =>
				(await deltas(environment.base, document)).some((o) => o.type === "op"),
			)
			.toBe(true);
		const storage = await inspect(document);
		const rows = await storage.exec<{ size: number }>(
			"SELECT length(CAST(body AS BLOB)) AS size FROM ops WHERE sn=2",
		);
		expect(rows[0]?.size).toBe(MAX_FRAME_BYTES);
		peer.socket.send(
			`42${JSON.stringify(["submitOp", peer.id, [[{ ...input, clientSequenceNumber: 2, contents: `${input.contents}x` }]]])}`,
		);
		await expect
			.poll(() =>
				peer.received.some(
					(v) => v.startsWith('42["nack"') && v.includes('"code":413'),
				),
			)
			.toBe(true);
		const count = await storage.exec<{ count: number }>(
			"SELECT count(*) AS count FROM ops WHERE json_extract(body,'$.type')='op'",
		);
		expect(count[0]?.count).toBe(1);
	} finally {
		peer.socket.close();
	}
});

it("enforces the frame ceiling before parsing", async () => {
	const document = "frame-boundary";
	await createDocument(environment.base, document);
	const peer = await rawSocket(document);
	let code: number | undefined;
	peer.socket.addEventListener("close", (event) => {
		code = event.code;
	});
	peer.socket.send("x".repeat(MAX_FRAME_BYTES + 1));
	await expect.poll(() => code).toBe(1009);
});

it("enforces the streaming upload cap without trusting Content-Length", async () => {
	await createDocument(environment.base, "upload-boundary");
	const response = await fetch(`${environment.base}/repos/fluid/git/blobs`, {
		method: "POST",
		headers: { Authorization: `Bearer ${await token("upload-boundary")}` },
		body: `"${"x".repeat(MAX_HTTP_BYTES)}"`,
	});
	expect(response.status).toBe(413);
});

it("rolls back sequence and client state when SQLite rejects an operation", async () => {
	const document = "write-failure";
	await createDocument(environment.base, document);
	const peer = await connect(environment.base, document);
	try {
		const storage = await inspect(document);
		await storage.exec(
			"CREATE TRIGGER fail_write BEFORE INSERT ON ops WHEN json_extract(NEW.body,'$.type')='op' BEGIN SELECT RAISE(FAIL, 'injected storage failure'); END",
		);
		let nacks = 0;
		peer.connection.on("nack", () => {
			nacks++;
		});
		const input = {
			clientSequenceNumber: 1,
			referenceSequenceNumber: 0,
			type: "op",
			contents: "must-persist",
		};
		peer.connection.submit([input]);
		await expect.poll(() => nacks).toBe(1);
		expect(
			(await deltas(environment.base, document)).filter((o) => o.type === "op"),
		).toEqual([]);
		const rows = await storage.exec<{ csn: number }>(
			"SELECT csn FROM clients WHERE id=?",
			peer.connection.clientId,
		);
		expect(rows[0]?.csn).toBe(0);
		await storage.exec("DROP TRIGGER fail_write");
		peer.connection.submit([input]);
		await expect
			.poll(async () =>
				(await deltas(environment.base, document)).some(
					(o) => o.contents === "must-persist",
				),
			)
			.toBe(true);
	} finally {
		peer.connection.dispose();
		peer.service.dispose();
	}
});

it("accepts the exact document budget and rejects one byte more, retaining cleanup room", async () => {
	const document = "budget";
	await createDocument(environment.base, document);
	const peer = await rawSocket(document);
	try {
		const storage = await inspect(document);
		const input = {
			clientSequenceNumber: 1,
			referenceSequenceNumber: 0,
			type: "op",
			contents: "budget",
		};
		const op = protocol.assign(
			{ sn: 1, msn: 0, clients: [{ id: peer.id, csn: 0, rsn: 0 }] },
			peer.id,
			"write",
			input,
			0,
		);
		const size = bytes(JSON.stringify(op));
		const cap = MAX_DOCUMENT_BYTES - MAX_FRAME_BYTES;
		await storage.exec(
			"UPDATE state SET body=json_set(body,'$.used',?) WHERE id=1",
			cap - size,
		);
		peer.socket.send(`42${JSON.stringify(["submitOp", peer.id, [[input]]])}`);
		await expect
			.poll(async () =>
				(await deltas(environment.base, document)).some((o) => o.type === "op"),
			)
			.toBe(true);
		const rows = await storage.exec<{ used: number }>(
			"SELECT json_extract(body,'$.used') AS used FROM state",
		);
		expect(rows[0]?.used).toBe(cap);
		const next = { ...input, clientSequenceNumber: 2 };
		const nextOp = protocol.assign(
			{ sn: 2, msn: 0, clients: [{ id: peer.id, csn: 1, rsn: 0 }] },
			peer.id,
			"write",
			next,
			0,
		);
		const beforeRejected = cap - bytes(JSON.stringify(nextOp)) + 1;
		await storage.exec(
			"UPDATE state SET body=json_set(body,'$.used',?) WHERE id=1",
			beforeRejected,
		);
		peer.socket.send(`42${JSON.stringify(["submitOp", peer.id, [[next]]])}`);
		await expect
			.poll(() => peer.received.some((v) => v.includes('"code":507')))
			.toBe(true);
		const afterRejected = await storage.exec<{ used: number; sn: number }>(
			"SELECT json_extract(body,'$.used') AS used,json_extract(body,'$.sn') AS sn FROM state",
		);
		expect(afterRejected[0]).toEqual({ used: beforeRejected, sn: 2 });
		await storage.exec(
			"UPDATE state SET body=json_set(body,'$.used',?) WHERE id=1",
			cap,
		);
		peer.socket.close();
		await expect
			.poll(
				async () =>
					(await deltas(environment.base, document)).filter(
						(o) => o.type === "leave",
					).length,
			)
			.toBe(1);
	} finally {
		if (peer.socket.readyState === 1) peer.socket.close();
	}
});

it("rolls back a content reservation if its state checkpoint cannot be saved", async () => {
	const document = "reservation-failure";
	await createDocument(environment.base, document);
	const storage = await inspect(document);
	await storage.exec(
		"CREATE TRIGGER fail_reservation BEFORE INSERT ON state WHEN json_extract(NEW.body,'$.used')>0 BEGIN SELECT RAISE(FAIL,'injected checkpoint failure'); END",
	);
	const body = { content: "reservation-rollback", encoding: "utf-8" };
	expect(
		(await api(environment.base, document, "/repos/fluid/git/blobs", body))
			.status,
	).toBe(503);
	expect(await storage.exec("SELECT * FROM content")).toEqual([]);
	const rows = await storage.exec<{ used: number }>(
		"SELECT json_extract(body,'$.used') AS used FROM state",
	);
	expect(rows[0]?.used).toBe(0);
	await storage.exec("DROP TRIGGER fail_reservation");
	expect(
		(await api(environment.base, document, "/repos/fluid/git/blobs", body))
			.status,
	).toBe(201);
	expect(await storage.exec("SELECT * FROM content")).toHaveLength(1);
});

it("preserves batch metadata, compression and traces in the durable wire message", async () => {
	const document = "wire-metadata";
	await createDocument(environment.base, document);
	const peer = await rawSocket(document);
	try {
		const input = {
			clientSequenceNumber: 1,
			referenceSequenceNumber: 0,
			type: "op",
			contents: "opaque-compressed-bytes",
			metadata: { batch: true },
			compression: "lz4",
			traces: [{ action: "start", timestamp: 1 }],
		};
		peer.socket.send(`42${JSON.stringify(["submitOp", peer.id, [[input]]])}`);
		await expect
			.poll(async () =>
				(await deltas(environment.base, document)).some((o) => o.type === "op"),
			)
			.toBe(true);
		const stored = (await deltas(environment.base, document)).find(
			(o) => o.type === "op",
		);
		expect(stored).toMatchObject(input);
	} finally {
		peer.socket.close();
	}
});

it("preserves document data through a full local runtime restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "tidepool-"));
	let current: Awaited<ReturnType<typeof startRuntime>> | undefined;
	try {
		current = await startRuntime(directory);
		await createDocument(current.base, "restart");
		const peer = await connect(current.base, "restart");
		peer.connection.submit([
			{
				clientSequenceNumber: 1,
				referenceSequenceNumber: 0,
				type: "op",
				contents: "on-disk",
			},
		]);
		const base = current.base;
		await expect
			.poll(async () =>
				(await deltas(base, "restart")).some((o) => o.contents === "on-disk"),
			)
			.toBe(true);
		peer.connection.dispose();
		peer.service.dispose();
		await current.runtime.dispose();
		current = undefined;
		current = await startRuntime(directory);
		expect(
			(await deltas(current.base, "restart")).some(
				(o) => o.contents === "on-disk",
			),
		).toBe(true);
	} finally {
		await current?.runtime.dispose();
		await rm(directory, { recursive: true, force: true });
	}
});

it("sends Engine.IO pings and sequences a leave when a peer misses its pong deadline", async () => {
	const document = "heartbeat";
	await createDocument(environment.base, document);
	const peer = await rawSocket(document);
	let closed = false;
	peer.socket.addEventListener("close", () => {
		closed = true;
	});
	try {
		await expect
			.poll(() => peer.received.includes("2"), { timeout: 15_000 })
			.toBe(true);
		await expect.poll(() => closed, { timeout: 25_000 }).toBe(true);
		const operations = await deltas(environment.base, document);
		expect(operations.filter((o) => o.type === "leave")).toHaveLength(1);
		const rows = await (await inspect(document)).exec<{ count: number }>(
			"SELECT count(*) AS count FROM clients",
		);
		expect(rows[0]?.count).toBe(0);
	} finally {
		peer.socket.close();
	}
}, 45_000);
