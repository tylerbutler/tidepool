import { afterAll, beforeAll, expect, it } from "vitest";
import { integer, record } from "../src/common.js";
import {
	api,
	connect,
	createDocument,
	deltas,
	startRuntime,
} from "./runtime.js";

let environment: Awaited<ReturnType<typeof startRuntime>>;
beforeAll(async () => {
	environment = await startRuntime();
});
afterAll(async () => environment?.runtime.dispose());

it("gives concurrent writer batches one contiguous durable order", async () => {
	const document = "concurrent-writers";
	await createDocument(environment.base, document);
	const first = await connect(environment.base, document);
	const second = await connect(environment.base, document);
	try {
		for (const [index, peer] of [first, second].entries()) {
			peer.connection.submit(
				Array.from({ length: 20 }, (_, i) => ({
					clientSequenceNumber: i + 1,
					referenceSequenceNumber: 0,
					type: "op",
					contents: `${index}:${i}`,
				})),
			);
		}
		await expect
			.poll(async () => (await deltas(environment.base, document)).length)
			.toBe(42);
		const ops = await deltas(environment.base, document);
		expect(ops.map((op) => op.sequenceNumber)).toEqual(
			ops.map((_, i) => i + 1),
		);
		expect(
			new Set(ops.filter((op) => op.type === "op").map((op) => op.contents))
				.size,
		).toBe(40);
		for (const peer of [first, second]) {
			expect(
				ops
					.filter((op) => op.clientId === peer.connection.clientId)
					.map((op) => op.clientSequenceNumber),
			).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
		}
	} finally {
		first.connection.dispose();
		first.service.dispose();
		second.connection.dispose();
		second.service.dispose();
	}
});

it("orders operations once, isolates documents, and preserves membership through real hibernation", async () => {
	const { base, runtime } = environment;
	const document = "collaboration";
	await createDocument(base, document);
	await createDocument(base, "isolated");
	const first = await connect(base, document);
	const second = await connect(base, document);
	try {
		const op = {
			clientSequenceNumber: 1,
			referenceSequenceNumber: 0,
			type: "op",
			contents: "edit",
		};
		first.connection.submit([op]);
		await expect
			.poll(
				async () =>
					(await deltas(base, document)).filter((o) => o.type === "op").length,
			)
			.toBe(1);
		const before = await deltas(base, document);
		await runtime.unsafeEvictDurableObject("tidepool-tests", "DocumentDO", {
			name: JSON.stringify(["fluid", document]),
			webSockets: "hibernate",
		});
		first.connection.submit([
			{ ...op, clientSequenceNumber: 2, contents: "after-hibernation" },
		]);
		await expect
			.poll(
				async () =>
					(await deltas(base, document)).filter((o) => o.type === "op").length,
			)
			.toBe(2);
		const after = await deltas(base, document);
		expect(after.filter((o) => o.type === "join")).toHaveLength(2);
		expect(after.filter((o) => o.type === "leave")).toHaveLength(0);
		expect(after.at(-1)?.sequenceNumber).toBe(
			Number(before.at(-1)?.sequenceNumber) + 1,
		);
		first.connection.submit([
			{ ...op, clientSequenceNumber: 2, contents: "after-hibernation" },
		]);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(
			(await deltas(base, document)).filter((o) => o.type === "op"),
		).toHaveLength(2);
		expect(await deltas(base, "isolated")).toEqual([]);
	} finally {
		first.connection.dispose();
		first.service.dispose();
		second.connection.dispose();
		second.service.dispose();
	}
});

it("retains accepted operations across object reset and reconnect", async () => {
	const { base, runtime } = environment;
	const document = "reset";
	await createDocument(base, document);
	const first = await connect(base, document);
	first.connection.on("error", () => {});
	first.connection.submit([
		{
			clientSequenceNumber: 1,
			referenceSequenceNumber: 0,
			type: "op",
			contents: "durable",
		},
	]);
	await expect
		.poll(async () =>
			(await deltas(base, document)).some((o) => o.contents === "durable"),
		)
		.toBe(true);
	await runtime.unsafeEvictDurableObject("tidepool-tests", "DocumentDO", {
		name: JSON.stringify(["fluid", document]),
		webSockets: "close",
	});
	first.connection.dispose();
	first.service.dispose();
	const next = await connect(base, document);
	try {
		next.connection.submit([
			{
				clientSequenceNumber: 1,
				referenceSequenceNumber: 0,
				type: "op",
				contents: "reconnected",
			},
		]);
		await expect
			.poll(async () =>
				(await deltas(base, document)).some(
					(o) => o.contents === "reconnected",
				),
			)
			.toBe(true);
		const ops = await deltas(base, document);
		expect(ops.filter((o) => o.contents === "durable")).toHaveLength(1);
		expect(ops.map((o) => o.sequenceNumber)).toEqual(ops.map((_, i) => i + 1));
		expect(ops.some((o) => o.type === "leave")).toBe(true);
	} finally {
		next.connection.dispose();
		next.service.dispose();
	}
});

it("uses the retry index after hibernation and rejects conflicting retries without advancing state", async () => {
	const { base, runtime } = environment;
	const document = "indexed-retries";
	await createDocument(base, document);
	const peers: Awaited<ReturnType<typeof connect>>[] = [];
	try {
		const first = await connect(base, document);
		peers.push(first);
		const second = await connect(base, document);
		peers.push(second);
		let accepted = 0;
		let historyReady = false;
		const nacks: unknown[] = [];
		first.connection.on("op", (_document, operations) => {
			for (const op of operations) {
				if (
					op.clientId === first.connection.clientId &&
					op.clientSequenceNumber === 1
				)
					accepted++;
				if (
					op.clientId === second.connection.clientId &&
					op.clientSequenceNumber === 2000
				)
					historyReady = true;
			}
		});
		first.connection.on("nack", (_document, messages) =>
			nacks.push(...messages),
		);
		const input = {
			clientSequenceNumber: 1,
			referenceSequenceNumber: 0,
			type: "op",
			contents: "retry-target",
		};
		first.connection.submit([input]);
		await expect.poll(() => accepted).toBe(1);
		for (let offset = 0; offset < 2000; offset += 100) {
			second.connection.submit(
				Array.from({ length: 100 }, (_, index) => ({
					clientSequenceNumber: offset + index + 1,
					referenceSequenceNumber: 0,
					type: "op",
					contents: `history:${offset + index + 1}`,
				})),
			);
		}
		await expect.poll(() => historyReady).toBe(true);
		await runtime.unsafeEvictDurableObject("tidepool-tests", "DocumentDO", {
			name: JSON.stringify(["fluid", document]),
			webSockets: "hibernate",
		});
		expect(
			(await api(base, document, `/documents/fluid/${document}`)).status,
		).toBe(200);
		const sql = await runtime.unsafeGetDurableObjectStorage(
			"tidepool-tests",
			"DocumentDO",
			{ name: JSON.stringify(["fluid", document]) },
		);
		const plan = await sql.exec<{ detail: string }>(
			"EXPLAIN QUERY PLAN SELECT body FROM ops WHERE json_extract(body,'$.clientId')=? AND json_extract(body,'$.clientSequenceNumber')=? ORDER BY sn DESC LIMIT 1",
			first.connection.clientId,
			1,
		);
		expect(
			plan.some((row) =>
				row.detail.includes("USING INDEX ops_client_sequence"),
			),
		).toBe(true);
		expect(plan.some((row) => /SCAN ops|TEMP B-TREE/.test(row.detail))).toBe(
			false,
		);
		const before = await sql.exec("SELECT body FROM state");
		const clientsBefore = await sql.exec("SELECT * FROM clients ORDER BY id");
		first.connection.submit([input]);
		await expect.poll(() => accepted).toBe(2);
		expect(await sql.exec("SELECT body FROM state")).toEqual(before);
		first.connection.submit([{ ...input, contents: "conflicting-retry" }]);
		await expect.poll(() => nacks.length).toBe(1);
		expect(record(nacks[0]).content).toMatchObject({ code: 400 });
		expect(await sql.exec("SELECT body FROM state")).toEqual(before);
		expect(await sql.exec("SELECT * FROM clients ORDER BY id")).toEqual(
			clientsBefore,
		);
	} finally {
		for (const peer of peers) {
			peer.connection.dispose();
			peer.service.dispose();
		}
	}
});

it("rejects unauthenticated, foreign-document and insufficient-scope REST requests", async () => {
	const { base } = environment;
	await createDocument(base, "auth");
	expect((await fetch(`${base}/deltas/fluid/auth`)).status).toBe(401);
	expect((await api(base, "foreign", "/deltas/fluid/auth")).status).toBe(401);
	expect(
		(
			await api(
				base,
				"auth",
				"/repos/fluid/git/blobs",
				{ content: "x", encoding: "utf-8" },
				["doc:read"],
			)
		).status,
	).toBe(401);
	expect(
		(await api(base, "auth", "/deltas/fluid/auth?from=invalid")).status,
	).toBe(400);
	expect((await fetch(`${base}/__test/reset`)).status).toBe(404);
});

it("rejects invalid CSNs and read-only submissions without advancing the durable sequence", async () => {
	const { base } = environment;
	await createDocument(base, "validation");
	const writer = await connect(base, "validation");
	const reader = await connect(base, "validation", "read", ["doc:read"]);
	try {
		const before = await deltas(base, "validation");
		const messages: unknown[] = [];
		writer.connection.on("nack", (_doc, nacks) => messages.push(...nacks));
		reader.connection.on("nack", (_doc, nacks) => messages.push(...nacks));
		writer.connection.submit([
			{
				clientSequenceNumber: 0,
				referenceSequenceNumber: 0,
				type: "op",
				contents: "bad",
			},
		]);
		reader.connection.submit([
			{
				clientSequenceNumber: 1,
				referenceSequenceNumber: 0,
				type: "op",
				contents: "read",
			},
		]);
		writer.connection.submit([
			{
				clientSequenceNumber: 1,
				referenceSequenceNumber: 0,
				type: "propose",
				contents: JSON.stringify({ value: "missing-key" }),
			},
		]);
		await expect.poll(() => messages.length).toBe(3);
		expect(await deltas(base, "validation")).toEqual(before);
		for (const message of messages)
			expect(record(message).content).not.toHaveProperty("retryAfter");
		writer.connection.submit([
			{
				clientSequenceNumber: 1,
				referenceSequenceNumber: 0,
				type: "op",
				contents: "valid-after-rejection",
			},
		]);
		await expect
			.poll(async () =>
				(await deltas(base, "validation")).find((op) => op.type === "op"),
			)
			.toMatchObject({
				clientSequenceNumber: 1,
				sequenceNumber: integer(before.at(-1)?.sequenceNumber) + 1,
			});
	} finally {
		writer.connection.dispose();
		writer.service.dispose();
		reader.connection.dispose();
		reader.service.dispose();
	}
});
