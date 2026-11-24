import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fetchRuntime, loadBundledRuntime, PACKAGED_RUNTIME, readRuntimePins, type BundledRuntime } from "./native-runtime.ts";
import { runPowerShell, WINDOWS_POWERSHELL, type CommandRunner } from "./runner.ts";
import { RemotePreparationPending, RemotePreparationUncertain } from "./remote-provision-error.ts";

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
  /** Base URL of the pinned release files, ending in a slash; undefined streams every file from this machine. */
  releaseUrl?(): Promise<string | undefined>;
}
const defaultDeps: RemoteRuntimeDeps = { localRuntime, remoteLocalAppData, releaseUrl: async () => (await readRuntimePins()).url };

/** Preparations in progress, per dependency set and machine, so a later caller joins the running one. */
const preparations = new WeakMap<RemoteRuntimeDeps, Map<string, Promise<string>>>();

/**
 * Return the remote WSL path of the checked runtime, installing it first when the machine lacks it. The installation
 * runs to its end even when the caller stops waiting: a slow link may need longer than one tool call allows, and
 * the next caller for the same machine joins it instead of starting over. A caller that stops waiting gets
 * RemotePreparationPending.
 */
export async function prepareRemoteRuntime(runner: CommandRunner, signal?: AbortSignal, deps: RemoteRuntimeDeps = defaultDeps): Promise<string> {
  signal?.throwIfAborted();
  let running = preparations.get(deps);
  if (!running) preparations.set(deps, running = new Map());
  const key = runner.ssh ?? "local";
  let pending = running.get(key);
  if (!pending) {
    const started = installRemoteRuntime(runner, deps).finally(() => { if (running.get(key) === started) running.delete(key); });
    // A rejection nobody waits for any more must not end the process.
    started.catch(() => undefined);
    running.set(key, pending = started);
  }
  if (!signal) return pending;
  const preparation = pending;
  return new Promise<string>((resolve, reject) => {
    const stop = () => reject(new RemotePreparationPending(
      "The computer-use runtime for this machine is still being copied there; the copy continues in the background. Use the machine again in a moment."));
    signal.addEventListener("abort", stop, { once: true });
    preparation.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/**
 * Copy the checked package runtime to an immutable remote cache and return its remote WSL executable path. The remote
 * machine first downloads the pinned release files itself, which is much faster than streaming them over SSH from a
 * machine on a slow link; a file that does not arrive or does not match its pinned hash is streamed from here.
 */
async function installRemoteRuntime(runner: CommandRunner, deps: RemoteRuntimeDeps): Promise<string> {
  const runtime = await deps.localRuntime();
  if (!/^[a-f0-9]{40}$/.test(runtime.source) || runtime.target !== "win32-x64") throw new Error("remote_runtime_identity_invalid");
  const names = Object.keys(runtime.files).sort();
  if (!names.length || !names.includes("cua-driver.exe") || names.some(name => !/^[A-Za-z0-9_.-]+$/.test(name) || !/^[a-f0-9]{64}$/.test(runtime.files[name])))
    throw new Error("remote_runtime_manifest_invalid");
  const appData = await deps.remoteLocalAppData(runner);
  if (!path.posix.isAbsolute(appData) || /[\r\n]/.test(appData)) throw new Error("remote_runtime_local_appdata_unavailable");
  // The manifest identity changes when any runtime byte changes, even if a build reused its source revision.
  const identity = createHash("sha256").update(JSON.stringify(names.map(name => [name, runtime.files[name]]))).digest("hex");
  const parent = path.posix.join(appData, "PiComputerUse", "native-runtimes", runtime.source, identity);
  const destination = path.posix.join(parent, runtime.target), folder = path.posix.join(destination, "runtime");
  const command = path.posix.join(folder, "cua-driver.exe");
  const exists = async () => (await runner.run("bash", ["-c", 'if [ -e "$1" ] || [ -L "$1" ]; then printf present; else printf missing; fi', "bash", destination], { timeoutMs: 15_000 })).trim() === "present";
  const hashes = async (root: string) => {
    // Hash the regular files that are present; a missing or redirected file has no hash.
    const script = 'set -eu; for file in "$@"; do if [ -f "$file" ] && [ ! -L "$file" ]; then printf "%s\\n" "$(sha256sum -- "$file" | cut -c1-64)"; else printf -- "-\\n"; fi; done';
    const out = await runner.run("bash", ["-c", script, "bash", ...names.map(name => path.posix.join(root, "runtime", name))], { timeoutMs: 120_000 });
    return out.trim().split("\n");
  };
  const verify = async (root: string) => {
    // Do not follow a pre-existing symlink for the cache directory or any executable/companion.
    const script = 'set -eu; root=$1; shift; test -d "$root" && test ! -L "$root" && test ! -L "$root/runtime" && test "$(realpath -e -- "$root")" = "$root"; for file in "$@"; do test -f "$file" && test ! -L "$file"; done; sha256sum -- "$@"';
    const paths = names.map(name => path.posix.join(root, "runtime", name));
    const out = await runner.run("bash", ["-c", script, "bash", root, ...paths], { timeoutMs: 120_000 });
    const hashes = out.trim().split("\n").map(line => line.slice(0, 64));
    if (hashes.length !== names.length || hashes.some((hash, index) => hash !== runtime.files[names[index]]))
      throw new Error("remote_runtime_hash_mismatch: existing remote runtime was not replaced");
  };
  if (await exists()) { await verify(destination); return command; }
  await runner.run("mkdir", ["-p", "--", parent], { timeoutMs: 30_000 });
  // Refuse redirected parent paths: a cache must stay beneath the intended Windows user folder.
  const actualParent = (await runner.run("realpath", ["-e", "--", parent], { timeoutMs: 15_000 })).trim();
  if (actualParent !== parent) throw new Error("remote_runtime_cache_symlink_refused");
  const staging = (await runner.run("mktemp", ["-d", `${parent}/.staging-XXXXXXXX`], { timeoutMs: 30_000 }).catch(error => { throw new RemotePreparationUncertain(`Remote staging outcome is unknown: ${error instanceof Error ? error.message : String(error)}`); })).trim();
  if (!staging.startsWith(`${parent}/.staging-`) || staging.slice(parent.length + 10).includes("/")) throw new Error("remote_runtime_staging_invalid");
  let failure: unknown;
  try {
    const stagedRuntime = path.posix.join(staging, "runtime");
    await runner.run("mkdir", ["--", stagedRuntime], { timeoutMs: 30_000 });
    const url = await deps.releaseUrl?.().catch(() => undefined);
    if (url) {
      // Each file arrives under a temporary name and takes its own name only when the download completed. A failed
      // download, or a machine without curl or GitHub access, leaves the file to the stream below.
      const download = 'dir=$1; url=$2; shift 2; command -v curl >/dev/null || exit 0; for name in "$@"; do ' +
        'if curl -fsSL --connect-timeout 10 --retry 2 -o "$dir/$name.part" "$url$name"; then mv -f -- "$dir/$name.part" "$dir/$name"; else rm -f -- "$dir/$name.part"; fi; done; exit 0';
      await runner.run("bash", ["-c", download, "bash", stagedRuntime, url, ...names], { timeoutMs: 600_000 }).catch(() => undefined);
    }
    const present = await hashes(staging);
    for (const [index, name] of names.entries()) {
      if (present[index] === runtime.files[name]) continue;
      const bytes = await readFile(path.join(runtime.root, "runtime", name));
      // Keep SSH open until the dispatched writer exits. Killing the local client does not prove the remote writer stopped.
      try { await runner.run("dd", ["status=none", `of=${path.posix.join(stagedRuntime, name)}`], { input: bytes, timeoutMs: 600_000 }); }
      catch (error) { throw new RemotePreparationUncertain(`Remote runtime transfer outcome is unknown; a remote writer may still be running: ${error instanceof Error ? error.message : String(error)}`); }
    }
    await verify(staging);
    // GNU mv -n -T never replaces a destination. A concurrent winner is checked below.
    try { await runner.run("mv", ["-n", "-T", "--", staging, destination], { timeoutMs: 30_000 }); }
    catch (error) {
      // A concurrent publisher may have won, or SSH may have lost the rename response. Never replay the rename.
      if (!await exists().catch(() => false)) throw new RemotePreparationUncertain(`Remote runtime publication outcome is unknown: ${error instanceof Error ? error.message : String(error)}`);
    }
    await verify(destination);
  } catch (error) { failure = error; }
  try { await runner.run("rm", ["-rf", "--", staging], { timeoutMs: 30_000 }); }
  catch (error) { throw new RemotePreparationUncertain(`Remote runtime staging cleanup is unconfirmed: ${error instanceof Error ? error.message : String(error)}`, { cause: failure }); }
  if (failure) throw failure;
  return command;
}
