import { AttachState } from "@fluidframework/container-definitions";
import { Loader } from "@fluidframework/container-loader/internal";
import type { IUrlResolver } from "@fluidframework/driver-definitions/internal";
import {
	createDOProviderContainerRuntimeFactory,
	createFluidContainer,
} from "@fluidframework/fluid-static/internal";
import { SharedMap } from "@fluidframework/map/internal";
import { RouterliciousDocumentServiceFactory } from "@fluidframework/routerlicious-driver/internal";
import { createResolvedUrl, createTestClient, provider } from "./runtime.js";

export const schema = { initialObjects: { map: SharedMap } };

export function createAdapter(base: string) {
	const urlResolver: IUrlResolver = {
		async resolve(request) {
			const document = new URL(request.url).pathname
				.split("/")
				.filter(Boolean)
				.at(-1);
			if (!document) throw new Error("Missing document ID");
			return createResolvedUrl(document, base);
		},
		async getAbsoluteUrl(resolved, relative) {
			return relative ? `${resolved.url}/${relative}` : resolved.url;
		},
	};
	return {
		urlResolver,
		documentServiceFactory: new RouterliciousDocumentServiceFactory(
			provider(),
			{
				enableDiscovery: false,
				enableRestLess: true,
				enableWholeSummaryUpload: false,
				enableLongPollingDowngrade: false,
			},
		),
	};
}

export function createClient(base: string, user: string) {
	const loader = new Loader({
		...createAdapter(base),
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
		options: { client: createTestClient(user) },
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
				await raw.attach({ url: `${base}/fluid/new` });
				if (!raw.resolvedUrl)
					throw new Error("Attached container has no resolved URL");
				return raw.resolvedUrl.id;
			};
			return { container };
		},
		async getContainer(document: string) {
			const raw = await loader.resolve({
				url: createResolvedUrl(document, base).url,
			});
			return {
				container: await createFluidContainer<typeof schema>({
					container: raw,
				}),
			};
		},
	};
}
