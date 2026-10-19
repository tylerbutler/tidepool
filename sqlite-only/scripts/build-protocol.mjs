import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, constants, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const version = "1.19.2";
const archiveUrl = `https://github.com/gleam-lang/gleam/releases/download/v${version}/gleam-v${version}-x86_64-unknown-linux-musl.tar.gz`;
const archiveSha256 =
	"2ba2afb66ca9f6dcc01a4a6e9169b6942963bad6483bec9571ddc078cfe6f41f";
const protocol = fileURLToPath(new URL("../protocol", import.meta.url));

export class BuildError extends Error {
	/**
	 * @param {string} message
	 * @param {number} [exitCode]
	 */
	constructor(message, exitCode = 1) {
		super(message);
		this.exitCode = exitCode;
	}
}

/** @param {string} command */
function installedCompiler(command) {
	const result = spawnSync(command, ["--version"], { encoding: "utf8" });
	if (result.error && "code" in result.error && result.error.code === "ENOENT")
		return false;
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new BuildError(
			"Could not read the Gleam version",
			result.status ?? 1,
		);
	const match = /^gleam (\d+)\.(\d+)\.(\d+)$/.exec(result.stdout.trim());
	const [major, minor, patch] = match ? match.slice(1).map(Number) : [];
	if (
		major === undefined ||
		minor === undefined ||
		patch === undefined ||
		major < 1 ||
		(major === 1 && (minor < 19 || (minor === 19 && patch < 2)))
	)
		throw new BuildError(
			`Gleam ${version} or later is required; found ${result.stdout.trim()}`,
		);
	return true;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} [cwd]
 */
function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new BuildError(
			`${command} failed${result.signal ? ` (${result.signal})` : ""}`,
			result.status ??
				(result.signal ? 128 + constants.signals[result.signal] : 1),
		);
}

async function download() {
	const response = await fetch(archiveUrl, {
		signal: AbortSignal.timeout(60_000),
	});
	if (!response.ok || !response.body)
		throw new BuildError(`Gleam download failed: HTTP ${response.status}`);
	const reader = response.body.getReader();
	const chunks = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > 64 * 1_048_576) {
			await reader.cancel();
			throw new BuildError("Gleam download exceeds 64 MiB");
		}
		chunks.push(value);
	}
	const archive = Buffer.concat(chunks);
	if (createHash("sha256").update(archive).digest("hex") !== archiveSha256)
		throw new BuildError("Gleam download failed SHA-256 verification");
	return archive;
}

export async function buildProtocol() {
	let command = "gleam";
	let directory;
	try {
		if (!installedCompiler(command)) {
			if (platform() !== "linux" || arch() !== "x64")
				throw new BuildError(
					`Install Gleam ${version} or later, then run pnpm build:protocol again. Automatic setup supports Linux x86_64 only.`,
				);
			directory = await mkdtemp(join(tmpdir(), "tidepool-gleam-"));
			console.info(`Downloading Gleam ${version} for this build`);
			const archive = join(directory, "gleam.tar.gz");
			await writeFile(archive, await download());
			run("tar", ["-xzf", archive, "-C", directory, "gleam"]);
			command = join(directory, "gleam");
			if (!installedCompiler(command))
				throw new BuildError("The Gleam archive did not contain a compiler");
		}
		run(
			command,
			["build", "--target", "javascript", "--warnings-as-errors"],
			protocol,
		);
	} finally {
		if (directory) await rm(directory, { recursive: true, force: true });
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	buildProtocol().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = error instanceof BuildError ? error.exitCode : 1;
	});
}
