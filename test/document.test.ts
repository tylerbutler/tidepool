import { afterEach, expect, it, vi } from "vitest";
import type { Env } from "../src/common.js";
import { DocumentDO } from "../src/document.js";

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		constructor(
			readonly ctx: DurableObjectState,
			readonly env: Env,
		) {}
	},
}));

afterEach(() => vi.restoreAllMocks());

function socket(
	deadlines: Partial<{
		id: string;
		nextPing: number;
		pongDue: number;
		admissionDue: number;
	}> = {},
	readyState: number = WebSocket.OPEN,
): WebSocket {
	const state = {
		nextPing: 0,
		pongDue: 0,
		admissionDue: 0,
		window: Date.now(),
		count: 0,
		...deadlines,
	};
	const peer: Pick<
		WebSocket,
		| "readyState"
		| "deserializeAttachment"
		| "serializeAttachment"
		| "send"
		| "close"
	> = {
		readyState,
		deserializeAttachment: () => state,
		serializeAttachment: vi.fn(),
		send: vi.fn(),
		close: vi.fn(),
	};
	return peer as WebSocket;
}

function setup(
	sockets: WebSocket[],
	clients: Array<{ id: string; expires: number }> = [],
) {
	const cursor: Pick<
		SqlStorageCursor<Record<string, SqlStorageValue>>,
		"toArray"
	> = { toArray: () => clients };
	const exec = vi
		.fn<SqlStorage["exec"]>()
		.mockReturnValue(
			cursor as SqlStorageCursor<Record<string, SqlStorageValue>>,
		);
	const setAlarm = vi.fn();
	const deleteAlarm = vi.fn();
	const getWebSockets = vi.fn(() => sockets);
	const sql: Pick<SqlStorage, "exec"> = {
		exec: <T extends Record<string, SqlStorageValue>>(
			query: string,
			...bindings: SqlStorageValue[]
		) => exec(query, ...bindings) as SqlStorageCursor<T>,
	};
	const storage: Pick<
		DurableObjectStorage,
		"sql" | "setAlarm" | "deleteAlarm"
	> = {
		sql: sql as SqlStorage,
		setAlarm,
		deleteAlarm,
	};
	const ctx: Pick<
		DurableObjectState,
		"storage" | "getWebSockets" | "blockConcurrencyWhile"
	> = {
		storage: storage as DurableObjectStorage,
		getWebSockets,
		blockConcurrencyWhile: <T>(callback: () => Promise<T>) => callback(),
	};
	const document = new DocumentDO(ctx as DurableObjectState, {} as Env);
	exec.mockClear();
	return {
		exec,
		setAlarm,
		deleteAlarm,
		getWebSockets,
		schedule: () => document.webSocketMessage(socket(), "2"),
	};
}

it("reads clients once per scheduling pass and refreshes expiry without per-socket queries", async () => {
	vi.spyOn(Date, "now").mockReturnValue(1000);
	const clients = [
		{ id: "first", expires: 1300 },
		{ id: "second", expires: 1200 },
		{ id: "closed", expires: 1050 },
	];
	const test = setup(
		[
			socket({ id: "first", nextPing: 1500 }),
			socket({ id: "second", nextPing: 1600 }),
			socket({ id: "missing", admissionDue: 1400 }),
			socket({ id: "closed" }, WebSocket.CLOSED),
		],
		clients,
	);
	await test.schedule();
	expect(test.exec.mock.calls).toEqual([["SELECT * FROM clients ORDER BY id"]]);
	expect(test.getWebSockets).toHaveBeenCalledTimes(1);
	expect(test.setAlarm).toHaveBeenLastCalledWith(1200);
	clients[0] = { id: "first", expires: 1100 };
	await test.schedule();
	expect(test.exec).toHaveBeenCalledTimes(2);
	expect(test.setAlarm).toHaveBeenLastCalledWith(1100);
});

it.each([
	{ nextPing: 1500, pongDue: 1200, admissionDue: 1400, expected: 1200 },
	{ nextPing: 1500, pongDue: 0, admissionDue: 1100, expected: 1100 },
	{ nextPing: 900, pongDue: 0, admissionDue: 0, expected: 1000 },
])("schedules unauthenticated deadlines without reading clients: $expected", async ({
	expected,
	...deadlines
}) => {
	vi.spyOn(Date, "now").mockReturnValue(1000);
	const test = setup([socket(deadlines)]);
	await test.schedule();
	expect(test.exec).not.toHaveBeenCalled();
	expect(test.setAlarm).toHaveBeenCalledWith(expected);
});

it.each([
	"empty",
	"no-deadline",
	"closed",
	"missing-client",
])("deletes an unnecessary alarm for %s sockets", async (kind) => {
	const sockets =
		kind === "empty"
			? []
			: [
					socket(
						kind === "missing-client" ? { id: "missing" } : {},
						kind === "closed" ? WebSocket.CLOSED : WebSocket.OPEN,
					),
				];
	const test = setup(sockets);
	await test.schedule();
	expect(test.deleteAlarm).toHaveBeenCalledOnce();
	expect(test.setAlarm).not.toHaveBeenCalled();
	expect(test.exec).toHaveBeenCalledTimes(kind === "missing-client" ? 1 : 0);
});
