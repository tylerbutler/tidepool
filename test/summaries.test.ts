import { afterAll, beforeAll, expect, it } from "vitest";
import { record, text } from "../src/common.js";
import {
	api,
	connect,
	createDocument,
	deltas,
	startRuntime,
} from "./runtime.js";
import { acknowledgedHandle, submitSummary } from "./summary.js";

let environment: Awaited<ReturnType<typeof startRuntime>>;
beforeAll(async () => {
	environment = await startRuntime();
});
afterAll(async () => environment?.runtime.dispose());

async function stage(document: string) {
	const blob = await api(environment.base, document, "/repos/fluid/git/blobs", {
		content: "snapshot",
		encoding: "utf-8",
	});
	expect(blob.status).toBe(201);
	const sha = text(record(await blob.json()).sha);
	const response = await api(
		environment.base,
		document,
		"/repos/fluid/git/trees",
		{ tree: [{ path: "value", mode: "100644", type: "blob", sha }] },
	);
	expect(response.status).toBe(201);
	return text(record(await response.json()).sha);
}

async function inspect(document: string) {
	return environment.runtime.unsafeGetDurableObjectStorage(
		"tidepool-tests",
		"DocumentDO",
		{
			name: JSON.stringify(["fluid", document]),
		},
	);
}

it("publishes one owned commit and replays the ack on an exact summary retry", async () => {
	const document = "summary-retry";
	await createDocument(environment.base, document);
	const tree = await stage(document);
	const peer = await connect(environment.base, document);
	try {
		const received: string[] = [];
		peer.connection.on("op", (_document, operations) =>
			received.push(...operations.map((op) => op.type)),
		);
		const response = await submitSummary(peer.connection, tree, "", 1, 1);
		const handle = acknowledgedHandle(response);
		expect(response.sequenceNumber).toBe(3);
		const before = await deltas(environment.base, document);
		expect(
			acknowledgedHandle(await submitSummary(peer.connection, tree, "", 1, 1)),
		).toBe(handle);
		expect(received.filter((type) => type === "summaryAck")).toHaveLength(2);
		expect(await deltas(environment.base, document)).toEqual(before);
		const commit = await api(
			environment.base,
			document,
			`/repos/fluid/git/commits/${handle}`,
		);
		expect(commit.status).toBe(200);
		await createDocument(environment.base, "summary-foreign");
		expect(
			(
				await api(
					environment.base,
					"summary-foreign",
					`/repos/fluid/git/commits/${handle}`,
				)
			).status,
		).toBe(404);
	} finally {
		peer.connection.dispose();
		peer.service.dispose();
	}
});

it("rolls back proposal, acknowledgement, head and client CSN when publication fails", async () => {
	const document = "summary-publication-failure";
	await createDocument(environment.base, document);
	const tree = await stage(document);
	const peer = await connect(environment.base, document);
	try {
		const storage = await inspect(document);
		await storage.exec(
			"CREATE TRIGGER fail_publish BEFORE INSERT ON ops WHEN json_extract(NEW.body,'$.type')='summaryAck' BEGIN SELECT RAISE(FAIL,'injected publication failure'); END",
		);
		let nacks = 0;
		peer.connection.on("nack", () => {
			nacks++;
		});
		peer.connection.submit([
			{
				clientSequenceNumber: 1,
				referenceSequenceNumber: 1,
				type: "summarize",
				contents: { handle: tree, head: "", parents: [], message: "Summary 1" },
			},
		]);
		await expect.poll(() => nacks).toBe(1);
		expect(
			(await deltas(environment.base, document)).map((o) => o.type),
		).toEqual(["join"]);
		const state = await storage.exec<{ handle: string; sn: number }>(
			"SELECT json_extract(body,'$.handle') AS handle,json_extract(body,'$.sn') AS sn FROM state",
		);
		expect(state[0]).toEqual({ handle: "", sn: 1 });
		expect(await storage.exec("SELECT * FROM refs")).toEqual([]);
		const client = await storage.exec<{ csn: number }>(
			"SELECT csn FROM clients WHERE id=?",
			peer.connection.clientId,
		);
		expect(client[0]?.csn).toBe(0);
		await storage.exec("DROP TRIGGER fail_publish");
		acknowledgedHandle(await submitSummary(peer.connection, tree, "", 1, 1));
		expect(
			(await deltas(environment.base, document)).map((o) => o.type),
		).toEqual(["join", "summarize", "summaryAck"]);
	} finally {
		peer.connection.dispose();
		peer.service.dispose();
	}
});

it("accepts one competing summary and rejects the stale head without a second publication", async () => {
	const document = "competing-summaries";
	await createDocument(environment.base, document);
	const tree = await stage(document);
	const first = await connect(environment.base, document);
	const second = await connect(environment.base, document);
	try {
		const responses = await Promise.all([
			submitSummary(first.connection, tree, "", 1, 1),
			submitSummary(second.connection, tree, "", 1, 1),
		]);
		expect(responses.map((o) => o.type).sort()).toEqual([
			"summaryAck",
			"summaryNack",
		]);
		const ops = await deltas(environment.base, document);
		expect(ops.map((o) => o.sequenceNumber)).toEqual(ops.map((_, i) => i + 1));
		expect(ops.filter((o) => o.type === "summaryAck")).toHaveLength(1);
		const refs = await (await inspect(document)).exec("SELECT * FROM refs");
		expect(refs).toHaveLength(1);
	} finally {
		first.connection.dispose();
		first.service.dispose();
		second.connection.dispose();
		second.service.dispose();
	}
});

it("does not publish a summary whose immutable tree is missing", async () => {
	const document = "missing-summary-content";
	await createDocument(environment.base, document);
	const tree = await stage(document);
	const storage = await inspect(document);
	const keys = await storage.exec<{ key: string }>(
		"SELECT key FROM content WHERE key LIKE ?",
		`%${tree}%`,
	);
	expect(keys).toHaveLength(1);
	const key = keys[0]?.key;
	if (!key) throw new Error("Missing staged tree key");
	const bucket = await environment.runtime.getR2Bucket("CONTENT");
	await bucket.delete(key);
	const peer = await connect(environment.base, document);
	try {
		const response = await submitSummary(peer.connection, tree, "", 1, 1);
		expect(response.type).toBe("summaryNack");
		expect(await storage.exec("SELECT * FROM refs")).toEqual([]);
	} finally {
		peer.connection.dispose();
		peer.service.dispose();
	}
});
