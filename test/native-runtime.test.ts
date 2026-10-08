import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { cacheWindowsRuntime, executionTarget, loadBundledRuntime, verifyBundledRuntime, type RuntimePins } from "../src/native-runtime.ts";

const owned: string[] = [];
afterEach(async () => { await Promise.all(owned.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function installedPackage(target: "win32-x64" | "linux-x64" = "win32-x64") {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp", "bundled-runtime-")); owned.push(root);
  await mkdir(path.join(root, "runtime"));
  const names = target === "win32-x64" ? ["cua-driver.exe", "cua-cursor-theme.exe", "cua-driver-uia.exe"] : ["cua-driver", "cua-cursor-theme"];
  names.push("LICENSE.md", "THIRD_PARTY_NOTICES.md");
  const files: Record<string, string> = {};
  for (const name of names) {
    const bytes = Buffer.from(`fixture-${target}-${name}`);
    files[name] = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path.join(root, "runtime", name), bytes);
  }
  const pins: RuntimePins = { format: 1, source: "a".repeat(40), version: "0.34.0-dev.aaaaaaaaaaaa", driverVersion: "0.34.0", targets: { [target]: { files } } };
  await writeFile(path.join(root, "runtime.json"), JSON.stringify({ format: 1, target, source: pins.source, version: pins.version, driver_version: pins.driverVersion, files, command: `runtime/${names[0]}` }));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: `@alexshp/cua-runtime-${target}`, version: pins.version }));
  return { root, pins, files };
}

test("Windows-host cache copies all pinned companions once, checks every reuse, and never overwrites changed bytes", async () => {
  const { root, pins } = await installedPackage();
  const runtime = await loadBundledRuntime(root, "win32-x64", pins);
  const cache = await mkdtemp(path.resolve(".tmp", "runtime-cache-")); owned.push(cache);
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
  const { root, pins } = await installedPackage();
  const runtime = await loadBundledRuntime(root, "win32-x64", pins);
  const cache = await mkdtemp(path.resolve(".tmp", "runtime-cache-")); owned.push(cache);
  const cancelled = AbortSignal.abort();
  await expect(cacheWindowsRuntime(runtime, cache, cancelled)).rejects.toThrow();
  await writeFile(runtime.command, "changed package");
  await expect(cacheWindowsRuntime(runtime, cache)).rejects.toThrow("native_runtime_hash_mismatch");
  expect(await readdir(cache)).toEqual([]);
});
test("automatic execution target keeps WSL on Windows without confusing Linux or either Mac architecture", () => {
  expect(executionTarget("linux", "x64", true)).toBe("win32-x64");
  expect(executionTarget("linux", "x64", false)).toBe("linux-x64");
  expect(executionTarget("win32", "x64", false)).toBe("win32-x64");
  expect(executionTarget("darwin", "x64", false)).toBe("darwin-x64");
  expect(executionTarget("darwin", "arm64", false)).toBe("darwin-arm64");
  expect(() => executionTarget("linux", "arm64", false)).toThrow("unsupported_native_target");
});

test("installed package resolves a pinned command with complete companions and notices, without executing it", async () => {
  const { root, pins } = await installedPackage();
  const runtime = await loadBundledRuntime(root, "win32-x64", pins);
  expect(runtime.command).toBe(path.join(root, "runtime", "cua-driver.exe"));
  expect(runtime.source).toBe(pins.source);
  expect(runtime.target).toBe("win32-x64");
  await expect(verifyBundledRuntime(runtime)).resolves.toBeUndefined();
});

test("wrong target, source, package version and changed companion refuse before startup", async () => {
  const { root, pins } = await installedPackage();
  await expect(loadBundledRuntime(root, "linux-x64", pins)).rejects.toThrow("native_runtime_target_mismatch");
  await expect(loadBundledRuntime(root, "win32-x64", { ...pins, source: "b".repeat(40) })).rejects.toThrow("native_runtime_source_mismatch");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@alexshp/cua-runtime-win32-x64", version: "0.34.0-dev.wrong" }));
  await expect(loadBundledRuntime(root, "win32-x64", pins)).rejects.toThrow("native_runtime_package_mismatch");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@alexshp/cua-runtime-win32-x64", version: pins.version }));
  const runtime = await loadBundledRuntime(root, "win32-x64", pins);
  await writeFile(path.join(root, "runtime", "cua-driver-uia.exe"), "changed");
  await expect(verifyBundledRuntime(runtime)).rejects.toThrow("native_runtime_hash_mismatch: cua-driver-uia.exe");
});

test("missing notices and unsafe manifest commands cannot substitute another executable", async () => {
  const { root, pins } = await installedPackage("linux-x64");
  await rm(path.join(root, "runtime", "LICENSE.md"));
  await expect(loadBundledRuntime(root, "linux-x64", pins)).rejects.toThrow("native_runtime_file_missing: LICENSE.md");
  await writeFile(path.join(root, "runtime.json"), JSON.stringify({ format: 1, target: "linux-x64", source: pins.source, version: pins.version, driver_version: pins.driverVersion, files: pins.targets["linux-x64"]!.files, command: "../other-executable" }));
  await expect(loadBundledRuntime(root, "linux-x64", pins)).rejects.toThrow("native_runtime_command_mismatch");
});
