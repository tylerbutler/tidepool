export const MAX_FRAME_BYTES = 1_048_576;
export const MAX_HTTP_BYTES = 16 * 1_048_576;
export const MAX_DOCUMENT_BYTES = 64 * 1_048_576;
export const MAX_CLIENTS = 128;
export const PING_INTERVAL_MS = 10_000;
export const PING_TIMEOUT_MS = 20_000;
export const RETRY_AFTER_MS = 1000;

export interface Env {
	DOCUMENTS: DurableObjectNamespace;
	CONTENT: R2Bucket;
	TENANT_ID: string;
	JWT_SECRET: string;
	ALLOWED_ORIGIN?: string;
}

export class HttpError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new HttpError(400, "Expected an object");
	}
	return value as Record<string, unknown>;
}

export function text(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new HttpError(400, "Expected a nonempty string");
	}
	return value;
}

export function integer(value: unknown): number {
	if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
		throw new HttpError(400, "Expected a nonnegative safe integer");
	}
	return value;
}

export function bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

export async function readText(
	request: Request,
	limit = MAX_HTTP_BYTES,
): Promise<string> {
	const reader = request.body?.getReader();
	if (!reader) throw new HttpError(400, "Missing request body");
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			throw new HttpError(413, "Request body exceeds the upload limit");
		}
		chunks.push(value);
	}
	const buffer = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		throw new HttpError(400, "Invalid UTF-8 request body");
	}
}

export async function readJson(
	request: Request,
	limit = MAX_HTTP_BYTES,
): Promise<unknown> {
	const body = await readText(request, limit);
	try {
		return JSON.parse(body);
	} catch {
		throw new HttpError(400, "Invalid JSON request body");
	}
}

export function errorResponse(error: unknown): Response {
	if (error instanceof HttpError) {
		return Response.json({ message: error.message }, { status: error.status });
	}
	console.error("Tidepool request failed", error);
	return Response.json(
		// The pinned REST driver reads retryAfter in milliseconds for 503 errors.
		{ message: "Storage or runtime failure", retryAfter: RETRY_AFTER_MS },
		{ status: 503, headers: { "Retry-After": String(RETRY_AFTER_MS / 1000) } },
	);
}
