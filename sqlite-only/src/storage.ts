import {
	bytes,
	HttpError,
	MAX_DOCUMENT_BYTES,
	MAX_FRAME_BYTES,
} from "./common.js";
import type { HistorianBucket, HistorianStore } from "./historian.js";
import { type Operation, operation, type ProtocolEvent } from "./protocol.js";

interface State {
	sn: number;
	msn: number;
	handle: string;
	summarySn: number;
	initialHandle: string;
	initialSn: number;
	used: number;
	created: boolean;
	createdAt?: string;
	directoryRegistered?: boolean;
	sqliteDirectoryRegistered?: boolean;
}

export interface ClientRow extends Record<string, SqlStorageValue> {
	id: string;
	mode: string;
	csn: number;
	rsn: number;
	detail: string;
	expires: number;
	scopes: string;
}

export const CLEANUP_RESERVE = 1_048_576;

export class Storage implements HistorianStore, HistorianBucket {
	private readonly sql: SqlStorage;

	constructor(private readonly storage: DurableObjectStorage) {
		const sql = storage.sql;
		this.sql = sql;
		sql.exec(
			"CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id=1), body TEXT NOT NULL)",
		);
		sql.exec(
			"CREATE TABLE IF NOT EXISTS ops (sn INTEGER PRIMARY KEY, body TEXT NOT NULL)",
		);
		sql.exec(
			"CREATE INDEX IF NOT EXISTS ops_client_sequence ON ops (json_extract(body,'$.clientId'),json_extract(body,'$.clientSequenceNumber'),sn DESC)",
		);
		sql.exec(
			"CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, mode TEXT, csn INTEGER, rsn INTEGER, detail TEXT, expires INTEGER, scopes TEXT)",
		);
		sql.exec(
			"CREATE TABLE IF NOT EXISTS commits (sha TEXT PRIMARY KEY, body TEXT NOT NULL)",
		);
		sql.exec(
			"CREATE TABLE IF NOT EXISTS refs (name TEXT PRIMARY KEY, sha TEXT NOT NULL)",
		);
		sql.exec(
			"CREATE TABLE IF NOT EXISTS content (key TEXT PRIMARY KEY, size INTEGER NOT NULL)",
		);
		sql.exec(
			"CREATE TABLE IF NOT EXISTS content_objects (key TEXT NOT NULL, part INTEGER NOT NULL, body BLOB NOT NULL, PRIMARY KEY (key,part))",
		);
	}

	state(): State {
		const row = this.sql
			.exec<{ body: string }>("SELECT body FROM state WHERE id=1")
			.toArray()[0];
		if (row) {
			const state = JSON.parse(row.body) as State;
			if (
				typeof state.initialHandle !== "string" ||
				!Number.isSafeInteger(state.initialSn)
			)
				throw new HttpError(409, "Document state requires recreation");
			return state;
		}
		return {
			sn: 0,
			msn: 0,
			handle: "",
			summarySn: 0,
			initialHandle: "",
			initialSn: 0,
			used: 0,
			created: false,
		};
	}

	save(state: State): void {
		this.sql.exec(
			"INSERT OR REPLACE INTO state VALUES (1, ?)",
			JSON.stringify(state),
		);
	}

	usage() {
		const usedBytes = this.state().used;
		return {
			usedBytes,
			budgetBytes: MAX_DOCUMENT_BYTES,
			cleanupReserveBytes: CLEANUP_RESERVE,
			remainingWriteBytes: Math.max(
				0,
				MAX_DOCUMENT_BYTES - CLEANUP_RESERVE - usedBytes,
			),
		};
	}

	clients(): ClientRow[] {
		return this.sql
			.exec<ClientRow>("SELECT * FROM clients ORDER BY id")
			.toArray();
	}

	client(id: string): ClientRow | undefined {
		return this.sql
			.exec<ClientRow>("SELECT * FROM clients WHERE id=?", id)
			.toArray()[0];
	}

	putClient(client: ClientRow): void {
		this.sql.exec(
			"INSERT OR REPLACE INTO clients VALUES (?, ?, ?, ?, ?, ?, ?)",
			client.id,
			client.mode,
			client.csn,
			client.rsn,
			client.detail,
			client.expires,
			client.scopes,
		);
	}

	removeClient(id: string): void {
		this.sql.exec("DELETE FROM clients WHERE id=?", id);
	}

	checkpoint() {
		const state = this.state();
		return {
			sn: state.sn,
			msn: state.msn,
			clients: this.clients()
				.filter((c) => c.mode === "write")
				.map((c) => ({ id: c.id, csn: c.csn, rsn: c.rsn })),
		};
	}

	append(op: Operation, cleanup = false): void {
		const state = this.state();
		if (op.sequenceNumber !== state.sn + 1)
			throw new Error("Operation sequence is not contiguous");
		const body = JSON.stringify(op);
		const size = bytes(body);
		if (size > MAX_FRAME_BYTES)
			throw new HttpError(413, "Stored operation exceeds the message limit");
		if (
			state.used + size >
			MAX_DOCUMENT_BYTES - (cleanup ? 0 : CLEANUP_RESERVE)
		) {
			throw new HttpError(507, "Document storage budget exhausted");
		}
		this.sql.exec("INSERT INTO ops VALUES (?, ?)", op.sequenceNumber, body);
		this.save({
			...state,
			sn: op.sequenceNumber,
			msn: op.minimumSequenceNumber,
			used: state.used + size,
		});
	}

	getOp(sn: number): Operation | undefined {
		const row = this.sql
			.exec<{ body: string }>("SELECT body FROM ops WHERE sn=?", sn)
			.toArray()[0];
		return row ? operation(JSON.parse(row.body)) : undefined;
	}

	ops(from: number, to = Number.MAX_SAFE_INTEGER): ReadableStream<Uint8Array> {
		const upper = Math.min(to, this.state().sn + 1);
		const size = this.sql
			.exec<{ size: number }>(
				"SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0)+MAX(COUNT(*)-1,0)+2 AS size FROM ops WHERE sn>? AND sn<?",
				from,
				upper,
			)
			.toArray()[0]?.size;
		if (size === undefined || size > MAX_DOCUMENT_BYTES) {
			throw new HttpError(413, "Delta response exceeds the document budget");
		}
		const rows = this.sql
			.exec<{ body: string }>(
				"SELECT body FROM ops WHERE sn>? AND sn<? ORDER BY sn",
				from,
				upper,
			)
			[Symbol.iterator]();
		const encoder = new TextEncoder();
		let started = false;
		return new ReadableStream<Uint8Array>({
			pull(controller) {
				try {
					const row = rows.next();
					if (row.done) {
						controller.enqueue(encoder.encode(started ? "]" : "[]"));
						controller.close();
						return;
					}
					controller.enqueue(
						encoder.encode(`${started ? "," : "["}${row.value.body}`),
					);
					started = true;
				} catch (error) {
					console.error("Delta stream failed", error);
					controller.error(error);
				}
			},
		});
	}

	recent(): Operation[] {
		const output: Operation[] = [];
		let size = 0;
		for (const row of this.sql.exec<{ body: string }>(
			"SELECT body FROM ops ORDER BY sn DESC LIMIT 1000",
		)) {
			size += bytes(row.body);
			if (size > MAX_FRAME_BYTES / 2) break;
			output.unshift(operation(JSON.parse(row.body)));
		}
		return output;
	}

	protocolEvents(from: number, to: number): Iterable<ProtocolEvent> {
		return this.sql.exec<{
			sn: number;
			msn: number;
			kind: string;
			contents: string;
		}>(
			"SELECT sn,json_extract(body,'$.minimumSequenceNumber') AS msn,json_extract(body,'$.type') AS kind,CASE WHEN json_extract(body,'$.type')='propose' THEN json_quote(json_extract(body,'$.contents')) ELSE 'null' END AS contents FROM ops WHERE sn>? AND sn<=? ORDER BY sn",
			from,
			to,
		);
	}

	membersAt(reference: number): unknown[] {
		const members = new Map<string, unknown>();
		for (const row of this.sql.exec<{ sn: number; body: string }>(
			"SELECT sn,body FROM ops WHERE sn<=? AND json_extract(body,'$.type') IN ('join','leave') ORDER BY sn",
			reference,
		)) {
			const op = operation(JSON.parse(row.body));
			if (typeof op.data !== "string")
				throw new Error("Corrupt membership operation");
			const data: unknown = JSON.parse(op.data);
			if (op.type === "leave") {
				if (typeof data !== "string") throw new Error("Corrupt leave data");
				members.delete(data);
			} else {
				if (
					typeof data !== "object" ||
					data === null ||
					!("clientId" in data) ||
					typeof data.clientId !== "string" ||
					!("detail" in data)
				) {
					throw new Error("Corrupt join data");
				}
				members.set(data.clientId, {
					client: data.detail,
					sequenceNumber: row.sn,
				});
			}
		}
		return [...members];
	}

	getCommit(sha: string): string | undefined {
		return this.sql
			.exec<{ body: string }>("SELECT body FROM commits WHERE sha=?", sha)
			.toArray()[0]?.body;
	}

	putCommit(sha: string, body: string): void {
		this.storage.transactionSync(() => {
			if (this.getCommit(sha) !== undefined) return;
			const state = this.state();
			const size = bytes(body);
			if (
				size > MAX_FRAME_BYTES ||
				state.used + size > MAX_DOCUMENT_BYTES - CLEANUP_RESERVE
			) {
				throw new HttpError(507, "Document commit budget exhausted");
			}
			this.sql.exec("INSERT INTO commits VALUES (?, ?)", sha, body);
			this.save({ ...state, used: state.used + size });
		});
	}

	reserveContent(key: string, size: number): void {
		this.storage.transactionSync(() => {
			const prior = this.sql
				.exec<{ size: number }>("SELECT size FROM content WHERE key=?", key)
				.toArray()[0];
			if (prior) {
				if (prior.size !== size)
					throw new HttpError(409, "Content reservation size changed");
				return;
			}
			const state = this.state();
			if (state.used + size > MAX_DOCUMENT_BYTES - CLEANUP_RESERVE) {
				throw new HttpError(507, "Document content budget exhausted");
			}
			this.sql.exec("INSERT INTO content VALUES (?, ?)", key, size);
			this.save({ ...state, used: state.used + size });
		});
	}

	async get(key: string) {
		const rows = this.sql
			.exec<{ body: ArrayBuffer }>(
				"SELECT body FROM content_objects WHERE key=? ORDER BY part",
				key,
			)
			.toArray();
		if (!rows.length) return null;
		const data = new Uint8Array(
			rows.reduce((size, row) => size + row.body.byteLength, 0),
		);
		let offset = 0;
		for (const row of rows) {
			data.set(new Uint8Array(row.body), offset);
			offset += row.body.byteLength;
		}
		return {
			text: async () => new TextDecoder("utf-8", { fatal: true }).decode(data),
		};
	}

	async put(key: string, body: string) {
		return this.storage.transactionSync(() => {
			this.reserveContent(key, bytes(body));
			if (
				this.sql
					.exec("SELECT 1 FROM content_objects WHERE key=? LIMIT 1", key)
					.toArray().length
			)
				return null;
			const data = new TextEncoder().encode(body);
			// SQLite rows are limited to 2 MB; uploads can be up to 16 MiB.
			for (
				let offset = 0;
				offset < data.length || offset === 0;
				offset += MAX_FRAME_BYTES
			) {
				this.sql.exec(
					"INSERT INTO content_objects VALUES (?, ?, ?)",
					key,
					offset / MAX_FRAME_BYTES,
					data.subarray(offset, offset + MAX_FRAME_BYTES),
				);
			}
			return { etag: key };
		});
	}

	getRef(name: string): string | undefined {
		return this.sql
			.exec<{ sha: string }>("SELECT sha FROM refs WHERE name=?", name)
			.toArray()[0]?.sha;
	}

	setRef(name: string, sha: string): void {
		if (!this.getCommit(sha))
			throw new HttpError(404, "Commit does not belong to this document");
		if (this.listRefs().length >= 32 && !this.getRef(name))
			throw new HttpError(429, "Ref limit reached");
		this.sql.exec("INSERT OR REPLACE INTO refs VALUES (?, ?)", name, sha);
	}

	listRefs(): Array<{ ref: string; sha: string }> {
		return this.sql
			.exec<{ name: string; sha: string }>(
				"SELECT name,sha FROM refs ORDER BY name",
			)
			.toArray()
			.map(({ name, sha }) => ({ ref: name, sha }));
	}
}
