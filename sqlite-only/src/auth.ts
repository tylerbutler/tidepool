import { errors, type JWTPayload, jwtVerify } from "jose";
import { type Env, HttpError, text } from "./common.js";

export type AuthEnv = Pick<Env, "TENANT_ID" | "JWT_SECRET" | "ALLOWED_ORIGIN">;

export interface Claims extends JWTPayload {
	tenantId: string;
	documentId: string;
	scopes: string[];
	user: { id: string };
}

export function configuration(env: AuthEnv): void {
	if (!env.TENANT_ID || !env.JWT_SECRET) {
		throw new HttpError(503, "TENANT_ID and JWT_SECRET must be configured");
	}
}

export function originAllowed(
	request: Request,
	env: Pick<AuthEnv, "ALLOWED_ORIGIN">,
): void {
	const origin = request.headers.get("Origin");
	if (
		origin &&
		origin !== (env.ALLOWED_ORIGIN ?? new URL(request.url).origin)
	) {
		throw new HttpError(403, "Origin is not allowed");
	}
}

export async function verify(
	token: string,
	env: AuthEnv,
	tenant: string,
	document: string | undefined,
	requiredScopes: string[],
): Promise<Claims> {
	configuration(env);
	let payload: JWTPayload;
	try {
		({ payload } = await jwtVerify(
			token,
			new TextEncoder().encode(env.JWT_SECRET),
			{ algorithms: ["HS256"], requiredClaims: ["exp", "iat"] },
		));
	} catch (error) {
		if (error instanceof errors.JOSEError) {
			throw new HttpError(401, "Invalid or expired token");
		}
		throw error;
	}
	const scopes = payload.scopes;
	if (
		tenant !== env.TENANT_ID ||
		payload.tenantId !== tenant ||
		typeof payload.documentId !== "string" ||
		(document !== undefined && payload.documentId !== document) ||
		!Array.isArray(scopes) ||
		!scopes.every((scope: unknown) => typeof scope === "string") ||
		requiredScopes.some((scope) => !scopes.includes(scope))
	) {
		throw new HttpError(
			401,
			"Token identity or scopes do not authorize this request",
		);
	}
	const user = payload.user;
	if (
		!user ||
		typeof user !== "object" ||
		!("id" in user) ||
		typeof user.id !== "string" ||
		user.id.length === 0
	) {
		throw new HttpError(401, "Token user is invalid");
	}
	return payload as Claims;
}

export function requestToken(request: Request): string {
	const header = request.headers.get("Authorization") ?? "";
	if (header.startsWith("Bearer ")) return text(header.slice(7));
	if (header.startsWith("Basic ")) {
		const credentials = header.slice(6);
		if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credentials))
			return credentials;
		try {
			const decoded = atob(credentials);
			const colon = decoded.indexOf(":");
			if (colon >= 0) return text(decoded.slice(colon + 1));
		} catch {
			throw new HttpError(401, "Invalid Basic authorization");
		}
	}
	throw new HttpError(401, "Missing authorization");
}
