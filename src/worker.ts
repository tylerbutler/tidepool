import { configuration, originAllowed, requestToken, verify } from "./auth.js";
import {
	bytes,
	type Env,
	errorResponse,
	HttpError,
	readJson,
	readText,
	record,
	text,
} from "./common.js";

export { TidepoolConnector } from "./connector.js";
export { DocumentDO } from "./document.js";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		let allowedOrigin: string | undefined;
		try {
			configuration(env);
			originAllowed(request, env);
			allowedOrigin = request.headers.get("Origin") ?? undefined;
			request = await normalizeRestLess(request);
			const url = new URL(request.url);
			const origin = request.headers.get("Origin");
			if (request.method === "OPTIONS") {
				return new Response(null, {
					status: 204,
					headers: {
						"Access-Control-Allow-Origin": origin ?? url.origin,
						"Access-Control-Allow-Methods": "GET,HEAD,POST,PATCH,OPTIONS",
						"Access-Control-Allow-Headers": "Authorization,Content-Type",
						Vary: "Origin",
					},
				});
			}
			if (url.pathname === "/health")
				return cors(Response.json({ status: "ok" }), allowedOrigin);
			const path = url.pathname
				.split("/")
				.filter(Boolean)
				.map(decodeURIComponent);
			let tenant: string;
			let document: string;
			let forwarded = request;
			if (path[0] === "socket.io") {
				if (
					path.length !== 1 ||
					url.searchParams.get("transport") !== "websocket" ||
					request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
				) {
					throw new HttpError(400, "Only WebSocket transport is supported");
				}
				tenant = text(url.searchParams.get("tenantId"));
				document = text(url.searchParams.get("documentId"));
				if (tenant !== env.TENANT_ID)
					throw new HttpError(401, "Unknown tenant");
			} else {
				if (!["documents", "deltas", "repos"].includes(path[0] ?? ""))
					throw new HttpError(404, "Not found");
				tenant = text(path[1]);
				const create =
					request.method === "POST" &&
					path[0] === "documents" &&
					path.length === 2;
				const claims = await verify(
					requestToken(request),
					env,
					tenant,
					undefined,
					create ? ["doc:read", "doc:write"] : ["doc:read"],
				);
				if (create) {
					const body = record(await readJson(request));
					document =
						body.id === undefined ? crypto.randomUUID() : text(body.id);
					forwarded = new Request(request.url, {
						method: "POST",
						headers: request.headers,
						body: JSON.stringify(body),
					});
				} else if (path[0] === "repos") {
					document = text(claims.documentId);
				} else {
					const documents: string[] = [];
					if (
						(path[0] === "deltas" && path.length === 3) ||
						(path[0] === "documents" &&
							(path.length === 3 ||
								(path.length === 4 && path[3] === "deltas")))
					)
						documents.push(text(path[2]));
					if (
						path[0] === "documents" &&
						path.length === 4 &&
						path[2] === "session"
					)
						documents.push(text(path[3]));
					if (documents.length === 0)
						throw new HttpError(404, "Unsupported document route");
					// Discovery for "deltas" and deltas for "session" share a URL.
					document = text(claims.documentId);
					if (!documents.includes(document))
						throw new HttpError(401, "Document identity mismatch");
				}
			}
			if (bytes(tenant) > 256 || bytes(document) > 256)
				throw new HttpError(400, "Identifier too long");
			const headers = new Headers(forwarded.headers);
			headers.set("X-Tidepool-Tenant", tenant);
			headers.set("X-Tidepool-Document", document);
			forwarded = new Request(forwarded, { headers });
			const response = await env.DOCUMENTS.get(
				env.DOCUMENTS.idFromName(JSON.stringify([tenant, document])),
			).fetch(forwarded);
			return cors(response, allowedOrigin);
		} catch (error) {
			return cors(errorResponse(error), allowedOrigin);
		}
	},
};

function cors(response: Response, origin: string | undefined): Response {
	if (!origin || response.status === 101) return response;
	const result = new Response(response.body, response);
	result.headers.set("Access-Control-Allow-Origin", origin);
	result.headers.set("Vary", "Origin");
	return result;
}

async function normalizeRestLess(request: Request): Promise<Request> {
	if (!request.headers.get("Content-Type")?.includes(";restless"))
		return request;
	const fields = new URLSearchParams(await readText(request));
	const method = text(fields.get("method")).toUpperCase();
	if (!["GET", "HEAD", "POST", "PATCH"].includes(method))
		throw new HttpError(405, "Unsupported RestLess method");
	const headers = new Headers(request.headers);
	headers.delete("Content-Length");
	headers.set("Content-Type", "application/json");
	for (const header of fields.getAll("header")) {
		const colon = header.indexOf(":");
		if (colon <= 0) throw new HttpError(400, "Malformed RestLess header");
		const name = header.slice(0, colon).trim().toLowerCase();
		if (name === "authorization" || name === "content-type")
			headers.set(name, header.slice(colon + 1).trim());
	}
	return new Request(request.url, {
		method,
		headers,
		body:
			method === "GET" || method === "HEAD" ? undefined : fields.get("body"),
	});
}
