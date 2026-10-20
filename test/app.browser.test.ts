import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { secret } from "./runtime.js";

let app: Miniflare;
let core: Miniflare;
let browser: Browser;
let base: string;

function appOptions(endpoint: string) {
	return {
		name: "browser-app",
		modules: true,
		scriptPath: fileURLToPath(
			new URL("../dist/admin/token-worker.js", import.meta.url),
		),
		modulesRules: [
			{ type: "ESModule" as const, include: ["**/*.js"] },
			{ type: "Text" as const, include: ["**/*.css"] },
		],
		compatibilityDate: "2026-07-30",
		bindings: {
			TOKEN_AUTH_MODE: "anonymous",
			TENANT_ID: "fluid",
			JWT_SECRET: secret.padEnd(32, "-"),
			TIDEPOOL_URL: endpoint,
		},
	};
}

beforeAll(async () => {
	app = new Miniflare(appOptions("http://127.0.0.1:1"));
	base = (await app.ready).origin;
	core = new Miniflare({
		name: "tidepool-tests",
		modules: true,
		scriptPath: fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
		compatibilityDate: "2026-07-30",
		durableObjects: { DOCUMENTS: { className: "DocumentDO", useSQLite: true } },
		r2Buckets: ["CONTENT"],
		bindings: {
			TENANT_ID: "fluid",
			JWT_SECRET: secret.padEnd(32, "-"),
			ALLOWED_ORIGIN: base,
		},
	});
	const coreBase = (await core.ready).origin;
	await app.setOptions({
		...appOptions(coreBase),
		port: Number(new URL(base).port),
	});
	base = (await app.ready).origin;
	browser = await chromium.launch();
});

afterAll(async () => {
	await browser?.close();
	await app?.dispose();
	await core?.dispose();
});

it("creates, shares, edits, deletes, and reloads a document in real browsers", async () => {
	const first = await browser.newPage({
		viewport: { width: 1440, height: 1000 },
	});
	const second = await browser.newPage({
		viewport: { width: 390, height: 844 },
	});
	const failures: string[] = [];
	for (const page of [first, second])
		page.on("pageerror", (error) => failures.push(error.message));
	const loaded = await first.goto(`${base}/app/`);
	expect(loaded?.status(), await first.locator("body").innerText()).toBe(200);
	await first.getByRole("button", { name: "Create document" }).click();
	await expect
		.poll(
			async () =>
				(await first.locator("#error").isVisible()) ||
				(await first.locator("#share-url").isVisible()),
			{ timeout: 20_000 },
		)
		.toBe(true);
	expect(await first.locator("#error").textContent()).toBe("");
	await first.locator("#share-url").waitFor({ state: "visible" });
	const link = await first.locator("#share-url").inputValue();
	await first.locator("#key").fill("greeting");
	await first.locator("#value").fill("Hello from the first window");
	await first.getByRole("button", { name: "Set value" }).click();
	await second.goto(link);
	await expect
		.poll(() => second.locator("#entries").textContent())
		.toContain("Hello from the first window");
	await second.locator("#key").fill("greeting");
	await second.locator("#value").fill("<script>shared text, not HTML</script>");
	await second.getByRole("button", { name: "Set value" }).click();
	await expect
		.poll(() => first.locator("#entries").textContent())
		.toContain("<script>shared text, not HTML</script>");
	await first.reload();
	await expect
		.poll(() => first.locator("#entries").textContent())
		.toContain("<script>shared text, not HTML</script>");
	await first.getByRole("button", { name: "Delete greeting" }).focus();
	await second.locator("#key").fill("greeting");
	await second.locator("#value").fill("Updated while Delete has focus");
	await second.getByRole("button", { name: "Set value" }).click();
	await expect
		.poll(() => first.locator("#entries").textContent())
		.toContain("Updated while Delete has focus");
	expect(
		await first
			.getByRole("button", { name: "Delete greeting" })
			.evaluate((node) => node === document.activeElement),
	).toBe(true);
	await first.getByRole("button", { name: "Delete greeting" }).press("Enter");
	await expect.poll(() => second.locator("#entries tr").count()).toBe(0);
	expect(
		await first
			.locator("#key")
			.evaluate((node) => node === document.activeElement),
	).toBe(true);
	await first.locator("#key").fill("project");
	await first.locator("#value").fill("Tidepool browser app");
	await first.getByRole("button", { name: "Set value" }).click();
	await expect
		.poll(() => second.locator("#entries").textContent())
		.toContain("Tidepool browser app");
	for (const page of [first, second]) {
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true);
		expect(await page.locator("#error").isVisible()).toBe(false);
	}
	await mkdir(".impeccable/review", { recursive: true });
	await first.screenshot({
		path: ".impeccable/review/desktop.png",
		fullPage: true,
	});
	await second.screenshot({
		path: ".impeccable/review/mobile.png",
		fullPage: true,
	});
	expect(failures).toEqual([]);
	await first.close();
	await second.close();
}, 60_000);
