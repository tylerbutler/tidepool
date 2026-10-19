import {
	bytes,
	HttpError,
	integer,
	MAX_HTTP_BYTES,
	record,
	text,
} from "./common";
import { type ProtocolEvent, protocol } from "./protocol.js";

export interface HistorianStore {
	getCommit(sha: string): string | undefined;
	putCommit(sha: string, body: string): void;
	getRef(name: string): string | undefined;
	setRef(name: string, sha: string): void;
	listRefs(): Array<{ ref: string; sha: string }>;
	/** Atomically charge each immutable key once per document, including shared content and failed uploads. */
	reserveContent(key: string, size: number): void;
	protocolEvents(from: number, to: number): Iterable<ProtocolEvent>;
}

export interface HistorianBucket {
	get(key: string): Promise<Pick<R2ObjectBody, "text"> | null>;
	put(
		key: string,
		value: string,
		options?: R2PutOptions,
	): Promise<Pick<R2Object, "etag"> | null>;
}

type Kind = "blobs" | "trees" | "commits";
type Entry = {
	path: string;
	mode: string;
	type: "blob" | "tree" | "commit";
	sha: string;
	size?: number;
};
type Person = { name: string; email: string; date: string };
type Commit = {
	tree: string;
	parents: string[];
	message: string;
	author: Person;
	committer: Person;
};
type BlobBody = { content: string; encoding: string };
type Tree = { tree: Entry[] };
type Budget = {
	nodes: number;
	bytes?: number;
	verified?: Map<string, number>;
	content?: Map<string, number>;
};
const encoder = new TextEncoder();
const MAX_NODES = 10_000;
const MAX_DEPTH = 64;

function fail(message: string): never {
	throw new HttpError(400, message);
}

function string(value: unknown): string {
	if (typeof value !== "string") fail("Expected a string");
	return value;
}

function sha(value: unknown): string {
	const result = text(value);
	if (!/^[a-f0-9]{40}$/.test(result)) fail("Invalid object SHA");
	return result;
}

function array(value: unknown): unknown[] {
	if (!Array.isArray(value)) fail("Expected an array");
	return value;
}

function visit(budget: Budget, depth: number): void {
	if (++budget.nodes > MAX_NODES || depth > MAX_DEPTH) {
		throw new HttpError(413, "Object graph exceeds traversal limits");
	}
}

function parse(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		fail("Invalid JSON");
	}
}

function json(value: unknown): string {
	let result: string | undefined;
	try {
		result = JSON.stringify(value);
	} catch {
		fail("Invalid JSON value");
	}
	if (result === undefined) fail("Invalid JSON value");
	if (encoder.encode(result).byteLength > MAX_HTTP_BYTES) {
		throw new HttpError(413, "Object exceeds the upload limit");
	}
	return result;
}

function blobBytes(blob: BlobBody): Uint8Array {
	if (blob.encoding === "utf-8") return encoder.encode(blob.content);
	if (
		blob.encoding !== "base64" ||
		blob.content.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(blob.content)
	) {
		fail("Invalid blob encoding or base64 content");
	}
	let decoded: string;
	try {
		decoded = atob(blob.content);
	} catch {
		fail("Invalid base64 content");
	}
	if (btoa(decoded) !== blob.content) fail("Noncanonical base64 content");
	return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function person(input: unknown): Person {
	const value = record(input);
	const date = value.date ?? "";
	if (typeof date !== "string" && !Number.isSafeInteger(date))
		fail("Invalid author date");
	return {
		name: string(value.name ?? ""),
		email: string(value.email ?? ""),
		date: String(date),
	};
}

function normalize(kind: Kind, input: unknown): BlobBody | Tree | Commit {
	const value = record(input);
	if (kind === "blobs") {
		const blob = {
			content: string(value.content),
			encoding: string(value.encoding ?? "utf-8"),
		};
		blobBytes(blob);
		return blob;
	}
	if (kind === "trees") {
		const paths = new Set<string>();
		return {
			tree: array(value.tree).map((item) => {
				const entry = record(item);
				const path = text(entry.path);
				if (
					path.includes("\0") ||
					path
						.split("/")
						.some((part) => !part || part === "." || part === "..") ||
					paths.has(path)
				) {
					fail("Invalid or duplicate tree path");
				}
				paths.add(path);
				const type = entry.type ?? "blob";
				if (type !== "blob" && type !== "tree" && type !== "commit")
					fail("Invalid tree entry type");
				const mode = string(
					entry.mode ??
						(type === "tree"
							? "040000"
							: type === "commit"
								? "160000"
								: "100644"),
				);
				if (
					!(type === "tree"
						? mode === "040000"
						: type === "commit"
							? mode === "160000"
							: ["100644", "100755", "120000"].includes(mode))
				) {
					fail("Tree entry mode does not match its type");
				}
				const result: Entry = { path, mode, type, sha: sha(entry.sha) };
				if (entry.size !== undefined) result.size = integer(entry.size);
				return result;
			}),
		};
	}
	if (kind !== "commits") fail("Invalid object kind");
	const author = person(value.author);
	return {
		tree: sha(value.tree),
		parents: array(value.parents ?? []).map(sha),
		message: string(value.message ?? ""),
		author,
		committer: value.committer === undefined ? author : person(value.committer),
	};
}

async function objectId(kind: Kind, body: string): Promise<string> {
	let data = encoder.encode(body);
	if (kind === "blobs") {
		const content = blobBytes(normalize("blobs", parse(body)) as BlobBody);
		const header = encoder.encode(`blob ${content.byteLength}\0`);
		data = new Uint8Array(header.length + content.length);
		data.set(header);
		data.set(content, header.length);
	}
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", data));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

export class Historian {
	constructor(
		private readonly bucket: HistorianBucket,
		private readonly store: HistorianStore,
		private readonly tenant: string,
		private readonly document: string,
		private readonly baseUrl: string,
	) {}

	private key(kind: Kind, id: string): string {
		return JSON.stringify([this.tenant, kind, id]);
	}

	private url(kind: Kind, id: string): string {
		return `${this.baseUrl.replace(/\/$/, "")}/repos/${encodeURIComponent(this.tenant)}/git/${kind}/${id}`;
	}

	private async load(
		kind: Kind,
		id: string,
		budget?: Budget,
	): Promise<BlobBody | Tree | Commit> {
		if (kind !== "blobs" && kind !== "trees" && kind !== "commits")
			fail("Invalid object kind");
		sha(id);
		const body =
			kind === "commits"
				? this.store.getCommit(id)
				: await (await this.bucket.get(this.key(kind, id)))?.text();
		if (body === undefined)
			throw new HttpError(404, `${kind} object not found`);
		if (budget?.bytes !== undefined) {
			budget.bytes += bytes(body);
			if (budget.bytes > MAX_HTTP_BYTES)
				throw new HttpError(
					413,
					"Object reads exceed the aggregate byte limit",
				);
		}
		json(parse(body));
		if ((await objectId(kind, body)) !== id)
			throw new HttpError(500, "Stored object hash mismatch");
		const value = normalize(kind, parse(body));
		if (kind !== "commits")
			budget?.content?.set(this.key(kind, id), bytes(body));
		return value;
	}

	private async validateGraph(
		kind: Kind,
		id: string,
		budget: Budget,
		depth = 0,
		ancestors = new Set<string>(),
	): Promise<void> {
		visit(budget, depth);
		const key = `${kind}/${id}`;
		if (ancestors.has(key)) fail("Cycle in object graph");
		budget.verified ??= new Map<string, number>();
		const verified = budget.verified;
		if ((verified.get(key) ?? -1) >= depth) return;
		const next = new Set(ancestors).add(key);
		const value = await this.load(kind, id, budget);
		if (kind === "trees") {
			for (const entry of (value as Tree).tree) {
				await this.validateGraph(
					`${entry.type}s`,
					entry.sha,
					budget,
					depth + 1,
					next,
				);
			}
		} else if (kind === "commits") {
			const commit = value as Commit;
			await this.validateGraph("trees", commit.tree, budget, depth + 1, next);
		}
		verified.set(key, depth);
	}

	private reserveGraph(budget: Budget): void {
		// Keep reservations on failure so abandoned and shared content remain bounded.
		for (const [key, size] of budget.content ?? [])
			this.store.reserveContent(key, size);
	}

	async create(kind: Kind, input: unknown): Promise<string> {
		json(input);
		const value = normalize(kind, input);
		// Silt hashes tree/commit JSON directly, without Git framing or key sorting.
		const body = json(kind === "blobs" ? value : input);
		const budget: Budget = { nodes: 0, content: new Map<string, number>() };
		if (kind === "trees") {
			for (const entry of (value as Tree).tree) {
				await this.validateGraph(`${entry.type}s`, entry.sha, budget);
			}
		} else if (kind === "commits") {
			const commit = value as Commit;
			await this.validateGraph("trees", commit.tree, budget);
			for (const parent of commit.parents)
				await this.validateGraph("commits", parent, budget);
		}
		const id = await objectId(kind, body);
		if (kind === "commits") {
			const existing = this.store.getCommit(id);
			if (existing !== undefined && existing !== body)
				throw new HttpError(500, "Commit content conflict");
			this.reserveGraph(budget);
			this.store.putCommit(id, body);
		} else {
			const key = this.key(kind, id);
			const existing = await this.bucket.get(key);
			const storedBody = existing ? await existing.text() : body;
			if (existing) {
				if ((await objectId(kind, storedBody)) !== id)
					throw new HttpError(500, "Content conflict");
				normalize(kind, parse(storedBody));
			}
			budget.content?.set(key, bytes(storedBody));
			this.reserveGraph(budget);
			if (!existing) {
				const written = await this.bucket.put(key, body, {
					onlyIf: { etagDoesNotMatch: "*" },
				});
				if (written === null) {
					// Another document can upload the same tenant object concurrently.
					await this.load(kind, id, budget);
					this.reserveGraph(budget);
				}
			}
		}
		return id;
	}

	private hashResponse(kind: Kind, id: string) {
		return { sha: id, url: this.url(kind, id) };
	}

	private commitResponse(id: string, commit: Commit, details = false) {
		const url = this.url("commits", id);
		const body = {
			url,
			author: commit.author,
			committer: commit.committer,
			message: commit.message,
			tree: this.hashResponse("trees", commit.tree),
		};
		const parents = commit.parents.map((parent) =>
			this.hashResponse("commits", parent),
		);
		return details
			? { sha: id, url, commit: body, parents }
			: { sha: id, ...body, parents };
	}

	async get(kind: Kind, id: string, recursive = false): Promise<unknown> {
		const budget = { nodes: 0, bytes: 0 };
		const value = await this.load(kind, id, budget);
		if (kind === "blobs") {
			const blob = value as BlobBody;
			const response = {
				sha: id,
				size: blobBytes(blob).byteLength,
				...blob,
				url: this.url(kind, id),
			};
			json(response);
			return response;
		}
		if (kind === "commits") {
			const response = this.commitResponse(id, value as Commit);
			json(response);
			return response;
		}
		const tree: unknown[] = [];
		let responseBytes = 0;
		const walk = async (
			entries: Entry[],
			prefix: string,
			depth: number,
			ancestors: Set<string>,
		): Promise<void> => {
			for (const entry of entries) {
				visit(budget, depth);
				const path = prefix + entry.path;
				const item = {
					...entry,
					path,
					size: entry.size ?? 0,
					url: this.url(`${entry.type}s`, entry.sha),
				};
				responseBytes += bytes(json(item)) + 1;
				if (responseBytes > MAX_HTTP_BYTES)
					throw new HttpError(
						413,
						"Tree response exceeds the aggregate byte limit",
					);
				tree.push(item);
				if (recursive && entry.type === "tree") {
					if (ancestors.has(entry.sha)) fail("Cycle in tree");
					const child = (await this.load("trees", entry.sha, budget)) as Tree;
					await walk(
						child.tree,
						`${path}/`,
						depth + 1,
						new Set(ancestors).add(entry.sha),
					);
				}
			}
		};
		await walk((value as Tree).tree, "", 0, new Set([id]));
		const response = { sha: id, url: this.url(kind, id), tree };
		json(response);
		return response;
	}

	async versions(requested: string, count: number): Promise<unknown[]> {
		if (!Number.isInteger(count) || count < 1 || count > 1000)
			fail("Count must be an integer from 1 to 1000");
		const head = this.store.getRef(`refs/heads/${this.document}`);
		if (!head) {
			if (requested === this.document) return [];
			throw new HttpError(404, "Published version not found");
		}
		if (requested !== this.document) sha(requested);
		let current: string | undefined = head;
		const seen = new Set<string>();
		const result: unknown[] = [];
		const budget = { nodes: 0, bytes: 0 };
		let responseBytes = 2;
		let found = requested === this.document;
		while (current && result.length < count) {
			if (seen.has(current)) fail("Cycle in published history");
			seen.add(current);
			if (seen.size > MAX_NODES)
				throw new HttpError(413, "Commit history exceeds traversal limit");
			const commit = (await this.load("commits", current, budget)) as Commit;
			if (current === requested) found = true;
			if (found) {
				await this.validateGraph("trees", commit.tree, budget);
				const version = this.commitResponse(current, commit, true);
				responseBytes += bytes(json(version)) + (result.length > 0 ? 1 : 0);
				if (responseBytes > MAX_HTTP_BYTES)
					throw new HttpError(
						413,
						"Version response exceeds the aggregate byte limit",
					);
				result.push(version);
			}
			current = commit.parents[0];
		}
		if (!found) throw new HttpError(404, "Published version not found");
		return result;
	}

	private entry(path: string, type: "blob" | "tree", id: string): Entry {
		return { path, mode: type === "tree" ? "040000" : "100644", type, sha: id };
	}

	private async summaryTree(
		input: unknown,
		budget: Budget,
		depth = 0,
	): Promise<string> {
		visit(budget, depth);
		const value = record(input);
		if (value.type !== undefined && value.type !== "tree")
			fail("Summary must be a tree");
		const entries: Entry[] = [];
		for (const item of array(value.entries)) {
			const entry = record(item);
			const path = text(entry.path);
			if (entry.type !== "tree" && entry.type !== "blob")
				fail("Invalid summary entry type");
			if ((entry.id === undefined) === (entry.value === undefined))
				fail("Summary entry needs exactly one value or id");
			let id: string;
			if (entry.id !== undefined) {
				id = sha(entry.id);
				await this.validateGraph(`${entry.type}s`, id, budget, depth + 1);
			} else if (entry.type === "tree") {
				id = await this.summaryTree(entry.value, budget, depth + 1);
			} else {
				visit(budget, depth + 1);
				const blob = record(entry.value);
				if (blob.type !== undefined && blob.type !== "blob")
					fail("Summary blob type mismatch");
				id = await this.create("blobs", blob);
			}
			entries.push(this.entry(path, entry.type, id));
		}
		return this.create("trees", { tree: entries });
	}

	private async protocol(
		reference: number,
		minimum: number,
		members: unknown[],
		quorum: { proposals: unknown[]; values: unknown[] },
	): Promise<string> {
		const entries: Entry[] = [];
		for (const [path, value] of [
			[
				"attributes",
				{ minimumSequenceNumber: minimum, sequenceNumber: reference },
			],
			["quorumMembers", members],
			["quorumProposals", quorum.proposals],
			["quorumValues", quorum.values],
		] as const) {
			const id = await this.create("blobs", {
				content: json(value),
				encoding: "utf-8",
			});
			entries.push(this.entry(path, "blob", id));
		}
		return this.create("trees", { tree: entries });
	}

	private newCommit(
		tree: string,
		parents: string[],
		message: string,
	): Promise<string> {
		const author = {
			name: "Tidepool",
			email: "server@tidepool.local",
			date: String(Math.floor(Date.now() / 1000)),
		};
		return this.create("commits", {
			tree,
			parents,
			message,
			author,
			committer: author,
		});
	}

	async initialize(
		body: Record<string, unknown>,
	): Promise<{ handle: string; sequenceNumber: number }> {
		record(body);
		if (body.summary === undefined || body.summary === null)
			return { handle: "", sequenceNumber: 0 };
		json(body);
		const sequenceNumber = integer(body.sequenceNumber ?? 0);
		const quorum = protocol.quorum(body.values ?? [], sequenceNumber, []);
		const app = await this.summaryTree(body.summary, { nodes: 0 });
		const protocolTree = await this.protocol(
			sequenceNumber,
			sequenceNumber,
			[],
			quorum,
		);
		const root = await this.create("trees", {
			tree: [
				this.entry(".app", "tree", app),
				this.entry(".protocol", "tree", protocolTree),
			],
		});
		return {
			handle: await this.newCommit(root, [], "Initial summary"),
			sequenceNumber,
		};
	}

	async prepareSummary(
		contents: unknown,
		reference: number,
		minimum: number,
		members: unknown[],
		head: string,
		initial: { handle: string; sequenceNumber: number },
	): Promise<string> {
		integer(reference);
		integer(minimum);
		if (minimum > reference) fail("Minimum sequence number exceeds reference");
		for (const member of array(members)) {
			const tuple = array(member);
			if (tuple.length !== 2) fail("Invalid quorum member");
			text(tuple[0]);
			const value = record(tuple[1]);
			record(value.client);
			if (integer(value.sequenceNumber) > reference)
				fail("Quorum member is newer than the summary reference");
		}
		json(contents);
		const summary = record(
			typeof contents === "string" ? parse(contents) : contents,
		);
		const expected = head ? [sha(head)] : [];
		if (
			head !== (this.store.getRef(`refs/heads/${this.document}`) ?? "") ||
			summary.head !== head ||
			json(array(summary.parents)) !== json(expected)
		) {
			throw new HttpError(
				409,
				"Summary head and parents must match the published head",
			);
		}
		const app = sha(summary.handle);
		await this.validateGraph("trees", app, { nodes: 0 });
		integer(initial.sequenceNumber);
		if (reference < initial.sequenceNumber)
			fail("Summary reference precedes the initial checkpoint");
		let values: unknown = [];
		if (initial.handle) {
			const baseline = (await this.load("commits", initial.handle)) as Commit;
			const root = (await this.load("trees", baseline.tree)) as Tree;
			const entry = root.tree.find((item) => item.path === ".protocol");
			if (!entry || entry.type !== "tree")
				throw new Error("Initial protocol tree is missing");
			const tree = (await this.load("trees", entry.sha)) as Tree;
			const value = tree.tree.find((item) => item.path === "quorumValues");
			if (!value || value.type !== "blob")
				throw new Error("Initial quorum values are missing");
			const blob = (await this.load("blobs", value.sha)) as BlobBody;
			values = parse(
				new TextDecoder("utf-8", { fatal: true }).decode(blobBytes(blob)),
			);
		}
		const quorum = protocol.quorum(
			values,
			initial.sequenceNumber,
			this.store.protocolEvents(initial.sequenceNumber, reference),
		);
		if (quorum.sequenceNumber !== reference)
			throw new Error("Protocol history is incomplete");
		const protocolTree = await this.protocol(
			reference,
			quorum.minimumSequenceNumber,
			members,
			quorum,
		);
		const tree = await this.create("trees", {
			tree: [
				this.entry(".app", "tree", app),
				this.entry(".protocol", "tree", protocolTree),
			],
		});
		return this.newCommit(tree, expected, string(summary.message ?? ""));
	}
}
