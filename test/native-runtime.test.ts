import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  cacheWindowsRuntime, executionTarget, fetchRuntime, loadBundledRuntime, readRuntimePins, verifyBundledRuntime, type RuntimePins,
} from "../src/native-runtime.ts";

const NAMES = ["cua-driver.exe", "cua-cursor-theme.exe", "cua-driver-uia.exe", "LICENSE.md", "THIRD_PARTY_NOTICES.md"];
const owned: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
  await Promise.all(owned.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function scratch(prefix: string) {
  await mkdir(".tmp", { recursive: true });
  const dir = await mkdtemp(path.resolve(".tmp", prefix)); owned.push(dir);
  return dir;
}
/** Synthetic release assets and the format-2 pins that describe them. */
function release(url = "https://example.invalid/release/") {
  const bytes = Object.fromEntries(NAMES.map(name => [name, Buffer.from(`fixture-${name}`)]));
  const files = Object.fromEntries(NAMES.map(name => [name, createHash("sha256").update(bytes[name]!).digest("hex")]));
  const pins: RuntimePins = { format: 2, source: "a".repeat(40), version: "0.37.0", url, files };
  return { bytes, pins };
}
/** A package directory holding runtime/<files>, as prepack leaves it. */
async function installedRuntime() {
  const root = await scratch("bundled-runtime-");
  const { bytes, pins } = release();
  await mkdir(path.join(root, "runtime"));
  for (const name of NAMES) await writeFile(path.join(root, "runtime", name), bytes[name]!);
  return { root, pins };
}
/** Serve release assets on loopback; an asset can be replaced or withheld per test. */
async function assetServer(assets: Record<string, Buffer>) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? "").split("/").pop() ?? "");
    requests.push(name);
    const body = assets[name];
    if (!body) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": "application/octet-stream" }).end(body);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback port.");
  return { url: `http://127.0.0.1:${address.port}/release/`, requests };
}

test("Windows-host cache copies all pinned companions once, checks every reuse, and never overwrites changed bytes", async () => {
  const { root, pins } = await installedRuntime();
  const runtime = await loadBundledRuntime(root, pins);
  const cache = await scratch("runtime-cache-");
  const [first, second] = await Promise.all([cacheWindowsRuntime(runtime, cache), cacheWindowsRuntime(runtime, cache)]);
  expect(first.command).toBe(second.command);
  expect(first.command).not.toBe(runtime.command);
  await expect(verifyBundledRuntime(first)).resolves.toBeUndefined();
  await writeFile(first.command, "foreign changed bytes");
  await expect(cacheWindowsRuntime(runtime, cache)).rejects.toThrow("native_runtime_hash_mismatch");
  expect(await readFile(first.command, "utf8")).toBe("foreign changed bytes");
  expect((await readdir(path.join(cache, pins.source))).sort()).toEqual(["win32-x64"]);
});

test("cache refuses changed package bytes and cancellation without leaving staging or launching input", async () => {
  const { root, pins } = await installedRuntime();
  const runtime = await loadBundledRuntime(root, pins);
  const cache = await scratch("runtime-cache-");
  await expect(cacheWindowsRuntime(runtime, cache, AbortSignal.abort())).rejects.toThrow();
  await writeFile(runtime.command, "changed package");
  await expect(cacheWindowsRuntime(runtime, cache)).rejects.toThrow("native_runtime_hash_mismatch");
  expect(await readdir(cache)).toEqual([]);
});

test("only Windows x64 is shipped: WSL maps to Windows, other platforms refuse", () => {
  expect(executionTarget("linux", "x64", true)).toBe("win32-x64");
  expect(executionTarget("win32", "x64", false)).toBe("win32-x64");
  for (const [platform, arch, wsl] of [["linux", "x64", false], ["darwin", "x64", false], ["darwin", "arm64", false],
    ["linux", "arm64", true], ["win32", "arm64", false]] as const)
    expect(() => executionTarget(platform, arch, wsl)).toThrow("unsupported_native_target");
});

test("the packaged runtime resolves its pinned command with complete companions and notices, without executing it", async () => {
  const { root, pins } = await installedRuntime();
  const runtime = await loadBundledRuntime(root, pins);
  expect(runtime).toMatchObject({ command: path.join(root, "runtime", "cua-driver.exe"), source: pins.source, target: "win32-x64",
    version: pins.version, driverVersion: pins.version, files: pins.files });
  await expect(verifyBundledRuntime(runtime)).resolves.toBeUndefined();
});

test("a changed companion, a missing notice or a symlinked file refuse before startup", async () => {
  const { root, pins } = await installedRuntime();
  const runtime = await loadBundledRuntime(root, pins);
  await writeFile(path.join(root, "runtime", "cua-driver-uia.exe"), "changed");
  await expect(verifyBundledRuntime(runtime)).rejects.toThrow("native_runtime_hash_mismatch: cua-driver-uia.exe");
  await expect(loadBundledRuntime(root, pins)).rejects.toThrow("native_runtime_hash_mismatch: cua-driver-uia.exe");

  const other = await installedRuntime();
  await rm(path.join(other.root, "runtime", "LICENSE.md"));
  await expect(loadBundledRuntime(other.root, other.pins)).rejects.toThrow("native_runtime_file_missing: LICENSE.md");

  const linked = await installedRuntime();
  const elsewhere = path.join(linked.root, "elsewhere.exe");
  await writeFile(elsewhere, `fixture-cua-driver.exe`);
  await rm(path.join(linked.root, "runtime", "cua-driver.exe"));
  await symlink(elsewhere, path.join(linked.root, "runtime", "cua-driver.exe"));
  await expect(loadBundledRuntime(linked.root, linked.pins)).rejects.toThrow("native_runtime_symlink_refused: cua-driver.exe");
});

test("a runtime whose file set differs from the five pinned names never verifies", async () => {
  const { root, pins } = await installedRuntime();
  const runtime = await loadBundledRuntime(root, pins);
  const { ["cua-driver-uia.exe"]: _, ...fewer } = runtime.files;
  await expect(verifyBundledRuntime({ ...runtime, files: fewer })).rejects.toThrow("native_runtime_files_mismatch");
  await expect(verifyBundledRuntime({ ...runtime, files: { ...runtime.files, "extra.dll": "0".repeat(64) } })).rejects.toThrow("native_runtime_files_mismatch");
});

test("the shipped pins are a valid format-2 Windows release", async () => {
  const pins = await readRuntimePins();
  expect(pins).toMatchObject({ format: 2, url: expect.stringMatching(/^https:\/\/.+\/$/) });
  expect(Object.keys(pins.files).sort()).toEqual([...NAMES].sort());
  expect(Object.values(pins.files).every(hash => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
});

test("fetchRuntime downloads every pinned file from loopback, checks it and does not download again", async () => {
  const { bytes } = release();
  const server = await assetServer(bytes);
  const { pins } = release(server.url);
  const directory = await scratch("fetched-runtime-");
  await fetchRuntime(directory, pins);
  expect((await readdir(directory)).sort()).toEqual(["runtime"]);
  expect((await readdir(path.join(directory, "runtime"))).sort()).toEqual([...NAMES].sort());
  await expect(loadBundledRuntime(directory, pins)).resolves.toMatchObject({ command: path.join(directory, "runtime", "cua-driver.exe") });
  expect([...server.requests].sort()).toEqual([...NAMES].sort());
  await fetchRuntime(directory, pins);
  expect(server.requests).toHaveLength(NAMES.length);
});

test("fetchRuntime refuses a wrong hash or a missing asset without leaving a runtime or staging directory", async () => {
  const { bytes } = release();
  const tampered = await assetServer({ ...bytes, "cua-driver.exe": Buffer.from("tampered") });
  const wrong = await scratch("fetched-runtime-");
  await expect(fetchRuntime(wrong, release(tampered.url).pins)).rejects.toThrow("native_runtime_hash_mismatch: cua-driver.exe");
  expect(await readdir(wrong)).toEqual([]);

  const { ["THIRD_PARTY_NOTICES.md"]: _, ...partial } = bytes;
  const missing = await assetServer(partial);
  const absent = await scratch("fetched-runtime-");
  await expect(fetchRuntime(absent, release(missing.url).pins)).rejects.toThrow("native_runtime_download_failed: THIRD_PARTY_NOTICES.md (HTTP 404)");
  expect(await readdir(absent)).toEqual([]);
});
