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
