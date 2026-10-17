import { SignJWT } from "jose";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MAX_CLIENTS } from "../src/common.js";
import { createDocument, secret, startRuntime } from "./runtime.js";

let environment: Awaited<ReturnType<typeof startRuntime>>;
beforeAll(async () => {
	environment = await startRuntime();
});
afterAll(async () => environment?.runtime.dispose());

it("returns authorization errors with CORS only for an allowed origin", async () => {
	const { base } = environment;
	const rejected = await fetch(`${base}/deltas/fluid/auth`, {
		headers: { Origin: base },
	});
	expect(rejected.status).toBe(401);
	expect(rejected.headers.get("Access-Control-Allow-Origin")).toBe(base);
	const blocked = await fetch(`${base}/health`, {
		headers: { Origin: "https://untrusted.example" },
	});
	expect(blocked.status).toBe(403);
	expect(blocked.headers.has("Access-Control-Allow-Origin")).toBe(false);
	const preflight = await fetch(`${base}/deltas/fluid/auth`, {
		method: "OPTIONS",
		headers: { Origin: base },
	});
	expect(preflight.status).toBe(204);
	expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain(
		"Authorization",
	);
});

it("rejects signed tokens with invalid user claims as unauthorized", async () => {
	await createDocument(environment.base, "invalid-user");
	const jwt = await new SignJWT({
		tenantId: "fluid",
		documentId: "invalid-user",
		scopes: ["doc:read"],
		user: null,
	})
		.setProtectedHeader({ alg: "HS256" })
		.setIssuedAt()
		.setExpirationTime("1h")
		.sign(new TextEncoder().encode(secret));
	const response = await fetch(
		`${environment.base}/deltas/fluid/invalid-user`,
		{ headers: { Authorization: `Bearer ${jwt}` } },
	);
	expect(response.status).toBe(401);
});

it("bounds unauthenticated sockets per document", async () => {
	const sockets = [];
	try {
		const url = `${environment.base}/socket.io/?EIO=4&transport=websocket&tenantId=fluid&documentId=preauth-cap`;
		for (let i = 0; i < MAX_CLIENTS; i++) {
			const response = await environment.runtime.dispatchFetch(url, {
				headers: { Upgrade: "websocket" },
			});
			expect(response.status).toBe(101);
			if (!response.webSocket) throw new Error("Missing WebSocket");
			response.webSocket.accept();
			sockets.push(response.webSocket);
		}
		const overflow = await environment.runtime.dispatchFetch(url, {
			headers: { Upgrade: "websocket" },
		});
		expect(overflow.status).toBe(429);
	} finally {
		for (const socket of sockets) socket.close();
	}
});
