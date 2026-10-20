import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await mkdir(new URL("../dist/app/", import.meta.url), { recursive: true });
await build({
	entryPoints: ["app/main.ts"],
	outdir: "dist/app",
	entryNames: "app",
	bundle: true,
	minify: true,
	platform: "browser",
	format: "esm",
	target: "es2022",
	define: { "process.env.NODE_ENV": '"production"' },
});
await copyFile("app/index.html", "dist/app/index.html");

// Avoid the Static Assets router: it does not forward ctx.access to the Worker.
const files = [
	["/", "index.html", "text/html; charset=utf-8"],
	["/app.js", "app.js", "text/javascript; charset=utf-8"],
	["/app.css", "app.css", "text/css; charset=utf-8"],
];
const assets = Object.fromEntries(
	await Promise.all(
		files.map(async ([path, file, contentType]) => [
			path,
			{ body: await readFile(`dist/app/${file}`, "utf8"), contentType },
		]),
	),
);
await writeFile(
	"dist/app-assets.js",
	`export default ${JSON.stringify(assets)};\n`,
);
