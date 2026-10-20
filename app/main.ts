import "./style.css";
import { ConnectionState } from "@fluidframework/container-definitions";
import { createClient, createTokenProvider } from "./client.js";

function element<T extends HTMLElement>(id: string, type: { new (): T }): T {
	const node = document.getElementById(id);
	if (!(node instanceof type)) throw new Error(`Missing element: ${id}`);
	return node;
}

const status = element("status", HTMLParagraphElement);
const error = element("error", HTMLParagraphElement);
const create = element("create", HTMLButtonElement);
const open = element("open", HTMLButtonElement);
const idInput = element("document-id", HTMLInputElement);
const fields = element("entry-fields", HTMLFieldSetElement);
const entries = element("entries", HTMLTableSectionElement);
const empty = element("empty", HTMLParagraphElement);
const count = element("entry-count", HTMLSpanElement);
const share = element("share", HTMLDivElement);
const shareUrl = element("share-url", HTMLInputElement);
const keyInput = element("key", HTMLInputElement);
const valueInput = element("value", HTMLInputElement);
let client: ReturnType<typeof createClient>;
let current:
	| Awaited<ReturnType<typeof client.getContainer>>["container"]
	| undefined;
let busy = false;
let switching = false;

function report(cause: unknown) {
	error.textContent = cause instanceof Error ? cause.message : String(cause);
	error.hidden = false;
}

function render() {
	const previousButtons = [...entries.querySelectorAll("button")];
	const focusedIndex =
		document.activeElement instanceof HTMLButtonElement
			? previousButtons.indexOf(document.activeElement)
			: -1;
	const focusedKey = previousButtons[focusedIndex]?.dataset.key;
	entries.replaceChildren();
	const map = current?.initialObjects.map;
	for (const [key, value] of [...(map?.entries() ?? [])].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		const row = entries.insertRow();
		row.insertCell().textContent = key;
		row.insertCell().textContent =
			typeof value === "string"
				? value
				: (JSON.stringify(value) ?? String(value));
		const remove = document.createElement("button");
		remove.textContent = "Delete";
		remove.className = "secondary";
		remove.dataset.key = key;
		remove.setAttribute("aria-label", `Delete ${key}`);
		remove.disabled = fields.disabled;
		remove.addEventListener("click", () => {
			try {
				map?.delete(key);
			} catch (cause) {
				report(cause);
			}
		});
		row.insertCell().append(remove);
	}
	if (focusedKey !== undefined) {
		const buttons = [...entries.querySelectorAll("button")];
		const target =
			buttons.find((button) => button.dataset.key === focusedKey) ??
			buttons[Math.min(focusedIndex, buttons.length - 1)];
		if (target && !target.disabled) target.focus({ preventScroll: true });
		else if (!fields.disabled) keyInput.focus({ preventScroll: true });
		else idInput.focus({ preventScroll: true });
	}
	count.textContent = map
		? `${map.size} ${map.size === 1 ? "entry" : "entries"}`
		: "No document open";
	empty.hidden = Boolean(map?.size);
	empty.textContent = map
		? "No entries yet. Add the first key and value above."
		: "Create or open a document to start.";
}

function connection() {
	if (!current || switching) return;
	fields.disabled =
		busy || current.connectionState !== ConnectionState.Connected;
	create.disabled = open.disabled = busy || current.isDirty;
	status.textContent =
		current.connectionState === ConnectionState.Connected
			? current.isDirty
				? "Saving changes..."
				: "Connected - all changes saved"
			: "Reconnecting - editing paused";
	render();
}

async function openDocument(id?: string) {
	if (busy) return;
	if (current?.isDirty) {
		report(
			new Error(
				"Wait for your changes to save before opening another document.",
			),
		);
		return;
	}
	busy = true;
	create.disabled = open.disabled = true;
	fields.disabled = true;
	error.hidden = true;
	status.textContent = id ? "Opening document..." : "Creating document...";
	render();
	let next: typeof current;
	try {
		if (id && new TextEncoder().encode(id).length > 256)
			throw new Error("Document ID must be at most 256 UTF-8 bytes.");
		next = id
			? (await client.getContainer(id)).container
			: (await client.createContainer()).container;
		const documentId = id ?? (await next.attach());
		switching = true;
		current?.dispose();
		current = next;
		next = undefined;
		switching = false;
		idInput.value = documentId;
		const url = new URL(location.href);
		url.search = "";
		url.searchParams.set("document", documentId);
		history.replaceState(null, "", url);
		shareUrl.value = url.href;
		share.hidden = false;
		current.initialObjects.map.on("valueChanged", render);
		current.on("connected", connection);
		current.on("disconnected", connection);
		current.on("saved", connection);
		current.on("dirty", connection);
		current.on("disposed", (cause) => {
			if (switching) return;
			fields.disabled = true;
			status.textContent = "Connection closed";
			render();
			report(
				cause ??
					new Error(
						"The connection closed. Open the document again to reconnect.",
					),
			);
		});
	} catch (cause) {
		next?.dispose();
		report(cause);
		if (!current) status.textContent = "Could not open document";
	} finally {
		busy = false;
		create.disabled = open.disabled = false;
		connection();
	}
}

create.addEventListener("click", () => {
	void openDocument();
});
element("open-form", HTMLFormElement).addEventListener("submit", (event) => {
	event.preventDefault();
	void openDocument(idInput.value);
});
element("entry-form", HTMLFormElement).addEventListener("submit", (event) => {
	event.preventDefault();
	if (!current || fields.disabled) return;
	try {
		current.initialObjects.map.set(keyInput.value, valueInput.value);
		keyInput.value = valueInput.value = "";
		keyInput.focus();
	} catch (cause) {
		report(cause);
	}
});
element("copy", HTMLButtonElement).addEventListener("click", async () => {
	try {
		await navigator.clipboard.writeText(shareUrl.value);
		status.textContent = "Link copied";
	} catch {
		report(
			new Error(
				"Could not copy the link. Select the share link and copy it manually.",
			),
		);
	}
});

async function start() {
	try {
		const response = await fetch("/app/config.json", { redirect: "error" });
		if (!response.ok)
			throw new Error(
				`App configuration failed (${response.status}). Reload the page to sign in again.`,
			);
		const config: unknown = await response.json();
		if (
			!config ||
			typeof config !== "object" ||
			!("endpoint" in config) ||
			typeof config.endpoint !== "string" ||
			!("tenantId" in config) ||
			typeof config.tenantId !== "string"
		)
			throw new Error("App configuration is invalid.");
		client = createClient(
			config.endpoint,
			createTokenProvider(),
			config.tenantId,
		);
		create.disabled = open.disabled = false;
		status.textContent = "Ready";
		const id = new URL(location.href).searchParams.get("document");
		if (id) await openDocument(id);
	} catch (cause) {
		status.textContent = "App could not start";
		report(cause);
	}
}

void start();

window.addEventListener("beforeunload", (event) => {
	if (current?.isDirty) event.preventDefault();
});
