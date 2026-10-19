import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildProtocol } from "../scripts/build-protocol.mjs";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("node:fs/promises", () => ({
	mkdtemp: vi.fn(async () => "/tmp/tidepool-gleam-test"),
	rm: vi.fn(async () => {}),
	writeFile: vi.fn(async () => {}),
}));
vi.mock("node:os", async (original) => ({
	...(await original<typeof import("node:os")>()),
	platform: vi.fn(() => "linux"),
	arch: vi.fn(() => "x64"),
}));
vi.mock("node:crypto", async (original) => {
	const actual = await original<typeof import("node:crypto")>();
	return { ...actual, createHash: vi.fn(actual.createHash) };
});

const fetchArchive = vi.fn<typeof fetch>();

function completed(
	stdout = "",
	status: number | null = 0,
): SpawnSyncReturns<string> {
	return {
		pid: 1,
		output: [null, stdout, ""],
		stdout,
		stderr: "",
		status,
		signal: null,
	};
}

function missing(): SpawnSyncReturns<string> {
	return {
		...completed("", null),
		error: Object.assign(new Error("gleam not found"), { code: "ENOENT" }),
	};
}

async function trustedArchive() {
	const actual =
		await vi.importActual<typeof import("node:crypto")>("node:crypto");
	const hash = actual.createHash("sha256");
	vi.spyOn(hash, "digest").mockReturnValue(
		"2ba2afb66ca9f6dcc01a4a6e9169b6942963bad6483bec9571ddc078cfe6f41f",
	);
	vi.mocked(createHash).mockReturnValueOnce(hash);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(platform).mockReset().mockReturnValue("linux");
	vi.mocked(arch).mockReset().mockReturnValue("x64");
	vi.mocked(spawnSync).mockReset().mockReturnValue(completed());
	vi.stubGlobal("fetch", fetchArchive);
	fetchArchive.mockReset().mockResolvedValue(new Response("archive fixture"));
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it.each([
	"1.19.2",
	"1.20.0",
	"2.0.0",
])("uses installed Gleam %s without a download", async (version) => {
	vi.mocked(spawnSync).mockReturnValueOnce(completed(`gleam ${version}\n`));
	await buildProtocol();
	expect(fetchArchive).not.toHaveBeenCalled();
	expect(spawnSync).toHaveBeenLastCalledWith(
		"gleam",
		["build", "--target", "javascript", "--warnings-as-errors"],
		{ cwd: expect.stringMatching(/\/protocol$/), stdio: "inherit" },
	);
});

it.each([
	"1.16.0",
	"1.19.1",
	"1.19.2-rc1",
	"unrecognized",
])("rejects unsupported compiler %s instead of silently replacing it", async (version) => {
	vi.mocked(spawnSync).mockReturnValueOnce(completed(`gleam ${version}`));
	await expect(buildProtocol()).rejects.toThrow("1.19.2 or later is required");
	expect(fetchArchive).not.toHaveBeenCalled();
	expect(spawnSync).toHaveBeenCalledTimes(1);
});

it("downloads and verifies the pinned Linux compiler before extraction, then cleans it up", async () => {
	vi.mocked(spawnSync)
		.mockReturnValueOnce(missing())
		.mockReturnValueOnce(completed())
		.mockReturnValueOnce(completed("gleam 1.19.2"));
	await trustedArchive();
	await buildProtocol();
	expect(fetchArchive).toHaveBeenCalledWith(
		"https://github.com/gleam-lang/gleam/releases/download/v1.19.2/gleam-v1.19.2-x86_64-unknown-linux-musl.tar.gz",
		{ signal: expect.any(AbortSignal) },
	);
	expect(writeFile).toHaveBeenCalledWith(
		"/tmp/tidepool-gleam-test/gleam.tar.gz",
		Buffer.from("archive fixture"),
	);
	expect(spawnSync).toHaveBeenNthCalledWith(
		2,
		"tar",
		[
			"-xzf",
			"/tmp/tidepool-gleam-test/gleam.tar.gz",
			"-C",
			"/tmp/tidepool-gleam-test",
			"gleam",
		],
		{ cwd: undefined, stdio: "inherit" },
	);
	expect(spawnSync).toHaveBeenLastCalledWith(
		"/tmp/tidepool-gleam-test/gleam",
		["build", "--target", "javascript", "--warnings-as-errors"],
		{ cwd: expect.stringMatching(/\/protocol$/), stdio: "inherit" },
	);
	expect(rm).toHaveBeenCalledExactlyOnceWith("/tmp/tidepool-gleam-test", {
		recursive: true,
		force: true,
	});
});

it.each([
	["darwin", "arm64"],
	["linux", "arm64"],
] as const)("requires a manual installation when Gleam is missing on %s/%s", async (os, cpu) => {
	vi.mocked(spawnSync).mockReturnValueOnce(missing());
	vi.mocked(platform).mockReturnValueOnce(os);
	vi.mocked(arch).mockReturnValueOnce(cpu);
	await expect(buildProtocol()).rejects.toThrow(
		"Automatic setup supports Linux x86_64 only",
	);
	expect(fetchArchive).not.toHaveBeenCalled();
	expect(mkdtemp).not.toHaveBeenCalled();
});

it("does not treat compiler execution errors as a missing compiler", async () => {
	vi.mocked(spawnSync).mockReturnValueOnce({
		...missing(),
		error: Object.assign(new Error("permission denied"), { code: "EACCES" }),
	});
	await expect(buildProtocol()).rejects.toThrow("permission denied");
	expect(fetchArchive).not.toHaveBeenCalled();
});

it.each([
	"http",
	"network",
	"checksum",
	"oversize",
])("cleans up after a %s download failure without extracting or compiling", async (failure) => {
	vi.mocked(spawnSync).mockReturnValueOnce(missing());
	if (failure === "http")
		fetchArchive.mockResolvedValueOnce(new Response(null, { status: 503 }));
	if (failure === "network")
		fetchArchive.mockRejectedValueOnce(new Error("network unavailable"));
	if (failure === "oversize")
		fetchArchive.mockResolvedValueOnce(
			new Response(new Uint8Array(64 * 1_048_576 + 1)),
		);
	await expect(buildProtocol()).rejects.toThrow(
		failure === "http"
			? "HTTP 503"
			: failure === "network"
				? "network unavailable"
				: failure === "oversize"
					? "exceeds 64 MiB"
					: "SHA-256 verification",
	);
	expect(spawnSync).toHaveBeenCalledTimes(1);
	expect(writeFile).not.toHaveBeenCalled();
	expect(rm).toHaveBeenCalledExactlyOnceWith("/tmp/tidepool-gleam-test", {
		recursive: true,
		force: true,
	});
});

it("preserves a compiler failure status and cleans up a downloaded compiler", async () => {
	vi.mocked(spawnSync)
		.mockReturnValueOnce(missing())
		.mockReturnValueOnce(completed())
		.mockReturnValueOnce(completed("gleam 1.19.2"))
		.mockReturnValueOnce(completed("", 7));
	await trustedArchive();
	await expect(buildProtocol()).rejects.toMatchObject({ exitCode: 7 });
	expect(rm).toHaveBeenCalledOnce();
});

it("preserves compiler signal failure as a nonzero shell exit code", async () => {
	vi.mocked(spawnSync)
		.mockReturnValueOnce(completed("gleam 1.19.2"))
		.mockReturnValueOnce({ ...completed("", null), signal: "SIGTERM" });
	await expect(buildProtocol()).rejects.toMatchObject({
		exitCode: 143,
	});
});
