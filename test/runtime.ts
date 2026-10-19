import { fileURLToPath } from "node:url";
import type {
	IClient,
	IResolvedUrl,
} from "@fluidframework/driver-definitions/internal";
import { RouterliciousDocumentServiceFactory } from "@fluidframework/routerlicious-driver/internal";
import { SignJWT } from "jose";
import { Miniflare } from "miniflare";

export const secret = "tidepool-local-test-secret";

export function createResolvedUrl(
	document: string,
	base: string,
): IResolvedUrl {
	return {
		type: "fluid",
		id: document,
		url: `${base}/fluid/${document}`,
		tokens: {},
		endpoints: {
			ordererUrl: base,
			deltaStreamUrl: base,
			storageUrl: `${base}/repos/fluid`,
			deltaStorageUrl: `${base}/documents/fluid/${document}/deltas`,
		},
	};
}

export function createTestClient(
	user: string,
	mode: IClient["mode"] = "write",
): IClient {
	return {
		mode,
		details: {
			capabilities: { interactive: true },
			environment: "node:vitest",
		},
		permission: [],
		user: { id: user },
		scopes: ["doc:read", "doc:write", "summary:write"],
	};
}

export async function startRuntime(persist?: string, connector = false) {
	const runtime = new Miniflare({
		name: "tidepool-tests",
		rootPath: fileURLToPath(new URL("../", import.meta.url)),
		modulesRoot: fileURLToPath(new URL("../", import.meta.url)),
		modules: true,
		scriptPath: fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
		compatibilityDate: "2026-07-30",
		unsafeInspectDurableObjects: true,
		durableObjects: { DOCUMENTS: { className: "DocumentDO", useSQLite: true } },
		r2Buckets: ["CONTENT"],
		bindings: { TENANT_ID: "fluid", JWT_SECRET: secret },
		...(connector
			? {
					serviceBindings: {
						TIDEPOOL: {
							name: "tidepool-tests",
							entrypoint: "TidepoolConnector",
						},
					},
				}
			: {}),
		...(persist
			? {
					durableObjectsPersist: `${persist}/documents`,
					r2Persist: `${persist}/content`,
				}
			: {}),
	});
	const base = (await runtime.ready).origin;
	return { runtime, base };
}

export function token(
	document: string,
	scopes = ["doc:read", "doc:write", "summary:write"],
) {
	return new SignJWT({
		tenantId: "fluid",
		documentId: document,
		scopes,
		user: { id: "tidepool-test-user", name: "Tidepool Test User" },
		ver: "1.0",
		jti: crypto.randomUUID(),
	})
		.setProtectedHeader({ alg: "HS256" })
		.setIssuedAt()
		.setExpirationTime("1h")
		.sign(new TextEncoder().encode(secret));
}

export async function api(
	base: string,
	document: string,
	path: string,
	body?: unknown,
	scopes?: string[],
	method = body === undefined ? "GET" : "POST",
) {
	return fetch(`${base}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${await token(document, scopes)}`,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

export async function createDocument(base: string, id: string) {
	const response = await api(base, id, "/documents/fluid", { id });
	if (response.status !== 201)
		throw new Error(
			`Create failed: ${response.status} ${await response.text()}`,
		);
}

export function provider(scopes = ["doc:read", "doc:write", "summary:write"]) {
	const response = async (_tenant: string, document = "") => ({
		jwt: await token(document, scopes),
	});
	return { fetchOrdererToken: response, fetchStorageToken: response };
}

export async function service(
	base: string,
	document: string,
	scopes?: string[],
) {
	const factory = new RouterliciousDocumentServiceFactory(provider(scopes), {
		enableDiscovery: false,
		enableRestLess: true,
		enableWholeSummaryUpload: false,
		enableLongPollingDowngrade: false,
	});
	return factory.createDocumentService(createResolvedUrl(document, base));
}

export async function connect(
	base: string,
	document: string,
	mode: "read" | "write" = "write",
	scopes?: string[],
) {
	const docService = await service(base, document, scopes);
	const connection = await docService.connectToDeltaStream(
		createTestClient("prototype-user", mode),
	);
	return { connection, service: docService };
}

export async function deltas(
	base: string,
	document: string,
): Promise<Array<Record<string, unknown>>> {
	const response = await api(base, document, `/deltas/fluid/${document}`);
	if (!response.ok) throw new Error(`Delta request failed: ${response.status}`);
	return response.json() as Promise<Array<Record<string, unknown>>>;
}
