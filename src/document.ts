import { DurableObject } from "cloudflare:workers";
import { requestToken, verify } from "./auth.js";
import {
	bytes,
	type Env,
	errorResponse,
	HttpError,
	integer,
	MAX_CLIENTS,
	MAX_FRAME_BYTES,
	PING_INTERVAL_MS,
	PING_TIMEOUT_MS,
	RETRY_AFTER_MS,
	readJson,
	record,
	text,
} from "./common.js";
import { Historian } from "./historian.js";
import { type Operation, operation, protocol } from "./protocol.js";
import { type ClientRow, Storage } from "./storage.js";

interface Attachment {
	tenant: string;
	document: string;
	sid: string;
	id?: string;
	joining?: boolean;
	nextPing: number;
	pongDue: number;
	admissionDue: number;
	window: number;
	count: number;
}

function attachment(socket: WebSocket): Attachment {
	return socket.deserializeAttachment() as Attachment;
}

function emit(socket: WebSocket, event: string, ...args: unknown[]): void {
	socket.send(`42${JSON.stringify([event, ...args])}`);
}

export class DocumentDO extends DurableObject<Env> {
	private readonly store: Storage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.store = new Storage(ctx.storage);
	}

	private historian(tenant: string, document: string, origin: string) {
		return new Historian(
			this.env.CONTENT,
			this.store,
			tenant,
			document,
			origin,
		);
	}

	async fetch(request: Request): Promise<Response> {
		try {
			const url = new URL(request.url);
			if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
				if (url.searchParams.get("EIO") !== "4")
					throw new HttpError(400, "Engine.IO 4 required");
				if (this.ctx.getWebSockets().length >= MAX_CLIENTS)
					throw new HttpError(429, "Document connection limit reached");
				const pair = new WebSocketPair();
				const socket = pair[1];
				this.ctx.acceptWebSocket(socket);
				const state: Attachment = {
					tenant: text(url.searchParams.get("tenantId")),
					document: text(url.searchParams.get("documentId")),
					sid: crypto.randomUUID(),
					nextPing: Date.now() + PING_INTERVAL_MS,
					pongDue: 0,
					admissionDue: Date.now() + 20_000,
					window: Date.now(),
					count: 0,
				};
				socket.serializeAttachment(state);
				socket.send(protocol.open(state.sid));
				await this.scheduleAlarm();
				return new Response(null, { status: 101, webSocket: pair[0] });
			}
			const tenant = text(request.headers.get("X-Tidepool-Tenant"));
			const document = text(request.headers.get("X-Tidepool-Document"));
			const write = request.method !== "GET" && request.method !== "HEAD";
			const create =
				url.pathname === `/documents/${encodeURIComponent(tenant)}`;
			const scopes = create
				? ["doc:read", "doc:write"]
				: write
					? ["doc:read", "summary:write"]
					: ["doc:read"];
			const claims = await verify(
				requestToken(request),
				this.env,
				tenant,
				create ? undefined : document,
				scopes,
			);
			if (create && claims.documentId !== "" && claims.documentId !== document)
				throw new HttpError(401, "Document identity mismatch");
			return await this.rest(request, tenant, document);
		} catch (error) {
			return errorResponse(error);
		}
	}

	async webSocketMessage(
		socket: WebSocket,
		input: string | ArrayBuffer,
	): Promise<void> {
		// Keep a client's summary upload from being overtaken by its next CSN.
		await this.ctx.blockConcurrencyWhile(async () => {
			let event = "";
			try {
				if (typeof input !== "string" || bytes(input) > MAX_FRAME_BYTES) {
					throw new HttpError(413, "Text frame exceeds the message limit");
				}
				const a = attachment(socket);
				if (Date.now() - a.window >= 1000) {
					a.window = Date.now();
					a.count = 0;
				}
				if (++a.count > 1000) throw new HttpError(429, "Message rate exceeded");
				socket.serializeAttachment(a);
				let ackId: string | undefined;
				const withAck = /^42([0-9]{1,10})(\[.*)$/s.exec(input);
				if (withAck) {
					ackId = withAck[1];
					input = `42${withAck[2]}`;
				}
				const frame = protocol.frame(input);
				event = frame.event;
				if (event === "socketConnect") {
					socket.send(`40${JSON.stringify({ sid: a.sid })}`);
				} else if (event === "socketDisconnect") {
					this.disconnect(socket);
					socket.close(1000, "Client disconnected");
				} else if (event === "enginePong") {
					a.pongDue = 0;
					a.nextPing = Date.now() + PING_INTERVAL_MS;
					socket.serializeAttachment(a);
				} else if (event === "enginePing") {
					socket.send("3");
				} else if (event === "connect_document") {
					await this.admitSocket(socket, a, frame.args[0]);
				} else {
					if (!a.id)
						throw new HttpError(401, "Connect before submitting messages");
					const client = this.store.client(a.id);
					if (!client || client.expires <= Date.now())
						throw new HttpError(401, "Session expired");
					if (event === "submitOp" || event === "submitSignal") {
						if (frame.args[0] !== a.id || !Array.isArray(frame.args[1]))
							throw new HttpError(400, "Invalid client or batch");
						if (event === "submitOp") {
							const batches = frame.args[1] as unknown[];
							for (const item of batches) {
								for (const op of Array.isArray(item) ? item : [item]) {
									await this.submit(socket, a, record(op));
								}
							}
						} else {
							const roster = this.store.clients().map((c) => c.id);
							for (const signal of protocol.signals(
								frame.args[1],
								a.id,
								roster,
							)) {
								for (const peer of this.ctx.getWebSockets()) {
									const id = attachment(peer).id;
									if (id && signal.recipients.includes(id))
										this.send(peer, "signal", signal.message);
								}
							}
						}
					} else if (event === "client_disconnect") {
						this.disconnect(socket);
						socket.close(1000, "Client disconnected");
					} else if (event !== "ping") {
						throw new HttpError(400, "Unsupported event");
					}
					if (ackId) socket.send(`43${ackId}[]`);
				}
				await this.scheduleAlarm();
			} catch (error) {
				const status = error instanceof HttpError ? error.status : 503;
				const message =
					error instanceof HttpError
						? error.message
						: "Storage or runtime failure";
				const retryAfterMs =
					error instanceof HttpError ? undefined : RETRY_AFTER_MS;
				console.error("Document event rejected", { event, status, error });
				if (event === "submitOp") {
					this.send(socket, "nack", attachment(socket).document, [
						{
							operation: null,
							sequenceNumber: this.store.state().sn,
							content: {
								code: status,
								type: "BadRequestError",
								message,
								retryAfter:
									retryAfterMs === undefined ? undefined : retryAfterMs / 1000,
							},
						},
					]);
				} else {
					this.send(socket, "connect_document_error", {
						code: status,
						message,
						retryAfterMs,
					});
					this.disconnect(socket);
					socket.close(status === 413 ? 1009 : 1008, message.slice(0, 100));
				}
			}
		});
	}

	private async admitSocket(
		socket: WebSocket,
		a: Attachment,
		input: unknown,
	): Promise<void> {
		if (a.id || a.joining) throw new HttpError(409, "Socket already joined");
		a.joining = true;
		socket.serializeAttachment(a);
		const raw = record(input);
		const claims = await verify(
			text(raw.token),
			this.env,
			a.tenant,
			a.document,
			["doc:read"],
		);
		const join = protocol.admit(raw, claims.scopes);
		if (join.tenant !== a.tenant || join.document !== a.document)
			throw new HttpError(401, "Routing and join identity mismatch");
		if (!this.store.state().created)
			throw new HttpError(404, "Document does not exist");
		this.reconcile(a.document);
		const id = crypto.randomUUID();
		const supplied = {
			...record(raw.client),
			user: claims.user,
			scopes: claims.scopes,
			mode: join.mode,
		};
		const detail = JSON.stringify(supplied);
		if (bytes(detail) > 8192)
			throw new HttpError(413, "Client metadata exceeds limit");
		const client: ClientRow = {
			id,
			mode: join.mode,
			csn: 0,
			rsn: this.store.state().sn,
			detail,
			expires: Number(claims.exp) * 1000,
			scopes: JSON.stringify(claims.scopes),
		};
		const initialClients = this.store
			.clients()
			.map((c) => ({ clientId: c.id, client: JSON.parse(c.detail) }));
		let joined: Operation | undefined;
		this.ctx.storage.transactionSync(() => {
			this.store.putClient(client);
			if (join.mode === "write") {
				joined = protocol.system(this.store.checkpoint(), "join", {
					clientId: id,
					detail: supplied,
				});
				this.store.append(joined);
			}
		});
		a.id = id;
		a.joining = false;
		a.admissionDue = 0;
		socket.serializeAttachment(a);
		const state = this.store.state();
		const initialSignals = [
			{
				clientId: null,
				content: JSON.stringify({
					type: "join",
					content: { clientId: id, client: supplied },
				}),
			},
		];
		emit(socket, "connect_document_success", {
			claims,
			clientId: id,
			existing: true,
			mode: join.mode,
			maxMessageSize: MAX_FRAME_BYTES,
			serviceConfiguration: {
				blockSize: 65536,
				maxMessageSize: MAX_FRAME_BYTES,
			},
			initialClients,
			initialMessages: this.store.recent(),
			initialSignals,
			version: "0.1.0",
			supportedVersions: ["^0.1.0"],
			supportedFeatures: { submit_signals_v2: true },
			checkpointSequenceNumber: state.sn,
			summaryHandle: state.handle,
			summarySequenceNumber: state.summarySn,
		});
		if (joined) this.broadcast("op", a.document, [joined]);
		this.broadcast("signal", initialSignals[0]);
	}

	private async submit(
		socket: WebSocket,
		a: Attachment,
		raw: Record<string, unknown>,
	): Promise<void> {
		if (!a.id) throw new HttpError(401, "Missing client");
		const client = this.store.client(a.id);
		if (!client) throw new HttpError(401, "Unknown client");
		const serialized = JSON.stringify(raw);
		if (raw.clientSequenceNumber === client.csn) {
			const prior = this.findDuplicate(a.id, client.csn);
			if (
				prior &&
				prior.referenceSequenceNumber === raw.referenceSequenceNumber &&
				prior.type === raw.type &&
				["contents", "metadata", "compression", "traces"].every(
					(key) =>
						JSON.stringify(prior[key] ?? null) ===
						JSON.stringify(raw[key] ?? null),
				)
			) {
				const messages = [prior];
				if (prior.type === "summarize") {
					const response = this.store.getOp(prior.sequenceNumber + 1);
					if (
						response &&
						(response.type === "summaryAck" || response.type === "summaryNack")
					)
						messages.push(response);
				}
				this.send(socket, "op", a.document, messages);
				return;
			}
		}
		const op = protocol.assign(
			this.store.checkpoint(),
			a.id,
			client.mode,
			raw,
			bytes(serialized),
		);
		let handle: string | undefined;
		let summaryError: string | undefined;
		let expectedHead: string | undefined;
		if (op.type === "summarize") {
			if (!(JSON.parse(client.scopes) as string[]).includes("summary:write"))
				throw new HttpError(401, "Summary scope required");
			const state = this.store.state();
			expectedHead = state.handle;
			try {
				handle = await this.historian(
					a.tenant,
					a.document,
					"https://tidepool.invalid",
				).prepareSummary(
					raw.contents,
					op.referenceSequenceNumber,
					state.msn,
					this.store.membersAt(op.referenceSequenceNumber),
					state.handle,
					{ handle: state.initialHandle, sequenceNumber: state.initialSn },
				);
			} catch (error) {
				if (!(error instanceof HttpError) || error.status >= 500) throw error;
				summaryError = error.message;
			}
		}
		const messages: Operation[] = [op];
		this.ctx.storage.transactionSync(() => {
			if (handle && this.store.state().handle !== expectedHead) {
				handle = undefined;
				summaryError = "Summary head changed during upload";
			}
			this.store.append(op);
			this.store.putClient({
				...client,
				csn: op.clientSequenceNumber,
				rsn: op.referenceSequenceNumber,
			});
			if (op.type === "summarize") {
				const response = handle
					? protocol.ack(handle, op.sequenceNumber, op.minimumSequenceNumber)
					: operation({
							clientId: null,
							clientSequenceNumber: -1,
							referenceSequenceNumber: op.sequenceNumber,
							sequenceNumber: op.sequenceNumber + 1,
							minimumSequenceNumber: op.minimumSequenceNumber,
							type: "summaryNack",
							timestamp: Date.now(),
							contents: {
								message: summaryError,
								summaryProposal: { summarySequenceNumber: op.sequenceNumber },
							},
						});
				this.store.append(response);
				messages.push(response);
				if (handle) {
					this.store.setRef(`refs/heads/${a.document}`, handle);
					this.store.save({
						...this.store.state(),
						handle,
						summarySn: op.referenceSequenceNumber,
					});
				}
			}
		});
		this.broadcast("op", a.document, messages);
	}

	private findDuplicate(id: string, csn: number): Operation | undefined {
		const row = this.ctx.storage.sql
			.exec<{ body: string }>(
				"SELECT body FROM ops WHERE json_extract(body,'$.clientId')=? AND json_extract(body,'$.clientSequenceNumber')=? ORDER BY sn DESC LIMIT 1",
				id,
				csn,
			)
			.toArray()[0];
		return row ? operation(JSON.parse(row.body)) : undefined;
	}

	private disconnect(socket: WebSocket): void {
		const a = attachment(socket);
		if (!a.id) return;
		const id = a.id;
		const client = this.store.client(id);
		let leave: Operation | undefined;
		this.ctx.storage.transactionSync(() => {
			this.store.removeClient(id);
			if (client?.mode === "write") {
				leave = protocol.system(this.store.checkpoint(), "leave", id);
				this.store.append(leave, true);
			}
		});
		delete a.id;
		socket.serializeAttachment(a);
		if (leave) this.broadcast("op", a.document, [leave]);
		this.broadcast("signal", {
			clientId: null,
			content: JSON.stringify({ type: "leave", content: id }),
		});
	}

	private reconcile(document: string): void {
		const live = new Set(
			this.ctx
				.getWebSockets()
				.filter((s) => s.readyState === WebSocket.OPEN)
				.map((s) => attachment(s).id),
		);
		for (const client of this.store.clients()) {
			if (!live.has(client.id)) {
				let leave: Operation | undefined;
				this.ctx.storage.transactionSync(() => {
					this.store.removeClient(client.id);
					if (client.mode === "write") {
						leave = protocol.system(
							this.store.checkpoint(),
							"leave",
							client.id,
						);
						this.store.append(leave, true);
					}
				});
				if (leave) this.broadcast("op", document, [leave]);
				this.broadcast("signal", {
					clientId: null,
					content: JSON.stringify({ type: "leave", content: client.id }),
				});
			}
		}
	}

	async webSocketClose(socket: WebSocket): Promise<void> {
		this.disconnect(socket);
		socket.close();
		await this.scheduleAlarm();
	}

	async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
		console.error("Document socket error", error);
		this.disconnect(socket);
		socket.close(1011, "Socket error");
		await this.scheduleAlarm();
	}

	private send(socket: WebSocket, event: string, ...args: unknown[]): void {
		try {
			emit(socket, event, ...args);
		} catch (error) {
			console.error(
				"Document fan-out failed; closing peer for catch-up",
				error,
			);
			socket.close(1011, "Catch-up required");
		}
	}

	private broadcast(event: string, ...args: unknown[]): void {
		for (const socket of this.ctx.getWebSockets()) {
			if (attachment(socket).id) this.send(socket, event, ...args);
		}
	}

	private async scheduleAlarm(): Promise<void> {
		const deadlines = this.ctx
			.getWebSockets()
			.filter((socket) => socket.readyState === WebSocket.OPEN)
			.flatMap((socket) => {
				const a = attachment(socket);
				const expires = a.id ? this.store.client(a.id)?.expires : undefined;
				return [a.nextPing, a.pongDue, a.admissionDue, expires ?? 0].filter(
					(v) => v > 0,
				);
			});
		if (deadlines.length > 0)
			await this.ctx.storage.setAlarm(
				Math.max(Date.now(), Math.min(...deadlines)),
			);
		else await this.ctx.storage.deleteAlarm();
	}

	async alarm(): Promise<void> {
		const now = Date.now();
		for (const socket of this.ctx.getWebSockets()) {
			if (socket.readyState !== WebSocket.OPEN) continue;
			const a = attachment(socket);
			const client = a.id ? this.store.client(a.id) : undefined;
			if (
				(a.admissionDue && now >= a.admissionDue) ||
				(a.pongDue && now >= a.pongDue) ||
				(client && now >= client.expires)
			) {
				this.disconnect(socket);
				socket.close(1008, "Session or heartbeat expired");
				delete a.id;
				a.nextPing = 0;
				a.pongDue = 0;
				a.admissionDue = 0;
			} else if (a.nextPing && now >= a.nextPing) {
				socket.send("2");
				a.nextPing = 0;
				a.pongDue = now + PING_TIMEOUT_MS;
			}
			socket.serializeAttachment(a);
		}
		await this.scheduleAlarm();
	}

	private async rest(
		request: Request,
		tenant: string,
		document: string,
	): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname
			.split("/")
			.filter(Boolean)
			.map(decodeURIComponent);
		const historian = this.historian(tenant, document, url.origin);
		if (
			request.method === "POST" &&
			path[0] === "documents" &&
			path.length === 2
		) {
			if (this.store.state().created)
				throw new HttpError(409, "Document already exists");
			const body = record(await readJson(request));
			const initial = await historian.initialize(body);
			this.ctx.storage.transactionSync(() => {
				if (this.store.state().created)
					throw new HttpError(409, "Document already exists");
				this.store.save({
					...this.store.state(),
					created: true,
					sn: initial.sequenceNumber,
					msn: initial.sequenceNumber,
					handle: initial.handle,
					summarySn: initial.sequenceNumber,
					initialHandle: initial.handle,
					initialSn: initial.sequenceNumber,
				});
				if (initial.handle)
					this.store.setRef(`refs/heads/${document}`, initial.handle);
			});
			return Response.json(
				body.enableDiscovery
					? { id: document, session: this.session(url.origin, tenant) }
					: document,
				{ status: 201 },
			);
		}
		if (!this.store.state().created)
			throw new HttpError(404, "Document does not exist");
		if (
			request.method === "GET" &&
			path[0] === "documents" &&
			path.length === 4 &&
			path[2] === "session" &&
			path[3] === document
		)
			return Response.json(this.session(url.origin, tenant));
		if (
			request.method === "GET" &&
			((path[0] === "deltas" && path.length === 3 && path[2] === document) ||
				(path[0] === "documents" &&
					path.length === 4 &&
					path[2] === document &&
					path[3] === "deltas"))
		) {
			const from = integer(Number(url.searchParams.get("from") ?? 0));
			const to = url.searchParams.has("to")
				? integer(Number(url.searchParams.get("to")))
				: undefined;
			return new Response(this.store.ops(from, to), {
				headers: { "Content-Type": "application/json" },
			});
		}
		if (
			request.method === "GET" &&
			path[0] === "documents" &&
			path.length === 3 &&
			path[2] === document
		)
			return Response.json({
				id: document,
				tenantId: tenant,
				sequenceNumber: this.store.state().sn,
			});
		if (
			path[0] === "repos" &&
			path[2] === "commits" &&
			request.method === "GET"
		) {
			const sha = text(url.searchParams.get("sha"));
			const count = integer(Number(url.searchParams.get("count") ?? 1));
			return Response.json(await historian.versions(sha, count));
		}
		if (path[0] === "repos" && path[2] === "git") {
			const kind = path[3];
			if (kind === "blobs" || kind === "trees" || kind === "commits") {
				if (request.method === "POST" && path.length === 4) {
					const sha = await historian.create(kind, await readJson(request));
					return Response.json(await historian.get(kind, sha), { status: 201 });
				}
				if (request.method === "GET" && path.length === 5)
					return Response.json(
						await historian.get(
							kind,
							text(path[4]),
							url.searchParams.get("recursive") === "1",
						),
					);
			}
			if (kind === "refs") {
				const name =
					path.length > 4 ? `refs/${path.slice(4).join("/")}` : undefined;
				const own = `refs/heads/${document}`;
				if (name?.startsWith("refs/heads/") && name !== own)
					throw new HttpError(404, "Foreign document ref");
				const shape = (ref: string, sha: string) => ({
					ref,
					url: `${url.origin}/repos/${tenant}/git/${ref}`,
					object: {
						sha,
						type: "commit",
						url: `${url.origin}/repos/${tenant}/git/commits/${sha}`,
					},
				});
				if (request.method === "GET") {
					if (!name)
						return Response.json(
							this.store.listRefs().map(({ ref, sha }) => shape(ref, sha)),
						);
					const sha = this.store.getRef(name);
					if (!sha) throw new HttpError(404, "Ref not found");
					return Response.json(shape(name, sha));
				}
				if (request.method === "POST" || request.method === "PATCH") {
					const body = record(await readJson(request));
					const ref = name ?? text(body.ref);
					if (!ref.startsWith("refs/") || ref.length > 256)
						throw new HttpError(400, "Invalid ref");
					if (ref === own || ref.startsWith("refs/heads/"))
						throw new HttpError(
							409,
							"Published heads are managed by summaries",
						);
					const sha = text(body.sha);
					if (request.method === "POST" && this.store.getRef(ref))
						throw new HttpError(409, "Ref exists");
					this.ctx.storage.transactionSync(() => this.store.setRef(ref, sha));
					return Response.json(shape(ref, sha), {
						status: request.method === "POST" ? 201 : 200,
					});
				}
			}
		}
		throw new HttpError(404, "Unsupported prototype route");
	}

	private session(base: string, tenant: string) {
		return {
			ordererUrl: base,
			historianUrl: `${base}/repos/${tenant}`,
			deltaStreamUrl: base,
			isSessionAlive: true,
			isSessionActive: true,
		};
	}
}
