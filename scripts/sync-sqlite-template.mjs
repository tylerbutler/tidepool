import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const template = new URL("sqlite-only/", root);
const check = process.argv.includes("--check");
const files = [
	".dev.vars.example",
	"LICENSE",
	"pnpm-workspace.yaml",
	"src/auth.ts",
	"src/common.ts",
	"src/connector.ts",
	"src/directory.ts",
	"src/document.ts",
	"src/historian.ts",
	"src/protocol.ts",
	"src/storage.ts",
	"src/worker.ts",
	"scripts/build-protocol.mjs",
	"protocol/gleam.toml",
	"protocol/manifest.toml",
	"protocol/src/adapter.gleam",
	"protocol/src/tidepool_protocol.gleam",
	"token-service/src/connector.ts",
];

const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
pkg.name = "@tylerbu/tidepool-sqlite";
pkg.description =
	"A Fluid Framework server using SQLite Durable Objects, without R2";
delete pkg.cloudflare.bindings.CONTENT;
pkg.cloudflare.bindings.DOCUMENTS.description =
	"SQLite-backed Durable Objects for all document data, connections, and the document directory. No R2 bucket is needed.";
pkg.scripts = {
	"build:protocol": "node scripts/build-protocol.mjs",
	build: "pnpm build:protocol && wrangler deploy --dry-run --outdir dist",
	deploy: "wrangler deploy",
	typecheck: "pnpm build:protocol && tsc --noEmit",
	dev: "pnpm build:protocol && wrangler dev --ip 127.0.0.1 --port 8787",
};
pkg.devDependencies = Object.fromEntries(
	["@cloudflare/workers-types", "typescript", "wrangler"].map((name) => [
		name,
		pkg.devDependencies[name],
	]),
);
const config = JSON.parse(
	await readFile(new URL("wrangler.jsonc", root), "utf8"),
);
config.name = "tidepool-sqlite";
delete config.r2_buckets;
const tsconfig = JSON.parse(
	await readFile(new URL("tsconfig.json", root), "utf8"),
);
tsconfig.compilerOptions.types = ["@cloudflare/workers-types"];
tsconfig.include = ["src/**/*.ts", "token-service/src/connector.ts"];

const generated = new Map([
	["package.json", `${JSON.stringify(pkg, null, "\t")}\n`],
	["wrangler.jsonc", `${JSON.stringify(config, null, "\t")}\n`],
	["tsconfig.json", `${JSON.stringify(tsconfig, null, "\t")}\n`],
]);
for (const path of files)
	generated.set(path, await readFile(new URL(path, root), "utf8"));

let stale = false;
for (const [path, contents] of generated) {
	const target = new URL(path, template);
	if (check) {
		let current;
		try {
			current = await readFile(target, "utf8");
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!("code" in error) ||
				error.code !== "ENOENT"
			)
				throw error;
		}
		if (current !== contents) {
			console.error(
				`sqlite-only/${path} is stale; run pnpm sync:sqlite-template`,
			);
			stale = true;
		}
	} else {
		await mkdir(dirname(fileURLToPath(target)), { recursive: true });
		await writeFile(target, contents);
	}
}
if (stale) process.exitCode = 1;
