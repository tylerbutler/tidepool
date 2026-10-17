import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { connect, createDocument, startRuntime } from "./runtime.js";

it("measures a bounded two-writer workload and a hibernated wake", async () => {
	const { base, runtime } = await startRuntime();
	try {
		await createDocument(base, "measurements");
		const first = await connect(base, "measurements");
		const second = await connect(base, "measurements");
		try {
			const samples: number[] = [];
			const observed = new Map<string, number>();
			second.connection.on("op", (_document, operations) => {
				for (const op of operations) {
					if (typeof op.contents === "string")
						observed.set(op.contents, performance.now());
				}
			});
			for (let i = 0; i < 50; i++) {
				if (i === 25)
					await runtime.unsafeEvictDurableObject(
						"tidepool-tests",
						"DocumentDO",
						{
							name: JSON.stringify(["fluid", "measurements"]),
							webSockets: "hibernate",
						},
					);
				const contents = `${i}:`.padEnd(128, "x");
				expect(Buffer.byteLength(contents)).toBe(128);
				const started = performance.now();
				first.connection.submit([
					{
						clientSequenceNumber: i + 1,
						referenceSequenceNumber: 0,
						type: "op",
						contents,
					},
				]);
				await expect.poll(() => observed.has(contents)).toBe(true);
				const received = observed.get(contents);
				if (received === undefined)
					throw new Error("Missing fan-out measurement");
				samples.push(received - started);
			}
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
			expect(rows[0]?.sequenceNumber).toBe(52);
			expect(samples).toHaveLength(50);
			console.info(
				"Local workerd measurement",
				JSON.stringify({
					clients: 2,
					operations: 50,
					payloadBytes: 128,
					p50Ms: sorted[24],
					p95Ms: sorted[47],
					maxMs: sorted.at(-1),
					wakeMs,
					...rows[0],
				}),
			);
		} finally {
			first.connection.dispose();
			first.service.dispose();
			second.connection.dispose();
			second.service.dispose();
		}
	} finally {
		await runtime.dispose();
	}
});
