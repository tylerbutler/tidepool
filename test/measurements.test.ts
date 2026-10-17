import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { connect, createDocument, startRuntime } from "./runtime.js";

function receipt() {
	let resolve!: (timestamp: number) => void;
	const promise = new Promise<number>((done, reject) => {
		const timer = setTimeout(
			() => reject(new Error("Operation delivery timed out")),
			10_000,
		);
		resolve = (timestamp) => {
			clearTimeout(timer);
			done(timestamp);
		};
	});
	return { promise, resolve };
}

it.each([
	2, 32,
])("measures fan-out and a hibernated wake with %i clients", async (clients) => {
	const { base, runtime } = await startRuntime();
	const peers: Awaited<ReturnType<typeof connect>>[] = [];
	try {
		await createDocument(base, "measurements");
		const received = Array.from({ length: clients }, () => new Set<string>());
		const pending = new Map<string, (timestamp: number) => void>();
		for (let index = 0; index < clients; index++) {
			const peer = await connect(base, "measurements");
			peers.push(peer);
			peer.connection.on("op", (_document, operations) => {
				for (const op of operations) {
					if (op.type !== "op" || typeof op.contents !== "string") continue;
					received[index]?.add(op.contents);
					if (index === 1) pending.get(op.contents)?.(performance.now());
				}
			});
		}
		const first = peers[0];
		if (!first) throw new Error("Missing writer");
		const samples: number[] = [];
		const sent = new Set<string>();
		for (let i = 0; i < 50; i++) {
			if (i === 25)
				await runtime.unsafeEvictDurableObject("tidepool-tests", "DocumentDO", {
					name: JSON.stringify(["fluid", "measurements"]),
					webSockets: "hibernate",
				});
			const contents = `${i}:`.padEnd(128, "x");
			sent.add(contents);
			expect(Buffer.byteLength(contents)).toBe(128);
			const delivered = receipt();
			pending.set(contents, delivered.resolve);
			const started = performance.now();
			first.connection.submit([
				{
					clientSequenceNumber: i + 1,
					referenceSequenceNumber: 0,
					type: "op",
					contents,
				},
			]);
			samples.push((await delivered.promise) - started);
			pending.delete(contents);
		}
		await expect
			.poll(() => received)
			.toEqual(Array.from({ length: clients }, () => sent));
		const wakeMs = samples[25];
		const sorted = [...samples].sort((a, b) => a - b);
		const storage = await runtime.unsafeGetDurableObjectStorage(
			"tidepool-tests",
			"DocumentDO",
			{
				name: JSON.stringify(["fluid", "measurements"]),
			},
		);
		const rows = await storage.exec<{
			logicalBytes: number;
			sequenceNumber: number;
		}>(
			"SELECT json_extract(body,'$.used') AS logicalBytes,json_extract(body,'$.sn') AS sequenceNumber FROM state",
		);
		expect(rows[0]?.sequenceNumber).toBe(50 + clients);
		expect(samples).toHaveLength(50);
		console.info(
			"Local workerd measurement",
			JSON.stringify({
				workload: "fan-out",
				clients,
				operations: 50,
				samples: samples.length,
				payloadBytes: 128,
				p50Ms: sorted[24],
				p95Ms: sorted[47],
				maxMs: sorted.at(-1),
				wakeMs,
				...rows[0],
			}),
		);
	} finally {
		for (const peer of peers) {
			peer.connection.dispose();
			peer.service.dispose();
		}
		await runtime.dispose();
	}
});

it("measures duplicate retries after 2,000 intervening operations", async () => {
	const { base, runtime } = await startRuntime();
	const peers: Awaited<ReturnType<typeof connect>>[] = [];
	try {
		const document = "retry-measurements";
		await createDocument(base, document);
		const first = await connect(base, document);
		peers.push(first);
		const second = await connect(base, document);
		peers.push(second);
		let pending = receipt();
		let expected = "retry-target".padEnd(128, "x");
		first.connection.on("op", (_document, operations) => {
			if (operations.some((op) => op.contents === expected))
				pending.resolve(performance.now());
		});
		const input = {
			clientSequenceNumber: 1,
			referenceSequenceNumber: 0,
			type: "op",
			contents: expected,
		};
		first.connection.submit([input]);
		await pending.promise;
		for (let offset = 0; offset < 2000; offset += 100) {
			pending = receipt();
			expected = `history:${offset + 100}`.padEnd(128, "x");
			second.connection.submit(
				Array.from({ length: 100 }, (_, index) => ({
					clientSequenceNumber: offset + index + 1,
					referenceSequenceNumber: 0,
					type: "op",
					contents: `history:${offset + index + 1}`.padEnd(128, "x"),
				})),
			);
			await pending.promise;
		}
		const storage = await runtime.unsafeGetDurableObjectStorage(
			"tidepool-tests",
			"DocumentDO",
			{ name: JSON.stringify(["fluid", document]) },
		);
		const checkpoint = () =>
			storage.exec<{
				logicalBytes: number;
				sequenceNumber: number;
			}>(
				"SELECT json_extract(body,'$.used') AS logicalBytes,json_extract(body,'$.sn') AS sequenceNumber FROM state",
			);
		const before = await checkpoint();
		expect(before[0]?.sequenceNumber).toBe(2003);
		const samples: number[] = [];
		expected = input.contents;
		for (let i = 0; i < 50; i++) {
			pending = receipt();
			const started = performance.now();
			first.connection.submit([input]);
			samples.push((await pending.promise) - started);
		}
		expect(await checkpoint()).toEqual(before);
		const sorted = [...samples].sort((a, b) => a - b);
		console.info(
			"Local workerd measurement",
			JSON.stringify({
				workload: "duplicate-retry",
				clients: 2,
				historyOperations: 2000,
				samples: samples.length,
				payloadBytes: 128,
				p50Ms: sorted[24],
				p95Ms: sorted[47],
				maxMs: sorted.at(-1),
				...before[0],
			}),
		);
	} finally {
		for (const peer of peers) {
			peer.connection.dispose();
			peer.service.dispose();
		}
		await runtime.dispose();
	}
});
