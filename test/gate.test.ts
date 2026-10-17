import { RouterliciousDocumentServiceFactory } from "@fluidframework/routerlicious-driver/internal";
import { SignJWT } from "jose";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";

const secret = "tidepool-local-test-secret";
let runtime: Miniflare;
let base: string;

beforeAll(async () => {
	runtime = new Miniflare({
		modules: true,
		scriptPath: "dist/worker.js",
		compatibilityDate: "2026-07-30",
		durableObjects: {
			DOCUMENTS: { className: "DocumentDO", useSQLite: true },
		},
		r2Buckets: ["CONTENT"],
		bindings: { TENANT_ID: "fluid", JWT_SECRET: secret },
	});
	base = (await runtime.ready).origin;
});
afterAll(async () => runtime?.dispose());

it("executes Gleam framing inside a document Durable Object", async () => {
	const response = await runtime.dispatchFetch(
		"http://localhost/socket.io/?EIO=4&transport=websocket&tenantId=fluid&documentId=gate",
		{ headers: { Upgrade: "websocket" } },
	);
	expect(response.status).toBe(101);
	response.webSocket?.accept();
	response.webSocket?.close();
});

it("routes an unmodified official driver directly to a document object", async () => {
	const jwt = await new SignJWT({
		tenantId: "fluid",
		documentId: "gate",
		scopes: ["doc:read", "doc:write", "summary:write"],
		user: { id: "gate-user" },
	})
		.setProtectedHeader({ alg: "HS256" })
		.setIssuedAt()
		.setExpirationTime("1h")
		.sign(new TextEncoder().encode(secret));
	const provider = {
		async fetchOrdererToken() {
			return { jwt };
		},
		async fetchStorageToken() {
			return { jwt };
		},
	};
	const created = await fetch(`${base}/documents/fluid`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${jwt}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ id: "gate" }),
	});
	expect(created.status).toBe(201);
	const factory = new RouterliciousDocumentServiceFactory(provider, {
		enableDiscovery: false,
		enableRestLess: false,
		enableWholeSummaryUpload: false,
		enableLongPollingDowngrade: false,
	});
	const service = await factory.createDocumentService({
		type: "fluid",
		id: "gate",
		url: `${base}/fluid/gate`,
		tokens: {},
		endpoints: {
			ordererUrl: base,
			deltaStorageUrl: `${base}/deltas/fluid/gate`,
			deltaStreamUrl: base,
			storageUrl: `${base}/repos/fluid`,
		},
	});
	const connection = await service.connectToDeltaStream({
		mode: "write",
		details: {
			capabilities: { interactive: true },
			environment: "node:vitest",
		},
		permission: [],
		scopes: ["doc:read", "doc:write", "summary:write"],
		user: { id: "gate-user" },
	});
	expect(connection.clientId).toBeTruthy();
	connection.dispose();
	service.dispose();
});
