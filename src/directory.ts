import type { Env } from "./common.js";

export async function directoryPrefix(
	tenant: string,
	documentPrefix = "",
): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tenant)),
	);
	const tenantKey = Array.from(digest, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `directory/v1/${tenantKey}/${encodeURIComponent(documentPrefix)}`;
}

export function directoryObject(env: Pick<Env, "DOCUMENTS" | "TENANT_ID">) {
	return env.DOCUMENTS.get(
		env.DOCUMENTS.idFromName(
			JSON.stringify(["directory", "v1", env.TENANT_ID]),
		),
	);
}
