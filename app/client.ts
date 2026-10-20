import { AttachState } from "@fluidframework/container-definitions";
import { Loader } from "@fluidframework/container-loader/internal";
import type {
	IResolvedUrl,
	IUrlResolver,
} from "@fluidframework/driver-definitions/internal";
import {
	createDOProviderContainerRuntimeFactory,
	createFluidContainer,
} from "@fluidframework/fluid-static/internal";
import { SharedMap } from "@fluidframework/map/internal";
import {
	type ITokenProvider,
	RouterliciousDocumentServiceFactory,
} from "@fluidframework/routerlicious-driver/internal";

export const schema = { initialObjects: { map: SharedMap } };

export function createResolvedUrl(
	document: string,
	base: string,
	tenant = "fluid",
): IResolvedUrl {
	const path = `${encodeURIComponent(tenant)}/${encodeURIComponent(document)}`;
	return {
		type: "fluid",
		id: document,
		url: `${base}/${path}`,
		tokens: {},
		endpoints: {
			ordererUrl: base,
			deltaStreamUrl: base,
			storageUrl: `${base}/repos/${encodeURIComponent(tenant)}`,
			deltaStorageUrl: `${base}/documents/${path}/deltas`,
		},
	};
}

export function createTokenProvider(endpoint = "/tokens"): ITokenProvider {
	const fetchToken = async (_tenant: string, documentId = "") => {
		const response = await fetch(endpoint, {
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ documentId }),
			redirect: "error",
		});
		if (!response.ok)
			throw new Error(
				`Token request failed (${response.status}). Reload the page to sign in again.`,
			);
		const body: unknown = await response.json();
		if (
			!body ||
			typeof body !== "object" ||
			!("jwt" in body) ||
			typeof body.jwt !== "string"
		)
			throw new Error("Token service returned an invalid response.");
		return { jwt: body.jwt };
	};
	return { fetchOrdererToken: fetchToken, fetchStorageToken: fetchToken };
}

export function createAdapter(
	base: string,
	tokenProvider: ITokenProvider,
	tenant = "fluid",
) {
	const urlResolver: IUrlResolver = {
		async resolve(request) {
			const document = new URL(request.url).pathname
				.split("/")
				.filter(Boolean)
				.at(-1);
			if (!document) throw new Error("Missing document ID");
			return createResolvedUrl(decodeURIComponent(document), base, tenant);
		},
		async getAbsoluteUrl(resolved, relative) {
			return relative ? `${resolved.url}/${relative}` : resolved.url;
		},
	};
	return {
		urlResolver,
		documentServiceFactory: new RouterliciousDocumentServiceFactory(
			tokenProvider,
			{
				enableDiscovery: false,
				enableRestLess: true,
				enableWholeSummaryUpload: false,
				enableLongPollingDowngrade: false,
			},
		),
	};
}

export function createClient(
	base: string,
	tokenProvider: ITokenProvider,
	tenant = "fluid",
) {
	const loader = new Loader({
		...createAdapter(base, tokenProvider, tenant),
		codeLoader: {
			async load() {
				return {
					module: {
						fluidExport: createDOProviderContainerRuntimeFactory({
							schema,
							compatibilityMode: "2",
						}),
					},
					details: { package: "no-dynamic-package", config: {} },
				};
			},
		},
		configProvider: {
			getRawConfig(name) {
				return name === "Fluid.Container.ForceWriteConnection"
					? true
					: undefined;
			},
		},
	});
	return {
		async createContainer() {
			const raw = await loader.createDetachedContainer({
				package: "no-dynamic-package",
				config: {},
			});
			const container = await createFluidContainer<typeof schema>({
				container: raw,
			});
			container.attach = async () => {
				if (raw.attachState !== AttachState.Detached)
					throw new Error("Container is not detached");
				await raw.attach({ url: `${base}/${encodeURIComponent(tenant)}/new` });
				if (!raw.resolvedUrl)
					throw new Error("Attached container has no resolved URL");
				return raw.resolvedUrl.id;
			};
			return { container };
		},
		async getContainer(document: string) {
			const raw = await loader.resolve({
				url: createResolvedUrl(document, base, tenant).url,
			});
			return {
				container: await createFluidContainer<typeof schema>({
					container: raw,
				}),
			};
		},
	};
}
