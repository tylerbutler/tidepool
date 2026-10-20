import bundledAssets from "../dist/app-assets.js";
import tokenWorker, { type TokenEnv } from "../token-service/src/worker.js";

export type { TokenEnv };

const files: Record<string, { body: string; contentType: string }> =
	bundledAssets;

export default {
	fetch(
		request: Request,
		env: TokenEnv,
		ctx: Pick<ExecutionContext, "access">,
	) {
		return tokenWorker.fetch(
			request,
			{
				...env,
				APP_ASSETS: {
					async fetch(input) {
						const asset = files[new URL(new Request(input).url).pathname];
						if (!asset) return new Response("Not found", { status: 404 });
						return new Response(asset.body, {
							headers: { "Content-Type": asset.contentType },
						});
					},
				},
			},
			ctx,
		);
	},
};
