import { HttpError as TokenHttpError } from "../token-service/src/http.js";
import tokenWorker, {
	accessUser,
	authMode,
	type TokenEnv as TokenServiceEnv,
} from "../token-service/src/worker.js";
import { type AdminBindings, adminResponse } from "./admin.js";
import { originAllowed } from "./auth.js";
import { errorResponse, HttpError } from "./common.js";

export interface TokenEnv extends TokenServiceEnv, AdminBindings {}

export default {
	async fetch(
		request: Request,
		env: TokenEnv,
		ctx: Pick<ExecutionContext, "access">,
	): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/admin" && !url.pathname.startsWith("/admin/"))
			return tokenWorker.fetch(request, env, ctx);
		let origin: string | undefined;
		let response: Response;
		try {
			originAllowed(request, env);
			origin = request.headers.get("Origin") ?? undefined;
			const user =
				authMode(env) === "anonymous"
					? "anonymous"
					: await accessUser(env, ctx);
			response =
				typeof user === "string" ? await adminResponse(request, env) : user;
		} catch (error) {
			response = errorResponse(
				error instanceof TokenHttpError
					? new HttpError(error.status, error.message)
					: error,
			);
		}
		response.headers.set("Cache-Control", "no-store");
		response.headers.set("Vary", "Origin");
		if (origin) {
			response.headers.set("Access-Control-Allow-Origin", origin);
			response.headers.set("Access-Control-Allow-Credentials", "true");
		}
		return response;
	},
};
