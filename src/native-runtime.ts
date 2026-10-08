import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import path from "node:path";

/** Build targets shipped by this extension; execution target is separate from the npm host. */
export type NativeTarget = "win32-x64" | "linux-x64" | "darwin-x64" | "darwin-arm64";
/** Complete-set evidence pinned in the extension, not trusted from installed package metadata. */
export interface RuntimePins {
  format: 1;
  source: string;
  version: string;
  driverVersion: string;
  targets: Partial<Record<NativeTarget, { files: Record<string, string> }>>;
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

/** Keep Windows-host control in WSL; reject targets outside the approved build matrix. */
export function executionTarget(platform: string, arch: string, wsl: boolean): NativeTarget {
  const os = platform === "linux" && wsl ? "win32" : platform;
  const target = `${os}-${arch}`;
  if (!["win32-x64", "linux-x64", "darwin-x64", "darwin-arm64"].includes(target))
    throw new Error(`unsupported_native_target: ${target}`);
  return target as NativeTarget;
}

/** Detect WSL without treating ordinary Linux or an unavailable interop endpoint as Windows. */
export async function isWsl(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  const release = await readFile("/proc/sys/kernel/osrelease", "utf8").catch(() => "");
  return /microsoft/i.test(release);
}

const requiredFiles = (target: NativeTarget): string[] => target === "win32-x64"
  ? ["cua-driver.exe", "cua-cursor-theme.exe", "cua-driver-uia.exe", "LICENSE.md", "THIRD_PARTY_NOTICES.md"]
  : ["cua-driver", "cua-cursor-theme", "LICENSE.md", "THIRD_PARTY_NOTICES.md"];

/** Recheck all pinned runtime companions before starting a native process; stream large files. */
export async function verifyBundledRuntime(runtime: BundledRuntime, signal?: AbortSignal): Promise<void> {
  const expected = requiredFiles(runtime.target);
  if (Object.keys(runtime.files).sort().join("\n") !== expected.sort().join("\n"))
    throw new Error("native_runtime_files_mismatch");
  const directory = path.join(runtime.root, "runtime");
  for (const name of expected) {
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

/** Resolve one installed package against extension-owned evidence, without executing or downloading it. */
export async function loadBundledRuntime(directory: string, target: NativeTarget, pins: RuntimePins): Promise<BundledRuntime> {
  if (pins.format !== 1 || !/^[0-9a-f]{40}$/.test(pins.source)) throw new Error("native_runtime_pin_invalid");
  const root = await realpath(directory);
  const manifest = JSON.parse(await readFile(path.join(root, "runtime.json"), "utf8"));
  const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (manifest.format !== 1 || manifest.target !== target) throw new Error("native_runtime_target_mismatch");
  if (manifest.source !== pins.source) throw new Error("native_runtime_source_mismatch");
  const files = pins.targets[target]?.files;
  if (!files || manifest.driver_version !== pins.driverVersion || manifest.version !== pins.version
    || JSON.stringify(Object.entries(manifest.files ?? {}).sort()) !== JSON.stringify(Object.entries(files).sort()))
    throw new Error("native_runtime_pin_mismatch");
  if (metadata.name !== `@alexshp/cua-runtime-${target}` || metadata.version !== pins.version)
    throw new Error("native_runtime_package_mismatch");
  const command = `runtime/${target === "win32-x64" ? "cua-driver.exe" : "cua-driver"}`;
  if (manifest.command !== command) throw new Error("native_runtime_command_mismatch");
  const runtime = { root, command: path.join(root, command), target, source: pins.source,
    version: pins.version, driverVersion: pins.driverVersion, files: { ...files } };
  await verifyBundledRuntime(runtime);
  return runtime;
}

/** Copy checked Windows files to a source-specific host cache. Never replace an existing runtime. */
export async function cacheWindowsRuntime(runtime: BundledRuntime, base: string, signal?: AbortSignal): Promise<BundledRuntime> {
  if (runtime.target !== "win32-x64" || !/^[0-9a-f]{40}$/.test(runtime.source))
    throw new Error("native_runtime_cache_target_mismatch");
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
    for (const name of requiredFiles(runtime.target)) {
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

/** Read the Windows user's cache location through a bounded system query; do not guess a user or install location. */
async function windowsCacheDirectory(interop?: string): Promise<string> {
  const run = promisify(execFile);
  const { stdout } = await run("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)",
  ], { timeout: 10_000, maxBuffer: 16_384, env: { ...process.env, ...(interop ? { WSL_INTEROP: interop } : {}) } });
  const local = stdout.trim();
  if (!/^[A-Za-z]:\\/.test(local) || /[\r\n]/.test(local)) throw new Error("native_runtime_windows_cache_unavailable");
  const mapped = (await run("wslpath", ["-u", local], { timeout: 5_000, maxBuffer: 16_384 })).stdout.trim();
  if (!path.isAbsolute(mapped)) throw new Error("native_runtime_windows_cache_unavailable");
  return path.join(mapped, "PiComputerUse", "native-runtimes");
}
/** Select the pinned platform package already installed with the extension; no first-use network access. */
export async function findBundledRuntime(interop?: string): Promise<BundledRuntime> {
  const target = executionTarget(process.platform, process.arch, await isWsl());
  const pins: RuntimePins = JSON.parse(await readFile(new URL("./runtime-pins.json", import.meta.url), "utf8"));
  let directory: string;
  try { directory = path.dirname(createRequire(import.meta.url).resolve(`@alexshp/cua-runtime-${target}/package.json`)); }
  catch { throw new Error(`native_runtime_package_missing: @alexshp/cua-runtime-${target}. Reinstall the extension with optional dependencies; no driver will be downloaded at first use.`); }
  const runtime = await loadBundledRuntime(directory, target, pins);
  return target === "win32-x64" && process.platform === "linux"
    ? cacheWindowsRuntime(runtime, await windowsCacheDirectory(interop)) : runtime;
}
