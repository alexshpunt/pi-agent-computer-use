import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The only native target this extension ships: Windows x64, also controlled from WSL. */
export type NativeTarget = "win32-x64";
/** Exact runtime release evidence pinned in the extension; files are checked before every start. */
export interface RuntimePins {
  format: 2;
  source: string;
  version: string;
  /** Base URL of the release assets, ending in a slash. */
  url: string;
  files: Record<string, string>;
}
/** Verified owned-child runtime selection. Never accepted from an agent tool argument. */
export interface BundledRuntime {
  command: string;
  root: string;
  target: NativeTarget;
  source: string;
  version: string;
  driverVersion: string;
  files: Record<string, string>;
}

const REQUIRED = ["cua-driver.exe", "cua-cursor-theme.exe", "cua-driver-uia.exe", "LICENSE.md", "THIRD_PARTY_NOTICES.md"];
/** Where the package carries its runtime: `native-runtime/win32-x64/runtime/<files>`. */
export const PACKAGED_RUNTIME = fileURLToPath(new URL("../native-runtime/win32-x64", import.meta.url));

/** Keep Windows-host control in WSL; other platforms have no shipped runtime. */
export function executionTarget(platform: string, arch: string, wsl: boolean): NativeTarget {
  const target = `${platform === "linux" && wsl ? "win32" : platform}-${arch}`;
  if (target !== "win32-x64")
    throw new Error(`unsupported_native_target: ${target}. Computer use ships a Windows x64 runtime only; run Pi on Windows or in WSL.`);
  return target;
}

/** Detect WSL without treating ordinary Linux or an unavailable interop endpoint as Windows. */
export async function isWsl(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  const release = await readFile("/proc/sys/kernel/osrelease", "utf8").catch(() => "");
  return /microsoft/i.test(release);
}

/** Read and validate the pins shipped with the extension. */
export async function readRuntimePins(): Promise<RuntimePins> {
  const pins: RuntimePins = JSON.parse(await readFile(new URL("./runtime-pins.json", import.meta.url), "utf8"));
  if (pins.format !== 2 || !/^[0-9a-f]{40}$/.test(pins.source) || !/^https:\/\/.+\/$/.test(pins.url)
    || Object.keys(pins.files).sort().join("\n") !== [...REQUIRED].sort().join("\n")
    || !Object.values(pins.files).every(hash => /^[0-9a-f]{64}$/.test(hash)))
    throw new Error("native_runtime_pin_invalid");
  return pins;
}

/** Recheck all pinned runtime companions before starting a native process; stream large files. */
export async function verifyBundledRuntime(runtime: BundledRuntime, signal?: AbortSignal): Promise<void> {
  if (Object.keys(runtime.files).sort().join("\n") !== [...REQUIRED].sort().join("\n"))
    throw new Error("native_runtime_files_mismatch");
  const directory = path.join(runtime.root, "runtime");
  for (const name of REQUIRED) {
    signal?.throwIfAborted();
    const file = path.join(directory, name);
    if (!(await stat(file).catch(() => undefined))?.isFile()) throw new Error(`native_runtime_file_missing: ${name}`);
    if (await realpath(file) !== file) throw new Error(`native_runtime_symlink_refused: ${name}`);
    const hash = createHash("sha256");
    for await (const block of createReadStream(file)) { signal?.throwIfAborted(); hash.update(block); }
    if (hash.digest("hex") !== runtime.files[name]) throw new Error(`native_runtime_hash_mismatch: ${name}`);
  }
  signal?.throwIfAborted();
}

/** Describe the pinned runtime in one directory and check every file, without executing it. */
export async function loadBundledRuntime(directory: string, pins: RuntimePins): Promise<BundledRuntime> {
  const root = await realpath(directory);
  const runtime = { root, command: path.join(root, "runtime", "cua-driver.exe"), target: "win32-x64" as const,
    source: pins.source, version: pins.version, driverVersion: pins.version, files: { ...pins.files } };
  await verifyBundledRuntime(runtime);
  return runtime;
}

/**
 * Download the pinned release files into `directory/runtime` when they are absent, and name their source in
 * `directory/runtime.source`. Each file must match its pinned hash before the set is moved into place. A download of
 * another source, left by a Git checkout before its pins changed, is moved aside to `runtime-<source>` and kept; any
 * other existing directory is never replaced.
 */
export async function fetchRuntime(directory: string, pins: RuntimePins, signal?: AbortSignal): Promise<void> {
  const target = path.join(directory, "runtime"), marker = path.join(directory, "runtime.source");
  if (await lstat(target).catch(() => undefined)) {
    const earlier = (await readFile(marker, "utf8").catch(() => "")).trim();
    if (!/^[0-9a-f]{40}$/.test(earlier) || earlier === pins.source) return;
    let aside = path.join(directory, `runtime-${earlier.slice(0, 8)}`);
    for (let n = 2; await lstat(aside).catch(() => undefined); n++) aside = path.join(directory, `runtime-${earlier.slice(0, 8)}-${n}`);
    await rename(target, aside);
  }
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(path.join(directory, ".staging-"));
  try {
    await mkdir(path.join(staging, "runtime"));
    for (const [name, expected] of Object.entries(pins.files)) {
      const response = await fetch(new URL(name, pins.url), { signal });
      if (!response.ok) throw new Error(`native_runtime_download_failed: ${name} (HTTP ${response.status})`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error(`native_runtime_hash_mismatch: ${name}`);
      await writeFile(path.join(staging, "runtime", name), bytes);
    }
    try { await rename(path.join(staging, "runtime"), target); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      return;
    }
    await writeFile(marker, `${pins.source}\n`);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

/** Copy checked Windows files to a source-specific host cache. Never replace an existing runtime. */
export async function cacheWindowsRuntime(runtime: BundledRuntime, base: string, signal?: AbortSignal): Promise<BundledRuntime> {
  if (!/^[0-9a-f]{40}$/.test(runtime.source)) throw new Error("native_runtime_cache_target_mismatch");
  await verifyBundledRuntime(runtime, signal);
  const parent = path.join(base, runtime.source);
  const root = path.join(parent, runtime.target);
  const cached = { ...runtime, root, command: path.join(root, "runtime", "cua-driver.exe") };
  const checkCache = async () => {
    if (await realpath(root) !== root) throw new Error("native_runtime_cache_symlink_refused");
    await verifyBundledRuntime(cached, signal);
    return cached;
  };
  if (await lstat(root).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  })) return checkCache();
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(path.join(parent, ".staging-"));
  try {
    await mkdir(path.join(staging, "runtime"));
    for (const name of REQUIRED) {
      signal?.throwIfAborted();
      await copyFile(path.join(runtime.root, "runtime", name), path.join(staging, "runtime", name));
    }
    await verifyBundledRuntime({ ...runtime, root: staging }, signal);
    try { await rename(staging, root); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    return await checkCache();
  } finally { await rm(staging, { recursive: true, force: true }); }
}

/** The Windows user's Local Application Data folder as a WSL path, through a bounded system query; never guessed. */
export async function windowsLocalAppData(interop?: string): Promise<string> {
  const run = promisify(execFile);
  const { stdout } = await run("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)",
  ], { timeout: 10_000, maxBuffer: 16_384, env: { ...process.env, ...(interop ? { WSL_INTEROP: interop } : {}) } });
  const local = stdout.trim();
  if (!/^[A-Za-z]:\\/.test(local) || /[\r\n]/.test(local)) throw new Error("native_runtime_windows_cache_unavailable");
  const mapped = (await run("wslpath", ["-u", local], { timeout: 5_000, maxBuffer: 16_384 })).stdout.trim();
  if (!path.isAbsolute(mapped)) throw new Error("native_runtime_windows_cache_unavailable");
  return mapped;
}

async function windowsCacheDirectory(interop?: string): Promise<string> {
  return path.join(await windowsLocalAppData(interop), "PiComputerUse", "native-runtimes");
}

/**
 * Select the runtime shipped in this package. A Git checkout has no packaged files, so they are downloaded once
 * from the pinned release with the same hash checks. From WSL the files run from a Windows-host cache.
 */
export async function findBundledRuntime(interop?: string): Promise<BundledRuntime> {
  executionTarget(process.platform, process.arch, await isWsl());
  const pins = await readRuntimePins();
  // A stalled first-use download must not hold session startup indefinitely.
  await fetchRuntime(PACKAGED_RUNTIME, pins, AbortSignal.timeout(300_000));
  const runtime = await loadBundledRuntime(PACKAGED_RUNTIME, pins).catch((error: unknown) => {
    // A download from before runtime.source existed, or a changed file, is never replaced on its own.
    if (error instanceof Error && /^native_runtime_(hash_mismatch|file_missing)/.test(error.message))
      throw new Error(`${error.message}. ${path.join(PACKAGED_RUNTIME, "runtime")} does not hold the pinned runtime ${pins.source.slice(0, 8)}; move that folder away and computer use downloads the pinned one.`);
    throw error;
  });
  return process.platform === "linux" ? cacheWindowsRuntime(runtime, await windowsCacheDirectory(interop)) : runtime;
}
