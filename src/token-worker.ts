import { SignJWT } from "jose";
import { type AuthEnv, configuration, originAllowed } from "./auth.js";
import { bytes, errorResponse, HttpError, readJson, record } from "./common.js";

export interface TokenEnv extends AuthEnv {
	ACCESS_AUDIENCE: string;
}

export default {
	async fetch(
		request: Request,
		env: TokenEnv,
		ctx: Pick<ExecutionContext, "access">,
	): Promise<Response> {
		let origin: string | undefined;
		let response: Response;
		try {
			originAllowed(request, env);
			origin = request.headers.get("Origin") ?? undefined;
			const url = new URL(request.url);
			if (url.pathname === "/tokens" && request.method === "OPTIONS") {
				response = new Response(null, {
					status: 204,
					headers: {
						"Access-Control-Allow-Methods": "POST,OPTIONS",
						"Access-Control-Allow-Headers": "Content-Type",
					},
				});
			} else {
				configuration(env);
				if (!env.ACCESS_AUDIENCE)
					throw new HttpError(503, "ACCESS_AUDIENCE must be configured");
				if (bytes(env.JWT_SECRET) < 32)
					throw new HttpError(503, "JWT_SECRET must contain at least 32 bytes");
				if (
					(url.pathname === "/" || url.pathname === "/health") &&
					request.method === "GET"
				) {
					response = Response.json({ status: "ok", tokenEndpoint: "/tokens" });
				} else {
					if (url.pathname !== "/tokens") throw new HttpError(404, "Not found");
					if (request.method !== "POST")
						throw new HttpError(405, "Use POST to request a token");
					if (!ctx.access || ctx.access.aud !== env.ACCESS_AUDIENCE)
						throw new HttpError(
							403,
							"Cloudflare Access authentication required",
						);
					const identity = await ctx.access.getIdentity();
					if (!identity?.user_uuid)
						throw new HttpError(
							403,
							"Cloudflare Access user identity required",
						);
					if (
						request.headers
							.get("Content-Type")
							?.split(";")[0]
							?.trim()
							.toLowerCase() !== "application/json"
					)
						throw new HttpError(415, "Content-Type must be application/json");
					const body = record(await readJson(request, 2048));
					if (
						Object.keys(body).some((key) => key !== "documentId") ||
						typeof body.documentId !== "string" ||
						bytes(body.documentId) > 256
					)
						throw new HttpError(
							400,
							"Provide only documentId, at most 256 UTF-8 bytes",
						);
					const issuedAt = Math.floor(Date.now() / 1000);
					const expiresAt = issuedAt + 15 * 60;
					const jwt = await new SignJWT({
						tenantId: env.TENANT_ID,
						documentId: body.documentId,
						user: { id: identity.user_uuid },
						scopes: ["doc:read", "doc:write", "summary:write"],
						ver: "1.0",
					})
						.setProtectedHeader({ alg: "HS256", typ: "JWT" })
						.setIssuedAt(issuedAt)
						.setExpirationTime(expiresAt)
						.setJti(crypto.randomUUID())
						.sign(new TextEncoder().encode(env.JWT_SECRET));
					response = Response.json({ jwt, expiresAt });
				}
			}
		} catch (error) {
			response = errorResponse(error);
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
