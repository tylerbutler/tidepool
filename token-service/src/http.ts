export class HttpError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export function bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

export function originAllowed(
	request: Request,
	env: { ALLOWED_ORIGIN?: string },
): void {
	const origin = request.headers.get("Origin");
	if (origin && origin !== (env.ALLOWED_ORIGIN ?? new URL(request.url).origin))
		throw new HttpError(403, "Origin is not allowed");
}

export async function readJson(request: Request): Promise<unknown> {
	const reader = request.body?.getReader();
	if (!reader) throw new HttpError(400, "Missing request body");
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > 2048) {
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
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		throw new HttpError(400, "Invalid UTF-8 request body");
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new HttpError(400, "Invalid JSON request body");
	}
}

export function errorResponse(error: unknown): Response {
	if (error instanceof HttpError)
		return Response.json({ message: error.message }, { status: error.status });
	console.error("Tidepool token request failed", error);
	return Response.json(
		{ message: "Storage or runtime failure", retryAfter: 1000 },
		{ status: 503, headers: { "Retry-After": "1" } },
	);
}
