import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fetchRuntime, loadBundledRuntime, PACKAGED_RUNTIME, readRuntimePins, type BundledRuntime } from "./native-runtime.ts";
import { runPowerShell, WINDOWS_POWERSHELL, type CommandRunner } from "./runner.ts";
import { RemotePreparationUncertain } from "./remote-provision-error.ts";

/** The package's own checked runtime; a Git checkout obtains it through the same path as local use. */
async function localRuntime(signal?: AbortSignal): Promise<BundledRuntime> {
  const pins = await readRuntimePins();
  await fetchRuntime(PACKAGED_RUNTIME, pins, signal);
  return loadBundledRuntime(PACKAGED_RUNTIME, pins);
}

/** Ask the remote Windows host for its own user folder; never guess a Windows username. */
async function remoteLocalAppData(runner: CommandRunner, signal?: AbortSignal): Promise<string> {
  const windows = await runPowerShell(runner, WINDOWS_POWERSHELL,
    "[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)", { signal, timeoutMs: 15_000 });
  if (!/^[A-Za-z]:\\/.test(windows) || /[\r\n]/.test(windows)) throw new Error("remote_runtime_local_appdata_unavailable");
  const native = (await runner.run("wslpath", ["-u", windows], { signal, timeoutMs: 10_000 })).trim();
  if (!path.posix.isAbsolute(native) || /[\r\n]/.test(native)) throw new Error("remote_runtime_local_appdata_unavailable");
  return native;
}

interface RemoteRuntimeDeps {
  localRuntime(signal?: AbortSignal): Promise<BundledRuntime>;
  remoteLocalAppData(runner: CommandRunner, signal?: AbortSignal): Promise<string>;
}
const defaultDeps: RemoteRuntimeDeps = { localRuntime, remoteLocalAppData };

/** Copy the checked package runtime to an immutable remote cache and return its remote WSL executable path. */
export async function prepareRemoteRuntime(runner: CommandRunner, signal?: AbortSignal, deps: RemoteRuntimeDeps = defaultDeps): Promise<string> {
  signal?.throwIfAborted();
  const runtime = await deps.localRuntime(signal);
  if (!/^[a-f0-9]{40}$/.test(runtime.source) || runtime.target !== "win32-x64") throw new Error("remote_runtime_identity_invalid");
  const names = Object.keys(runtime.files).sort();
  if (!names.length || !names.includes("cua-driver.exe") || names.some(name => !/^[A-Za-z0-9_.-]+$/.test(name) || !/^[a-f0-9]{64}$/.test(runtime.files[name])))
    throw new Error("remote_runtime_manifest_invalid");
  const appData = await deps.remoteLocalAppData(runner, signal);
  if (!path.posix.isAbsolute(appData) || /[\r\n]/.test(appData)) throw new Error("remote_runtime_local_appdata_unavailable");
  // The manifest identity changes when any runtime byte changes, even if a build reused its source revision.
  const identity = createHash("sha256").update(JSON.stringify(names.map(name => [name, runtime.files[name]]))).digest("hex");
  const parent = path.posix.join(appData, "PiComputerUse", "native-runtimes", runtime.source, identity);
  const destination = path.posix.join(parent, runtime.target), folder = path.posix.join(destination, "runtime");
  const command = path.posix.join(folder, "cua-driver.exe");
  const exists = async () => (await runner.run("bash", ["-c", 'if [ -e "$1" ] || [ -L "$1" ]; then printf present; else printf missing; fi', "bash", destination], { signal, timeoutMs: 15_000 })).trim() === "present";
  const verify = async (root: string) => {
    // Do not follow a pre-existing symlink for the cache directory or any executable/companion.
    const script = 'set -eu; root=$1; shift; test -d "$root" && test ! -L "$root" && test ! -L "$root/runtime" && test "$(realpath -e -- "$root")" = "$root"; for file in "$@"; do test -f "$file" && test ! -L "$file"; done; sha256sum -- "$@"';
    const paths = names.map(name => path.posix.join(root, "runtime", name));
    const out = await runner.run("bash", ["-c", script, "bash", root, ...paths], { signal, timeoutMs: 120_000 });
    const hashes = out.trim().split("\n").map(line => line.slice(0, 64));
    if (hashes.length !== names.length || hashes.some((hash, index) => hash !== runtime.files[names[index]]))
      throw new Error("remote_runtime_hash_mismatch: existing remote runtime was not replaced");
  };
  if (await exists()) { await verify(destination); return command; }
  await runner.run("mkdir", ["-p", "--", parent], { signal, timeoutMs: 30_000 });
  // Refuse redirected parent paths: a cache must stay beneath the intended Windows user folder.
  const actualParent = (await runner.run("realpath", ["-e", "--", parent], { signal, timeoutMs: 15_000 })).trim();
  if (actualParent !== parent) throw new Error("remote_runtime_cache_symlink_refused");
  signal?.throwIfAborted();
  const staging = (await runner.run("mktemp", ["-d", `${parent}/.staging-XXXXXXXX`], { timeoutMs: 30_000 }).catch(error => { throw new RemotePreparationUncertain(`Remote staging outcome is unknown: ${error instanceof Error ? error.message : String(error)}`); })).trim();
  if (!staging.startsWith(`${parent}/.staging-`) || staging.slice(parent.length + 10).includes("/")) throw new Error("remote_runtime_staging_invalid");
  let failure: unknown;
  try {
    signal?.throwIfAborted();
    await runner.run("mkdir", ["--", path.posix.join(staging, "runtime")], { timeoutMs: 30_000 });
    for (const name of names) {
      signal?.throwIfAborted();
      const bytes = await readFile(path.join(runtime.root, "runtime", name));
      // Keep SSH open until the dispatched writer exits. Killing the local client does not prove the remote writer stopped.
      try { await runner.run("dd", ["status=none", `of=${path.posix.join(staging, "runtime", name)}`], { input: bytes, timeoutMs: 600_000 }); }
      catch (error) { throw new RemotePreparationUncertain(`Remote runtime transfer outcome is unknown; a remote writer may still be running: ${error instanceof Error ? error.message : String(error)}`); }
      signal?.throwIfAborted();
    }
    await verify(staging);
    // GNU mv -n -T never replaces a destination. A concurrent winner is checked below.
    signal?.throwIfAborted();
    try { await runner.run("mv", ["-n", "-T", "--", staging, destination], { timeoutMs: 30_000 }); }
    catch (error) {
      // A concurrent publisher may have won, or SSH may have lost the rename response. Never replay the rename.
      if (!await exists().catch(() => false)) throw new RemotePreparationUncertain(`Remote runtime publication outcome is unknown: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (signal?.aborted) throw new RemotePreparationUncertain("Cancelled after remote runtime publication; the cache may already be present.");
    await verify(destination);
  } catch (error) { failure = error; }
  try { await runner.run("rm", ["-rf", "--", staging], { timeoutMs: 30_000 }); }
  catch (error) { throw new RemotePreparationUncertain(`Remote runtime staging cleanup is unconfirmed: ${error instanceof Error ? error.message : String(error)}`, { cause: failure }); }
  if (failure) throw failure;
  return command;
}
