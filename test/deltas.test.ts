import { afterAll, beforeAll, expect, it } from "vitest";
import { api, connect, createDocument, startRuntime } from "./runtime.js";

let environment: Awaited<ReturnType<typeof startRuntime>>;
beforeAll(async () => {
	environment = await startRuntime();
});
afterAll(async () => environment?.runtime.dispose());

async function waitForSequence(document: string, sn: number) {
	const storage = await environment.runtime.unsafeGetDurableObjectStorage(
		"tidepool-tests",
		"DocumentDO",
		{
			name: JSON.stringify(["fluid", document]),
		},
	);
	await expect
		.poll(
			async () => {
				const rows = await storage.exec<{ sn: number }>(
					"SELECT json_extract(body,'$.sn') AS sn FROM state",
				);
				return rows[0]?.sn;
			},
			{ timeout: 15_000 },
		)
		.toBe(sn);
}

it("loads deltas for a document named session through the official driver", async () => {
	const { base } = environment;
	await createDocument(base, "session");
	const peer = await connect(base, "session");
	try {
		peer.connection.submit([
			{
				clientSequenceNumber: 1,
				referenceSequenceNumber: 0,
				type: "op",
				contents: "reserved-name",
			},
		]);
		await waitForSequence("session", 2);
		const storage = await peer.service.connectToDeltaStorage();
		const stream = storage.fetchMessages(1, undefined);
		const contents: unknown[] = [];
		for (;;) {
			const chunk = await stream.read();
			if (chunk.done) break;
			contents.push(...chunk.value.map((op) => op.contents));
		}
		expect(contents).toContain("reserved-name");
	} finally {
		peer.connection.dispose();
		peer.service.dispose();
	}
});

it("streams complete ranges larger than 4 MiB through the unmodified delta driver", async () => {
	const document = "large-delta-range";
	await createDocument(environment.base, document);
	const peer = await connect(environment.base, document);
	try {
		for (let i = 1; i <= 7; i++) {
			peer.connection.submit([
				{
					clientSequenceNumber: i,
					referenceSequenceNumber: 0,
					type: "op",
					contents: `${i}`.padEnd(900_000, "x"),
				},
			]);
		}
		await waitForSequence(document, 8);
		const storage = await peer.service.connectToDeltaStorage();
		const stream = storage.fetchMessages(1, undefined);
		const numbers: number[] = [];
		for (;;) {
			const chunk = await stream.read();
			if (chunk.done) break;
			numbers.push(...chunk.value.map((op) => op.sequenceNumber));
		}
		expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		const bounded = await api(
			environment.base,
			document,
			"/deltas/fluid/large-delta-range?from=2&to=5",
		);
		expect(bounded.status).toBe(200);
		const result = (await bounded.json()) as Array<{ sequenceNumber: number }>;
		expect(result.map((op) => op.sequenceNumber)).toEqual([3, 4]);
	} finally {
		peer.connection.dispose();
		peer.service.dispose();
	}
});

it("does not end catch-up at an arbitrary operation-count boundary", async () => {
	const document = "many-deltas";
	await createDocument(environment.base, document);
	const peer = await connect(environment.base, document);
	try {
		peer.connection.submit(
			Array.from({ length: 2501 }, (_, i) => ({
				clientSequenceNumber: i + 1,
				referenceSequenceNumber: 0,
				type: "op",
				contents: i,
			})),
		);
		await waitForSequence(document, 2502);
		const storage = await peer.service.connectToDeltaStorage();
		const stream = storage.fetchMessages(1, undefined);
		const numbers: number[] = [];
		for (;;) {
			const chunk = await stream.read();
			if (chunk.done) break;
			numbers.push(...chunk.value.map((op) => op.sequenceNumber));
		}
		expect(numbers).toEqual(Array.from({ length: 2502 }, (_, i) => i + 1));
		const empty = await api(
			environment.base,
			document,
			"/deltas/fluid/many-deltas?from=2502",
		);
		expect(await empty.json()).toEqual([]);
	} finally {
		peer.connection.dispose();
		peer.service.dispose();
	}
});
