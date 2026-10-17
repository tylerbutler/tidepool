import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	bytes,
	MAX_DOCUMENT_BYTES,
	MAX_FRAME_BYTES,
	MAX_HTTP_BYTES,
	record,
	text,
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

async function openSocket(document: string) {
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
	return { socket, received };
}

async function rawSocket(
	document: string,
	options: {
		mode?: "read" | "write";
		client?: Record<string, unknown>;
		jwt?: string;
	} = {},
) {
	const { socket, received } = await openSocket(document);
	socket.send(
		`42${JSON.stringify([
			"connect_document",
			{
				tenantId: "fluid",
				id: document,
				token: options.jwt ?? (await token(document)),
				mode: options.mode ?? "write",
				client: {
					mode: "write",
					details: { capabilities: { interactive: true } },
					permission: [],
					scopes: [],
					user: { id: "raw" },
					...options.client,
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
	const parsed = protocol.frame(success);
	const details = record(parsed.args[0]);
	return { socket, received, id: text(details.clientId), details };
}

it("rejects unsupported persisted state without rewriting or deleting it", async () => {
	const document = "unsupported-state";
	await createDocument(environment.base, document);
	const sql = await inspect(document);
	await sql.exec(
		"UPDATE state SET body=json_remove(body,'$.initialHandle','$.initialSn')",
	);
	const previous = await sql.exec("SELECT body FROM state");
	const response = await api(
		environment.base,
		document,
		`/documents/fluid/${document}`,
	);
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({
		message: "Document state requires recreation",
	});
	expect(await sql.exec("SELECT body FROM state")).toEqual(previous);
});

it("uses verified identity, scopes, and mode for joins, signals, stored clients, and rosters", async () => {
	const document = "trusted-membership";
	await createDocument(environment.base, document);
	const writer = await rawSocket(document, {
		client: { user: { id: "impersonated" }, scopes: ["admin"], mode: "read" },
	});
	let reader: Awaited<ReturnType<typeof rawSocket>> | undefined;
	try {
		const expected = {
			user: { id: "tidepool-test-user", name: "Tidepool Test User" },
			scopes: ["doc:read", "doc:write", "summary:write"],
			mode: "write",
			details: { capabilities: { interactive: true } },
			permission: [],
		};
		const rows = await (await inspect(document)).exec<{ detail: string }>(
			"SELECT detail FROM clients WHERE id=?",
			writer.id,
		);
		expect(JSON.parse(text(rows[0]?.detail))).toEqual(expected);
		const join = (await deltas(environment.base, document)).find(
			(op) => op.type === "join",
		);
		expect(record(JSON.parse(text(join?.data))).detail).toEqual(expected);
		reader = await rawSocket(document, {
			mode: "read",
			jwt: await token(document, ["doc:read"]),
			client: {
				mode: "write",
				scopes: ["doc:write"],
				user: { id: "other-victim" },
			},
		});
		expect(reader.details.initialClients).toContainEqual({
			clientId: writer.id,
			client: expected,
		});
		const signals = reader.details.initialSignals;
		if (!Array.isArray(signals)) throw new Error("Missing initial signals");
		expect(record(signals[0]).clientId).toBe(null);
		expect(JSON.parse(text(record(signals[0]).content))).toEqual({
			type: "join",
			content: {
				clientId: reader.id,
				client: { ...expected, mode: "read", scopes: ["doc:read"] },
			},
		});
		const readerRows = await (await inspect(document)).exec<{ detail: string }>(
			"SELECT detail FROM clients WHERE id=?",
			reader.id,
		);
		expect(JSON.parse(text(readerRows[0]?.detail))).toEqual({
			...expected,
			mode: "read",
			scopes: ["doc:read"],
		});
	} finally {
		reader?.socket.close();
		writer.socket.close();
	}
});

it("enforces the metadata limit after replacing untrusted identity fields", async () => {
	const document = "canonical-metadata-limit";
	await createDocument(environment.base, document);
	const client = {
		mode: "write",
		user: { id: "x" },
		scopes: [],
		details: { padding: "" },
	};
	client.details.padding = "x".repeat(8191 - bytes(JSON.stringify(client)));
	expect(bytes(JSON.stringify(client))).toBe(8191);
	const { socket, received } = await openSocket(document);
	try {
		socket.send(
			`42${JSON.stringify([
				"connect_document",
				{
					tenantId: "fluid",
					id: document,
					token: await token(document),
					mode: "write",
					client,
				},
			])}`,
		);
		await expect
			.poll(() =>
				received.some(
					(frame) =>
						frame.startsWith('42["connect_document_error"') &&
						frame.includes('"code":413'),
				),
			)
			.toBe(true);
		expect(await deltas(environment.base, document)).toEqual([]);
		expect(
			await (await inspect(document)).exec("SELECT * FROM clients"),
		).toEqual([]);
	} finally {
		socket.close();
	}
});

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
		const nacks: unknown[] = [];
		peer.connection.on("nack", (_document, messages) => {
			nacks.push(...messages);
		});
		const input = {
			clientSequenceNumber: 1,
			referenceSequenceNumber: 0,
			type: "op",
			contents: "must-persist",
		};
		peer.connection.submit([input]);
		await expect.poll(() => nacks.length).toBe(1);
		expect(record(nacks[0]).content).toMatchObject({
			code: 503,
			retryAfter: 1,
		});
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
		const capacity = async () =>
			record(
				record(
					await (
						await api(
							environment.base,
							document,
							`/documents/fluid/${document}`,
						)
					).json(),
				).storage,
			);
		expect(await capacity()).toMatchObject({
			usedBytes: cap,
			remainingWriteBytes: 0,
		});
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
		const beforeCapacity = await capacity();
		peer.socket.send(`42${JSON.stringify(["submitOp", peer.id, [[next]]])}`);
		await expect
			.poll(() => peer.received.some((v) => v.includes('"code":507')))
			.toBe(true);
		const afterRejected = await storage.exec<{ used: number; sn: number }>(
			"SELECT json_extract(body,'$.used') AS used,json_extract(body,'$.sn') AS sn FROM state",
		);
		expect(afterRejected[0]).toEqual({ used: beforeRejected, sn: 2 });
		expect(await capacity()).toEqual(beforeCapacity);
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
		const afterCleanup = await capacity();
		expect(afterCleanup.usedBytes).toBeGreaterThan(cap);
		expect(afterCleanup.remainingWriteBytes).toBe(0);
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
