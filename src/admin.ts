import styles from "./admin.css";
import { bytes, errorResponse, HttpError } from "./common.js";
import { directoryPrefix } from "./directory.js";
import type { DocumentDO } from "./document.js";

export interface AdminBindings {
	CONTENT?: R2Bucket;
	DOCUMENTS?: DurableObjectNamespace<DocumentDO>;
}

type DocumentInfo = NonNullable<Awaited<ReturnType<DocumentDO["inspect"]>>>;

function html(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[character] ?? character,
	);
}

function link(parameters: Record<string, string>): string {
	return html(`/admin?${new URLSearchParams(parameters)}`);
}

function date(value: string | Date): string {
	const parsed = new Date(value);
	return `<time datetime="${html(parsed.toISOString())}">${html(
		parsed
			.toISOString()
			.replace("T", " ")
			.replace(/\.\d+Z$/, " UTC"),
	)}</time>`;
}

function number(value: number): string {
	return value.toLocaleString("en-US");
}

function size(value: number): string {
	return `${(value / 1_048_576).toLocaleString("en-US", {
		maximumFractionDigits: 2,
	})} MiB`;
}

function field(label: string, value: string): string {
	return `<div><dt>${label}</dt><dd>${value}</dd></div>`;
}

function lookup(selected: string): string {
	return `<form class="lookup" id="lookup" action="/admin#document" method="get" aria-labelledby="lookup-title">
		<h2 id="lookup-title">Open by ID</h2><label for="document-id">Exact document ID</label>
		<div class="input-row"><input id="document-id" name="document" value="${html(selected)}" placeholder="Paste a document ID" autocomplete="off" maxlength="256" required><button type="submit">Open</button></div>
	</form>`;
}

function details(info: DocumentInfo, refresh: string): string {
	const storage = info.storage;
	const reserved = Math.min(
		storage.cleanupReserveBytes,
		storage.budgetBytes - storage.usedBytes,
	);
	const scale = (value: number) => (value / storage.budgetBytes) * 100;
	return `<section class="detail" id="document" aria-labelledby="document-title">
		<div class="section-heading"><h2 id="document-title">Document details</h2><a href="${refresh}#document">Refresh</a></div>
		<p class="document-id">${html(info.id)}</p>
		<dl class="metadata">
			${field("Tenant", `<code>${html(info.tenantId)}</code>`)}
			${field("Created", info.createdAt ? date(info.createdAt) : "Not recorded for this document")}
		</dl>
		<section class="detail-section" aria-labelledby="sequence-title">
			<h3 id="sequence-title">Sequence state</h3>
			<dl class="metadata">
				${field("Current sequence", number(info.sequenceNumber))}
				${field("Minimum sequence", number(info.minimumSequenceNumber))}
				${field("Summary checkpoint", number(info.summary.sequenceNumber))}
				${field("Initial checkpoint", number(info.summary.initialSequenceNumber))}
			</dl>
		</section>
		<section class="detail-section" aria-labelledby="storage-title">
			<div class="section-heading"><h3 id="storage-title">Logical storage</h3><span>${size(storage.usedBytes)} / ${size(storage.budgetBytes)}</span></div>
			<svg class="capacity" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${html(`${number(storage.usedBytes)} bytes used; ${number(storage.remainingWriteBytes)} bytes available for normal writes; ${number(reserved)} bytes of cleanup reserve remaining`)}">
				<rect class="capacity-free" width="100" height="8"/>
				<rect class="capacity-used" width="${scale(storage.usedBytes)}" height="8"/>
				<rect class="capacity-reserve" x="${100 - scale(reserved)}" width="${scale(reserved)}" height="8"/>
			</svg>
			<dl class="capacity-key">
				${field('<span class="swatch used"></span>Used', `${size(storage.usedBytes)}<small>${number(storage.usedBytes)} bytes</small>`)}
				${field('<span class="swatch free"></span>Writable', `${size(storage.remainingWriteBytes)}<small>${number(storage.remainingWriteBytes)} bytes</small>`)}
				${field('<span class="swatch reserve"></span>Cleanup reserve', `${size(reserved)}<small>${number(reserved)} bytes left</small>`)}
			</dl>
			${storage.remainingWriteBytes === 0 ? '<p class="notice">Normal write capacity is exhausted. Only cleanup can use the remaining reserve.</p>' : ""}
			<p class="help">Encoded operations, commits, and reserved content. Not physical SQLite or R2 allocation. An operation can still exceed other limits.</p>
		</section>
		<section class="detail-section" aria-labelledby="summary-title">
			<h3 id="summary-title">Summary</h3>
			<dl class="metadata">
				${field("Head commit", info.summary.handle ? `<code class="hash">${html(info.summary.handle)}</code>` : "No summary stored")}
				${field("Stored refs", number(info.summary.refCount))}
			</dl>
		</section>
		<section class="detail-section" aria-labelledby="connections-title">
			<h3 id="connections-title">Connected clients</h3>
			<dl class="metadata">
				${field("Writers", number(info.connections.writers))}
				${field("Readers", number(info.connections.readers))}
				${field("Connection limit", `${number(info.connections.limit)} sockets`)}
			</dl>
			<p class="help">Authenticated, unexpired clients with open sockets. The limit also includes sockets waiting to authenticate.</p>
		</section>
		<p class="snapshot">Snapshot ${date(info.inspectedAt)}</p>
	</section>`;
}

function shell(tenant: string, content: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Documents · Tidepool</title><link rel="stylesheet" href="/admin/style.css"></head>
<body>
	<a class="skip-link" href="#main">Skip to documents</a>
	<header class="site-header"><div class="header-inner">
		<a class="brand" href="/admin" aria-label="Tidepool admin home"><svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true"><path d="M3 8c4-5 7 5 11 0s7 0 9 0M3 14c4-5 7 5 11 0s7 0 9 0M3 20c4-5 7 5 11 0s7 0 9 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>Tidepool</a>
		<nav aria-label="Main"><a href="/admin" aria-current="page">Documents</a></nav>
		<a class="sign-out" href="/cdn-cgi/access/logout">Sign out</a>
	</div></header>
	<main id="main">
		<div class="page-heading"><div><h1>Documents</h1><p>Inspect the documents in <code>${html(tenant)}</code>.</p></div><span class="read-only">Read-only</span></div>
		<aside class="coverage" aria-label="Directory coverage"><strong>About this directory</strong><p>New documents appear here automatically. Older documents appear when accessed. <a href="#lookup">Open by ID</a> to find one that is not listed.</p></aside>
		${content}
	</main>
	<footer class="site-footer">Protected by Cloudflare Access. The same users can use the token service and this admin site.</footer>
</body></html>`;
}

const securityHeaders = {
	"Content-Security-Policy":
		"default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Cache-Control": "no-store",
};

export async function adminResponse(
	request: Request,
	env: AdminBindings & { TENANT_ID: string },
): Promise<Response> {
	const url = new URL(request.url);
	if (!["GET", "HEAD"].includes(request.method))
		throw new HttpError(405, "The admin site is read-only; use GET");
	if (url.pathname === "/admin/style.css")
		return new Response(request.method === "HEAD" ? null : styles, {
			headers: {
				...securityHeaders,
				"Content-Type": "text/css; charset=utf-8",
			},
		});
	if (url.pathname !== "/admin" && url.pathname !== "/admin/")
		throw new HttpError(404, "Not found");
	let content: string;
	let status = 200;
	let retryAfter: string | null = null;
	try {
		if (!env.CONTENT || !env.DOCUMENTS)
			throw new HttpError(503, "Document inspection is not configured");
		const prefix = url.searchParams.get("prefix") ?? "";
		const cursor = url.searchParams.get("cursor") ?? "";
		const selected = url.searchParams.get("document");
		if (
			bytes(prefix) > 256 ||
			bytes(cursor) > 2048 ||
			(selected !== null && (!selected || bytes(selected) > 256))
		)
			throw new HttpError(
				400,
				"Document IDs and prefixes must be at most 256 UTF-8 bytes; the page cursor must be at most 2048 bytes",
			);
		const info =
			selected === null
				? null
				: await env.DOCUMENTS.get(
						env.DOCUMENTS.idFromName(JSON.stringify([env.TENANT_ID, selected])),
					).inspect(env.TENANT_ID, selected);
		if (selected !== null && !info)
			throw new HttpError(
				404,
				`No document exists with ID "${selected}". Check the ID and try again.`,
			);
		const root = await directoryPrefix(env.TENANT_ID);
		const page = await env.CONTENT.list({
			prefix: `${root}${encodeURIComponent(prefix)}`,
			limit: 50,
			...(cursor ? { cursor } : {}),
		});
		const parameters = { prefix, ...(cursor ? { cursor } : {}) };
		const rows = page.objects.map((object) => {
			const id = decodeURIComponent(object.key.slice(root.length));
			const active = id === selected;
			return `<tr${active ? ' class="selected"' : ""}><td><a class="row-link" href="${link({ ...parameters, document: id })}#document"${active ? ' aria-current="true"' : ""}><code>${html(id)}</code><span class="row-action">${active ? "Selected" : "Inspect"}</span></a></td><td>${date(object.uploaded)}</td></tr>`;
		});
		content = `<div class="workspace">
			<section class="directory" aria-labelledby="directory-title">
				<div class="section-heading"><h2 id="directory-title">Document directory</h2><span>${page.objects.length}${page.truncated ? "+" : ""} on this page</span></div>
				<form class="filter" action="/admin" method="get">
					<label for="prefix">Filter by ID prefix <span>(case-sensitive)</span></label>
					<div class="input-row"><input id="prefix" name="prefix" value="${html(prefix)}" placeholder="Start of a document ID" autocomplete="off" maxlength="256"><button type="submit">Filter</button></div>
					${prefix ? '<a class="clear-filter" href="/admin">Clear filter</a>' : ""}
				</form>
				${rows.length ? `<table><caption class="sr-only">Indexed documents. Select a document to inspect its current metadata.</caption><thead><tr><th scope="col">Document ID</th><th scope="col">Indexed at</th></tr></thead><tbody>${rows.join("")}</tbody></table>` : `<div class="empty"><h3>${prefix ? "No matching documents" : "No documents indexed yet"}</h3><p>${prefix ? "Try a different prefix, clear the filter, or open an exact ID." : "Create a document through a Fluid client, access an existing document, or open its exact ID here."}</p></div>`}
				<div class="pagination"><span>Up to 50 documents per page</span><div>${cursor ? `<a href="${link({ prefix })}">First page</a>` : ""}${page.truncated ? `<a class="button secondary" href="${link({ prefix, cursor: page.cursor })}">Next page</a>` : ""}</div></div>
				<p class="help directory-help">Indexed time is when the directory entry was stored, not when the document was created. Select a document to read its current state.</p>
			</section>
			<div class="inspector">
				${lookup(selected ?? "")}
				${info ? details(info, link({ ...parameters, document: info.id })) : '<section class="detail empty" id="document"><h2>Select a document</h2><p>Choose a document from the directory or open an exact ID to inspect its sequence state, storage, summary, and connections.</p><p class="help">The directory does not read DDS contents. Metadata is fetched only for the document you select.</p></section>'}
			</div>
		</div>`;
	} catch (error) {
		const failure = errorResponse(error);
		status = failure.status;
		retryAfter = failure.headers.get("Retry-After");
		const { message } = await failure.json<{ message: string }>();
		content = `<section class="error" role="alert"><h2>${status === 404 ? "Document not found" : status === 400 ? "Check the request" : "Could not load documents"}</h2><p>${html(message)}</p><div class="error-actions">${status >= 500 ? `<a class="button" href="${html(url.pathname + url.search)}">Try again</a>` : ""}<a href="/admin">Back to directory</a></div></section>${lookup(url.searchParams.get("document") ?? "")}`;
	}
	return new Response(
		request.method === "HEAD" ? null : shell(env.TENANT_ID, content),
		{
			status,
			headers: {
				...securityHeaders,
				"Content-Type": "text/html; charset=utf-8",
				...(retryAfter ? { "Retry-After": retryAfter } : {}),
			},
		},
	);
}
