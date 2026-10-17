import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HttpError, MAX_HTTP_BYTES } from "../src/common";
import {
	Historian,
	type HistorianBucket,
	type HistorianStore,
} from "../src/historian";

class MemoryStore implements HistorianStore {
	readonly commits = new Map<string, string>();
	readonly refs = new Map<string, string>();
	readonly content = new Map<string, number>();
	contentUsed = 0;
	contentLimit = 63 * 1024 * 1024;
	getCommit(sha: string) {
		return this.commits.get(sha);
	}
	putCommit(sha: string, body: string) {
		this.commits.set(sha, body);
	}
	getRef(name: string) {
		return this.refs.get(name);
	}
	setRef(name: string, sha: string) {
		this.refs.set(name, sha);
	}
	listRefs() {
		return Array.from(this.refs, ([ref, sha]) => ({ ref, sha }));
	}
	reserveContent(key: string, size: number) {
		const previous = this.content.get(key);
		if (previous !== undefined) {
			if (previous !== size)
				throw new HttpError(500, "Reservation size changed");
			return;
		}
		if (this.contentUsed + size > this.contentLimit)
			throw new HttpError(413, "Document storage budget exceeded");
		this.content.set(key, size);
		this.contentUsed += size;
	}
}

class MemoryBucket implements HistorianBucket {
	readonly objects = new Map<string, string>();
	failWrites = false;
	putCalls = 0;
	async get(key: string) {
		const body = this.objects.get(key);
		return body === undefined ? null : { text: async () => body };
	}
	async put(key: string, body: string, options?: R2PutOptions) {
		this.putCalls++;
		if (this.failWrites) throw new Error("R2 unavailable");
		if (options?.onlyIf && this.objects.has(key)) return null;
		this.objects.set(key, body);
		return { etag: "stored" };
	}
}

function setup(
	bucket = new MemoryBucket(),
	document = "doc",
	tenant = "tenant",
) {
	const store = new MemoryStore();
	const historian = new Historian(
		bucket,
		store,
		tenant,
		document,
		"http://localhost",
	);
	return { historian, store, bucket };
}

const author = { name: "Test", email: "test@example.com", date: "123" };
const directHash = (value: unknown) =>
	createHash("sha1").update(JSON.stringify(value)).digest("hex");
const entry = (path: string, type: "blob" | "tree", sha: string) => ({
	path,
	mode: type === "tree" ? "040000" : "100644",
	type,
	sha,
});
type RestTree = {
	sha: string;
	tree: Array<{
		path: string;
		sha: string;
		type: string;
		size: number;
		url: string;
	}>;
};
type RestCommit = {
	sha: string;
	tree: { sha: string };
	parents: Array<{ sha: string }>;
};
type RestBlob = {
	content: string;
	encoding: string;
	size: number;
	sha: string;
	url: string;
};

async function commit(
	historian: Historian,
	tree: string,
	parents: string[] = [],
) {
	return historian.create("commits", {
		tree,
		parents,
		message: "summary",
		author,
	});
}

async function readTree(historian: Historian, sha: string) {
	return (await historian.get("trees", sha)) as RestTree;
}

async function protocolBlobs(historian: Historian, commitId: string) {
	const current = (await historian.get("commits", commitId)) as RestCommit;
	const root = await readTree(historian, current.tree.sha);
	const protocolEntry = root.tree.find((item) => item.path === ".protocol");
	if (!protocolEntry) throw new Error("Protocol tree is missing");
	const protocol = await readTree(historian, protocolEntry.sha);
	const result: Record<string, unknown> = {};
	for (const item of protocol.tree) {
		const blob = (await historian.get("blobs", item.sha)) as RestBlob;
		result[item.path] = JSON.parse(blob.content);
	}
	return { root, protocol, blobs: result };
}

describe("Historian objects", () => {
	it("uses Git-canonical blob hashes, byte lengths, and encoding-aware REST bodies", async () => {
		const { historian, bucket } = setup();
		const id = await historian.create("blobs", {
			content: "hello\n",
			encoding: "utf-8",
		});
		expect(id).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
		expect(await historian.get("blobs", id)).toEqual({
			sha: id,
			size: 6,
			content: "hello\n",
			encoding: "utf-8",
			url: `http://localhost/repos/tenant/git/blobs/${id}`,
		});
		expect(
			await historian.create("blobs", {
				content: "aGVsbG8K",
				encoding: "base64",
			}),
		).toBe(id);
		expect(((await historian.get("blobs", id)) as RestBlob).encoding).toBe(
			"utf-8",
		);
		expect(bucket.objects.size).toBe(1);
		const unicode = await historian.create("blobs", { content: "é" });
		expect(((await historian.get("blobs", unicode)) as RestBlob).size).toBe(2);
		const binary = await historian.create("blobs", {
			content: "/wAB",
			encoding: "base64",
		});
		expect(binary).toBe(
			createHash("sha1")
				.update(Buffer.from("blob 3\0"))
				.update(Buffer.from([255, 0, 1]))
				.digest("hex"),
		);
		expect(await historian.get("blobs", binary)).toMatchObject({
			size: 3,
			content: "/wAB",
			encoding: "base64",
		});
	});

	it("hashes tree and commit JSON directly and returns silt REST shapes", async () => {
		const { historian, store, bucket } = setup();
		const blob = await historian.create("blobs", { content: "hi" });
		const input = { tree: [entry("file", "blob", blob)] };
		const tree = await historian.create("trees", input);
		expect(tree).toBe(directHash(input));
		expect(await historian.get("trees", tree)).toEqual({
			sha: tree,
			url: `http://localhost/repos/tenant/git/trees/${tree}`,
			tree: [
				{
					...input.tree[0],
					size: 0,
					url: `http://localhost/repos/tenant/git/blobs/${blob}`,
				},
			],
		});
		const body = { tree, author, message: "hello", parents: [] };
		const id = await historian.create("commits", body);
		expect(id).toBe(directHash(body));
		expect(store.getCommit(id)).toBe(JSON.stringify(body));
		expect(bucket.objects.size).toBe(2);
		expect(await historian.get("commits", id)).toEqual({
			sha: id,
			url: `http://localhost/repos/tenant/git/commits/${id}`,
			author,
			committer: author,
			message: "hello",
			tree: {
				sha: tree,
				url: `http://localhost/repos/tenant/git/trees/${tree}`,
			},
			parents: [],
		});
	});

	it("recursively returns trees in pre-order with full paths", async () => {
		const { historian } = setup();
		const blob = await historian.create("blobs", { content: "" });
		const child = await historian.create("trees", {
			tree: [entry("leaf", "blob", blob)],
		});
		const root = await historian.create("trees", {
			tree: [entry("child", "tree", child)],
		});
		const response = (await historian.get("trees", root, true)) as RestTree;
		expect(response.tree.map((item) => item.path)).toEqual([
			"child",
			"child/leaf",
		]);
	});

	it("shares tenant blobs and trees but never reads another document's commits", async () => {
		const first = setup();
		const second = setup(first.bucket, "other");
		const third = setup(first.bucket, "other", "another/tenant");
		const blob = await first.historian.create("blobs", { content: "shared" });
		const tree = await first.historian.create("trees", {
			tree: [entry("file", "blob", blob)],
		});
		const id = await commit(first.historian, tree);
		expect(await second.historian.get("blobs", blob)).toMatchObject({
			content: "shared",
		});
		expect(await second.historian.get("trees", tree)).toMatchObject({
			sha: tree,
		});
		await expect(second.historian.get("commits", id)).rejects.toMatchObject({
			status: 404,
		});
		await expect(third.historian.get("blobs", blob)).rejects.toMatchObject({
			status: 404,
		});
		await expect(commit(second.historian, tree, [id])).rejects.toMatchObject({
			status: 404,
		});
		await expect(
			second.historian.create("trees", {
				tree: [{ path: "commit", mode: "160000", type: "commit", sha: id }],
			}),
		).rejects.toMatchObject({ status: 404 });
	});

	it.each([
		["blobs", { content: 3 }],
		["blobs", { content: "", encoding: "utf16" }],
		["blobs", { content: "aGVsbG8", encoding: "base64" }],
		["blobs", { content: "Zh==", encoding: "base64" }],
		["trees", { tree: [{ path: "../x", sha: "a".repeat(40) }] }],
		["trees", { tree: [{ path: "x", type: "wrong", sha: "a".repeat(40) }] }],
		[
			"trees",
			{
				tree: [
					{ path: "x", mode: "040000", type: "blob", sha: "a".repeat(40) },
				],
			},
		],
		["commits", { tree: "a".repeat(40), author: { date: 1.5 } }],
		["wrong", {}],
	])("rejects malformed %s inputs", async (kind, body) => {
		const { historian } = setup();
		await expect(
			historian.create(kind as "blobs", body),
		).rejects.toBeInstanceOf(HttpError);
	});

	it("rejects missing and wrong-kind children before persisting the parent", async () => {
		const { historian, bucket, store } = setup();
		const blob = await historian.create("blobs", { content: "exists" });
		const size = bucket.objects.size;
		const reserved = store.contentUsed;
		await expect(
			historian.create("trees", {
				tree: [entry("missing", "blob", "a".repeat(40))],
			}),
		).rejects.toMatchObject({ status: 404 });
		await expect(
			historian.create("trees", { tree: [entry("wrong", "tree", blob)] }),
		).rejects.toMatchObject({ status: 404 });
		await expect(commit(historian, blob)).rejects.toMatchObject({
			status: 404,
		});
		expect(bucket.objects.size).toBe(size);
		expect(store.contentUsed).toBe(reserved);
		expect(store.commits.size).toBe(0);
		expect(store.listRefs()).toEqual([]);
	});

	it("reserves namespaced R2 payload bytes once per document before uploading", async () => {
		const { historian, store, bucket } = setup();
		const blob = await historian.create("blobs", { content: "é\n\0" });
		const blobKey = JSON.stringify(["tenant", "blobs", blob]);
		const blobBody = bucket.objects.get(blobKey);
		if (blobBody === undefined) throw new Error("Blob is missing");
		const blobSize = Buffer.byteLength(blobBody, "utf8");
		expect(store.content.get(blobKey)).toBe(blobSize);
		expect(blobSize).toBeGreaterThan(blobBody.length);
		expect(store.contentUsed).toBe(blobSize);
		expect(await historian.create("blobs", { content: "é\n\0" })).toBe(blob);
		expect(store.contentUsed).toBe(blobSize);
		expect(bucket.putCalls).toBe(1);

		const input = { tree: [entry("file", "blob", blob)] };
		const tree = await historian.create("trees", input);
		const treeKey = JSON.stringify(["tenant", "trees", tree]);
		const treeSize = Buffer.byteLength(JSON.stringify(input), "utf8");
		expect(store.content.get(treeKey)).toBe(treeSize);
		expect(store.contentUsed).toBe(blobSize + treeSize);
		expect(await historian.create("trees", input)).toBe(tree);
		expect(store.contentUsed).toBe(blobSize + treeSize);
		expect(bucket.putCalls).toBe(2);
	});

	it.each([
		"blobs",
		"trees",
	] as const)("charges an existing shared %s object to each document before returning it", async (kind) => {
		const first = setup();
		const blob = await first.historian.create("blobs", {
			content: "hello\n",
			encoding: "utf-8",
		});
		const treeInput = { tree: [entry("file", "blob", blob)] };
		const id =
			kind === "blobs"
				? blob
				: await first.historian.create("trees", treeInput);
		const input =
			kind === "blobs"
				? { content: "aGVsbG8K", encoding: "base64" }
				: treeInput;
		const second = setup(first.bucket, "second");
		const writes = first.bucket.putCalls;
		second.store.contentLimit = 0;
		await expect(second.historian.create(kind, input)).rejects.toMatchObject({
			status: 413,
		});
		expect(first.bucket.putCalls).toBe(writes);
		expect(second.store.contentUsed).toBe(0);
		expect(second.store.commits.size).toBe(0);
		expect(second.store.listRefs()).toEqual([]);

		second.store.contentLimit = 63 * 1024 * 1024;
		expect(await second.historian.create(kind, input)).toBe(id);
		expect(second.store.content).toEqual(first.store.content);
		expect(second.store.contentUsed).toBe(first.store.contentUsed);
		expect(await second.historian.create(kind, input)).toBe(id);
		expect(second.store.contentUsed).toBe(first.store.contentUsed);
		expect(first.bucket.putCalls).toBe(writes);
	});

	it.each([
		"tree",
		"commit",
		"summary",
	] as const)("reserves recursively referenced shared content when creating a %s without recreating its children", async (operation) => {
		const first = setup();
		const blob = await first.historian.create("blobs", {
			content: "referenced",
		});
		const child = await first.historian.create("trees", {
			tree: [entry("file", "blob", blob)],
		});
		const second = setup(first.bucket, "second");
		const reference = () =>
			operation === "tree"
				? second.historian.create("trees", {
						tree: [entry("left", "tree", child), entry("right", "tree", child)],
					})
				: operation === "commit"
					? commit(second.historian, child)
					: second.historian.prepareSummary(
							{ handle: child, head: "", parents: [] },
							0,
							0,
							[],
							"",
						);
		const writes = first.bucket.putCalls;
		second.store.contentLimit = 0;
		await expect(reference()).rejects.toMatchObject({ status: 413 });
		expect(first.bucket.putCalls).toBe(writes);
		expect(second.store.commits.size).toBe(0);
		expect(second.store.listRefs()).toEqual([]);

		second.store.contentLimit = 63 * 1024 * 1024;
		await reference();
		for (const [key, size] of first.store.content)
			expect(second.store.content.get(key)).toBe(size);
		expect(second.store.content.size).toBe(operation === "tree" ? 3 : 2);
		expect(first.bucket.putCalls).toBe(writes + (operation === "tree" ? 1 : 0));
		const used = second.store.contentUsed;
		await reference();
		expect(second.store.contentUsed).toBe(used);
		expect(first.bucket.putCalls).toBe(writes + (operation === "tree" ? 1 : 0));
	});

	it("validates every referenced child before reserving any shared content", async () => {
		const first = setup();
		const blob = await first.historian.create("blobs", { content: "existing" });
		const second = setup(first.bucket, "second");
		await expect(
			second.historian.create("trees", {
				tree: [
					entry("existing", "blob", blob),
					entry("missing", "blob", "a".repeat(40)),
				],
			}),
		).rejects.toMatchObject({ status: 404 });
		expect(second.store.content.size).toBe(0);
		expect(second.store.contentUsed).toBe(0);
		expect(second.store.commits.size).toBe(0);
		expect(second.store.listRefs()).toEqual([]);
	});

	it("rejects a quota reservation before R2.put and leaves no published commit", async () => {
		const { historian, store, bucket } = setup();
		store.contentLimit = 0;
		await expect(
			historian.initialize({ summary: { entries: [] } }),
		).rejects.toMatchObject({ status: 413 });
		expect(bucket.putCalls).toBe(0);
		expect(bucket.objects.size).toBe(0);
		expect(store.contentUsed).toBe(0);
		expect(store.content.size).toBe(0);
		expect(store.commits.size).toBe(0);
		expect(store.listRefs()).toEqual([]);
	});

	it("retains failed upload reservations and retries an identical key without a second charge", async () => {
		const { historian, store, bucket } = setup();
		const body = { content: "staged", encoding: "utf-8" };
		const size = Buffer.byteLength(JSON.stringify(body), "utf8");
		store.contentLimit = size;
		bucket.failWrites = true;
		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(historian.create("blobs", body)).rejects.toThrow(
				"R2 unavailable",
			);
			expect(store.contentUsed).toBe(size);
			expect(store.content.size).toBe(1);
			expect(bucket.objects.size).toBe(0);
		}
		bucket.failWrites = false;
		const blob = await historian.create("blobs", body);
		expect(store.content.get(JSON.stringify(["tenant", "blobs", blob]))).toBe(
			size,
		);
		expect(store.contentUsed).toBe(size);
		expect(bucket.putCalls).toBe(3);
		expect(bucket.objects.size).toBe(1);
		await expect(
			historian.create("blobs", { content: "another" }),
		).rejects.toMatchObject({ status: 413 });
		expect(bucket.putCalls).toBe(3);
		expect(store.commits.size).toBe(0);
		expect(store.listRefs()).toEqual([]);
	});

	it("fails closed on unavailable R2, without publishing commits or refs", async () => {
		const { historian, bucket, store } = setup();
		bucket.failWrites = true;
		await expect(
			historian.initialize({ summary: { entries: [] } }),
		).rejects.toThrow("R2 unavailable");
		expect(store.commits.size).toBe(0);
		expect(store.listRefs()).toEqual([]);
		expect(store.contentUsed).toBe(
			Buffer.byteLength(JSON.stringify({ tree: [] })),
		);
	});

	it("does not accept a failed conditional write without a stored object", async () => {
		const bucket: HistorianBucket = {
			async get() {
				return null;
			},
			async put() {
				return null;
			},
		};
		const store = new MemoryStore();
		const historian = new Historian(
			bucket,
			store,
			"tenant",
			"doc",
			"http://localhost",
		);
		await expect(
			historian.create("blobs", { content: "missing" }),
		).rejects.toMatchObject({ status: 404 });
		expect(store.commits.size).toBe(0);
	});

	it("limits graph width even when every entry shares the same blob", async () => {
		const { historian } = setup();
		const blob = await historian.create("blobs", { content: "shared" });
		await expect(
			historian.create("trees", {
				tree: Array.from({ length: 10_001 }, (_, index) =>
					entry(String(index), "blob", blob),
				),
			}),
		).rejects.toMatchObject({ status: 413 });
	});

	it("limits aggregate recursive tree reads even when each object is below the byte limit", async () => {
		const { historian } = setup();
		const padding = "x".repeat(MAX_HTTP_BYTES / 2);
		const left = await historian.create("trees", { tree: [], padding });
		const right = await historian.create("trees", {
			tree: [],
			padding,
			different: true,
		});
		const root = await historian.create("trees", {
			tree: [entry("left", "tree", left), entry("right", "tree", right)],
		});
		expect((await readTree(historian, root)).tree).toHaveLength(2);
		await expect(historian.get("trees", root, true)).rejects.toMatchObject({
			status: 413,
		});
	});

	it("limits flattened tree response bytes independently of node count and read bytes", async () => {
		const { historian } = setup();
		const blob = await historian.create("blobs", { content: "" });
		const child = await historian.create("trees", {
			tree: Array.from({ length: 9_000 }, (_, index) =>
				entry(String(index), "blob", blob),
			),
		});
		const root = await historian.create("trees", {
			tree: [entry("x".repeat(2048), "tree", child)],
		});
		await expect(historian.get("trees", root, true)).rejects.toMatchObject({
			status: 413,
		});
	});

	it("bounds the complete blob REST response, not only its stored body", async () => {
		const { historian } = setup();
		const blob = await historian.create("blobs", {
			content: "x".repeat(MAX_HTTP_BYTES - 64),
		});
		await expect(historian.get("blobs", blob)).rejects.toMatchObject({
			status: 413,
		});
	});

	it("rejects oversized objects, corrupt stored objects, and excessive graph depth", async () => {
		const { historian, bucket } = setup();
		await expect(
			historian.create("blobs", { content: "x".repeat(16 * 1024 * 1024) }),
		).rejects.toMatchObject({ status: 413 });
		const blob = await historian.create("blobs", { content: "valid" });
		bucket.objects.set(
			JSON.stringify(["tenant", "blobs", blob]),
			JSON.stringify({ content: "corrupt" }),
		);
		await expect(historian.get("blobs", blob)).rejects.toMatchObject({
			status: 500,
		});
		let root = await historian.create("trees", { tree: [] });
		for (let index = 0; index < 65; index++) {
			root = await historian.create("trees", {
				tree: [entry("nested", "tree", root)],
			});
		}
		await expect(
			historian.create("trees", { tree: [entry("overflow", "tree", root)] }),
		).rejects.toMatchObject({ status: 413 });
	});
});

describe("Historian publication", () => {
	it("has no initial handle without a summary", async () => {
		const { historian, bucket, store } = setup();
		expect(await historian.initialize({ sequenceNumber: 99 })).toEqual({
			handle: "",
			sequenceNumber: 0,
		});
		expect(bucket.objects.size).toBe(0);
		expect(store.commits.size).toBe(0);
		expect(await historian.versions("doc", 1)).toEqual([]);
	});

	it("accepts existing summary entry ids only when their target type matches", async () => {
		const { historian, store } = setup();
		const blob = await historian.create("blobs", { content: "cached" });
		const created = await historian.initialize({
			summary: { entries: [{ path: "cached", type: "blob", id: blob }] },
		});
		const { root } = await protocolBlobs(historian, created.handle);
		const recursive = (await historian.get(
			"trees",
			root.sha,
			true,
		)) as RestTree;
		expect(
			recursive.tree.find((item) => item.path === ".app/cached")?.sha,
		).toBe(blob);
		const commits = store.commits.size;
		for (const invalid of [
			{ path: "wrong", type: "tree", id: blob },
			{ path: "both", type: "blob", id: blob, value: { content: "value" } },
			{ path: "missing", type: "blob" },
			{ path: "mismatch", type: "blob", value: { type: "tree", entries: [] } },
		]) {
			await expect(
				historian.initialize({ summary: { entries: [invalid] } }),
			).rejects.toBeInstanceOf(HttpError);
		}
		expect(store.commits.size).toBe(commits);
		expect(store.listRefs()).toEqual([]);
	});

	it("builds the official driver's combined initial app and protocol summary", async () => {
		const { historian, store } = setup();
		const values = [
			["code", { key: "code", value: { package: "test" }, sequenceNumber: 0 }],
		];
		const created = await historian.initialize({
			summary: {
				type: "tree",
				entries: [
					{
						path: "nested",
						type: "tree",
						value: {
							entries: [
								{
									path: "data",
									type: "blob",
									value: { content: "initial", encoding: "utf-8" },
								},
							],
						},
					},
				],
			},
			sequenceNumber: 7,
			values,
		});
		expect(created.sequenceNumber).toBe(7);
		const { root, blobs } = await protocolBlobs(historian, created.handle);
		expect(root.tree.map((item) => item.path)).toEqual([".app", ".protocol"]);
		expect(blobs).toEqual({
			attributes: { minimumSequenceNumber: 7, sequenceNumber: 7 },
			quorumMembers: [],
			quorumProposals: [],
			quorumValues: values,
		});
		const recursive = (await historian.get(
			"trees",
			root.sha,
			true,
		)) as RestTree;
		expect(recursive.tree.map((item) => item.path)).toContain(
			".app/nested/data",
		);
		expect(store.listRefs()).toEqual([]);
	});

	it("prepares but does not publish summaries, preserving quorum values and proposals", async () => {
		const { historian, store } = setup();
		const initial = await historian.initialize({
			summary: { entries: [] },
			values: [["key", { value: 1 }]],
		});
		const first = await protocolBlobs(historian, initial.handle);
		const proposals = await historian.create("blobs", {
			content: JSON.stringify([[2, { key: "proposal", value: 3 }]]),
		});
		const changedProtocol = await historian.create("trees", {
			tree: first.protocol.tree.map((item) =>
				entry(
					item.path,
					"blob",
					item.path === "quorumProposals" ? proposals : item.sha,
				),
			),
		});
		const root = await historian.create("trees", {
			tree: first.root.tree.map((item) =>
				entry(
					item.path,
					"tree",
					item.path === ".protocol" ? changedProtocol : item.sha,
				),
			),
		});
		const head = await commit(historian, root, [initial.handle]);
		store.setRef("refs/heads/doc", head);
		const app = await historian.create("trees", { tree: [] });
		const members = [
			[
				"client",
				{ client: { mode: "write", user: { id: "u" } }, sequenceNumber: 8 },
			],
		];
		const prepared = await historian.prepareSummary(
			JSON.stringify({
				handle: app,
				head,
				parents: [head],
				message: "checkpoint",
			}),
			10,
			5,
			members,
			head,
		);
		const next = await protocolBlobs(historian, prepared);
		expect(next.root.tree.find((item) => item.path === ".app")?.sha).toBe(app);
		expect(next.blobs).toEqual({
			attributes: { minimumSequenceNumber: 5, sequenceNumber: 10 },
			quorumMembers: members,
			quorumProposals: [[2, { key: "proposal", value: 3 }]],
			quorumValues: [["key", { value: 1 }]],
		});
		expect(
			((await historian.get("commits", prepared)) as RestCommit).parents,
		).toMatchObject([{ sha: head }]);
		expect(store.getRef("refs/heads/doc")).toBe(head);
		await expect(historian.versions(prepared, 1)).rejects.toMatchObject({
			status: 404,
		});
	});

	it("uses a submitted tree unchanged for a summary without a parent", async () => {
		const { historian } = setup();
		const tree = await historian.create("trees", { tree: [] });
		const prepared = await historian.prepareSummary(
			{ handle: tree, head: "", parents: [] },
			0,
			0,
			[],
			"",
		);
		expect(
			((await historian.get("commits", prepared)) as RestCommit).tree.sha,
		).toBe(tree);
	});

	it("rejects incompatible heads, parents, handles, and invalid quorum members", async () => {
		const { historian, store } = setup();
		const initial = await historian.initialize({ summary: { entries: [] } });
		store.setRef("refs/heads/doc", initial.handle);
		const tree = await historian.create("trees", { tree: [] });
		const valid = {
			handle: tree,
			head: initial.handle,
			parents: [initial.handle],
		};
		for (const input of [
			{ ...valid, head: "" },
			{ ...valid, parents: [] },
			{ ...valid, parents: [initial.handle, initial.handle] },
		]) {
			await expect(
				historian.prepareSummary(input, 1, 0, [], initial.handle),
			).rejects.toMatchObject({ status: 409 });
		}
		await expect(
			historian.prepareSummary(valid, 1, 0, [], ""),
		).rejects.toMatchObject({ status: 409 });
		await expect(
			historian.prepareSummary(
				{ ...valid, handle: "a".repeat(40) },
				1,
				0,
				[],
				initial.handle,
			),
		).rejects.toMatchObject({ status: 404 });
		await expect(
			historian.prepareSummary(valid, 1, 2, [], initial.handle),
		).rejects.toMatchObject({ status: 400 });
		await expect(
			historian.prepareSummary(
				valid,
				1,
				0,
				[["client", { client: {}, sequenceNumber: 2 }]],
				initial.handle,
			),
		).rejects.toMatchObject({ status: 400 });
	});

	it("lists only the published first-parent chain with exact detailed driver shapes", async () => {
		const { historian, store } = setup();
		const tree = await historian.create("trees", { tree: [] });
		const first = await commit(historian, tree);
		const second = await commit(historian, tree, [first]);
		const staged = await commit(historian, tree, [second]);
		store.setRef("refs/heads/doc", second);
		const history = (await historian.versions("doc", 2)) as Array<{
			sha: string;
		}>;
		expect(history.map((item) => item.sha)).toEqual([second, first]);
		expect(history[0]).toEqual({
			sha: second,
			url: `http://localhost/repos/tenant/git/commits/${second}`,
			commit: {
				url: `http://localhost/repos/tenant/git/commits/${second}`,
				author,
				committer: author,
				message: "summary",
				tree: {
					sha: tree,
					url: `http://localhost/repos/tenant/git/trees/${tree}`,
				},
			},
			parents: [
				{
					sha: first,
					url: `http://localhost/repos/tenant/git/commits/${first}`,
				},
			],
		});
		expect(await historian.versions(first, 1)).toMatchObject([{ sha: first }]);
		await expect(historian.versions(staged, 1)).rejects.toMatchObject({
			status: 404,
		});
		for (const count of [0, -1, 1.5, 1001, NaN, Infinity]) {
			await expect(historian.versions("doc", count)).rejects.toMatchObject({
				status: 400,
			});
		}
		store.commits.delete(first);
		expect(await historian.versions("doc", 1)).toMatchObject([{ sha: second }]);
		await expect(historian.versions("doc", 2)).rejects.toMatchObject({
			status: 404,
		});
	});

	it("validates only requested snapshots and stops once the requested count is collected", async () => {
		const { historian, store, bucket } = setup();
		const blob = await historian.create("blobs", { content: "shared" });
		const trees: string[] = [];
		const commits: string[] = [];
		for (let version = 0; version < 3; version++) {
			const tree = await historian.create("trees", {
				tree: Array.from({ length: 3_500 }, (_, index) =>
					entry(`${version}-${index}`, "blob", blob),
				),
			});
			const previous = commits.at(-1);
			commits.push(await commit(historian, tree, previous ? [previous] : []));
			trees.push(tree);
		}
		const [first, second, latest] = commits;
		if (!first || !second || !latest)
			throw new Error("Summary history is incomplete");
		store.setRef("refs/heads/doc", latest);
		expect(await historian.versions("doc", 1)).toMatchObject([{ sha: latest }]);
		expect(await historian.versions("doc", 2)).toMatchObject([
			{ sha: latest },
			{ sha: second },
		]);
		expect(await historian.versions(first, 1)).toMatchObject([{ sha: first }]);
		await expect(historian.versions("doc", 3)).rejects.toMatchObject({
			status: 413,
		});

		bucket.objects.delete(JSON.stringify(["tenant", "trees", trees[0]]));
		expect(await historian.versions("doc", 2)).toMatchObject([
			{ sha: latest },
			{ sha: second },
		]);
		await expect(historian.versions(first, 1)).rejects.toMatchObject({
			status: 404,
		});

		bucket.objects.delete(JSON.stringify(["tenant", "trees", trees[2]]));
		expect(await historian.versions(second, 1)).toMatchObject([
			{ sha: second },
		]);
		await expect(historian.versions("doc", 1)).rejects.toMatchObject({
			status: 404,
		});
	});
});
