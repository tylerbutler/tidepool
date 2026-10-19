import { SignJWT } from "jose";
import {
	bytes,
	errorResponse,
	HttpError,
	originAllowed,
	readJson,
} from "./http.js";

export interface TokenEnv {
	TOKEN_AUTH_MODE?: string;
	ACCESS_AUDIENCE?: string;
	TENANT_ID?: string;
	JWT_SECRET?: string;
	ALLOWED_ORIGIN?: string;
}

export async function accessUser(
	env: Pick<TokenEnv, "ACCESS_AUDIENCE">,
	ctx: Pick<ExecutionContext, "access">,
): Promise<string | Response> {
	if (!env.ACCESS_AUDIENCE)
		return Response.json(
			{ message: "ACCESS_AUDIENCE must be configured" },
			{ status: 503 },
		);
	if (!ctx.access || ctx.access.aud !== env.ACCESS_AUDIENCE)
		return Response.json(
			{ message: "Cloudflare Access authentication required" },
			{ status: 403 },
		);
	const identity = await ctx.access.getIdentity();
	if (!identity?.user_uuid)
		return Response.json(
			{ message: "Cloudflare Access user identity required" },
			{ status: 403 },
		);
	return identity.user_uuid;
}

export function authMode(env: TokenEnv): "access" | "anonymous" {
	const mode =
		env.TOKEN_AUTH_MODE === undefined ? "access" : env.TOKEN_AUTH_MODE;
	if (mode !== "access" && mode !== "anonymous")
		throw new HttpError(503, "TOKEN_AUTH_MODE must be access or anonymous");
	if (mode === "access" && !env.ACCESS_AUDIENCE)
		throw new HttpError(503, "ACCESS_AUDIENCE must be configured");
	return mode;
}

function signingConfiguration(env: TokenEnv) {
	const { TENANT_ID, JWT_SECRET } = env;
	if (!TENANT_ID || !JWT_SECRET)
		throw new HttpError(503, "TENANT_ID and JWT_SECRET must be configured");
	if (bytes(JWT_SECRET) < 32)
		throw new HttpError(503, "JWT_SECRET must contain at least 32 bytes");
	return { TENANT_ID, JWT_SECRET };
}

async function route(
	request: Request,
	env: TokenEnv,
	ctx: Pick<ExecutionContext, "access">,
): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname === "/tokens" && request.method === "OPTIONS")
		return new Response(null, {
			status: 204,
			headers: {
				"Access-Control-Allow-Methods": "POST,OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type",
			},
		});
	const mode = authMode(env);
	if (
		(url.pathname === "/" || url.pathname === "/health") &&
		request.method === "GET"
	) {
		const tokensConfigured = Boolean(env.TENANT_ID || env.JWT_SECRET);
		if (tokensConfigured) signingConfiguration(env);
		return Response.json({
			status: "ok",
			tokenEndpoint: tokensConfigured ? "/tokens" : null,
		});
	}
	if (url.pathname !== "/tokens") throw new HttpError(404, "Not found");
	if (request.method !== "POST")
		throw new HttpError(405, "Use POST to request a token");
	const userId =
		mode === "anonymous"
			? `anonymous:${crypto.randomUUID()}`
			: await accessUser(env, ctx);
	if (typeof userId !== "string") return userId;
	const signing = signingConfiguration(env);
	if (
		request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !==
		"application/json"
	)
		throw new HttpError(415, "Content-Type must be application/json");
	const body = await readJson(request);
	if (
		body === null ||
		typeof body !== "object" ||
		Array.isArray(body) ||
		Object.keys(body).some((key) => key !== "documentId") ||
		!("documentId" in body) ||
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
		tenantId: signing.TENANT_ID,
		documentId: body.documentId,
		user: { id: userId },
		scopes: ["doc:read", "doc:write", "summary:write"],
		ver: "1.0",
	})
		.setProtectedHeader({ alg: "HS256", typ: "JWT" })
		.setIssuedAt(issuedAt)
		.setExpirationTime(expiresAt)
		.setJti(crypto.randomUUID())
		.sign(new TextEncoder().encode(signing.JWT_SECRET));
	return Response.json({ jwt, expiresAt });
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
			response = await route(request, env, ctx);
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
