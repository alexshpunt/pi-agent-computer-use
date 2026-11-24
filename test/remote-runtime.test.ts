import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { localRunner, type CommandRunner } from "../src/runner.ts";
import type { BundledRuntime } from "../src/native-runtime.ts";
import { prepareRemoteRuntime } from "../src/remote-runtime.ts";

const files = ["cua-driver.exe", "cua-driver-uia.exe", "cua-cursor-theme.exe", "cua-spacesd.exe", "LICENSE.md", "THIRD_PARTY_NOTICES.md", "cua-spacesd-LICENSE.txt", "cua-spacesd-THIRD_PARTY_NOTICES.md"];
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-remote-runtime-test-")); dirs.push(dir);
  const local = path.join(dir, "local"), appData = path.join(dir, "remote user", "Local AppData");
  await mkdir(path.join(local, "runtime"), { recursive: true }); await mkdir(appData, { recursive: true });
  const hashes: Record<string, string> = {};
  for (const name of files) { const bytes = Buffer.from(`content for ${name}`); await writeFile(path.join(local, "runtime", name), bytes); hashes[name] = createHash("sha256").update(bytes).digest("hex"); }
  const runtime: BundledRuntime = { root: local, command: path.join(local, "runtime", "cua-driver.exe"), target: "win32-x64", source: "a".repeat(40), version: "1.0.0", driverVersion: "1.0.0", files: hashes };
  return { dir, runtime, runner: localRunner(), appData, deps: { localRuntime: async () => runtime, remoteLocalAppData: async (_runner: CommandRunner) => appData } };
}

test("remote runtime is installed once and every required file is verified before reuse", async () => {
  const f = await fixture();
  const command = await prepareRemoteRuntime(f.runner, undefined, f.deps);
  expect(await readFile(command, "utf8")).toBe("content for cua-driver.exe");
  expect(await prepareRemoteRuntime(f.runner, undefined, f.deps)).toBe(command);
  const extra = path.join(path.dirname(command), "LICENSE.md");
  await writeFile(extra, "modified");
  await expect(prepareRemoteRuntime(f.runner, undefined, f.deps)).rejects.toThrow();
  expect(await readFile(extra, "utf8")).toBe("modified");
});

test("concurrent installations publish one complete runtime without deleting other data", async () => {
  const f = await fixture();
  const other = path.join(f.appData, "unrelated"); await writeFile(other, "keep");
  // Separate dependency sets stand for two Pi processes, which share no in-process preparation.
  const [first, second] = await Promise.all([prepareRemoteRuntime(f.runner, undefined, { ...f.deps }), prepareRemoteRuntime(f.runner, undefined, { ...f.deps })]);
  expect(first).toBe(second);
  expect((await readdir(path.dirname(first))).sort()).toEqual([...files].sort());
  expect(await readFile(other, "utf8")).toBe("keep");
});

test("a symlink substituted for a published companion is refused and left untouched", async () => {
  const f = await fixture();
  const command = await prepareRemoteRuntime(f.runner, undefined, f.deps);
  const companion = path.join(path.dirname(command), "LICENSE.md");
  const outside = path.join(f.dir, "outside"); await writeFile(outside, "content for LICENSE.md");
  await rm(companion); await symlink(outside, companion);
  await expect(prepareRemoteRuntime(f.runner, undefined, f.deps)).rejects.toThrow();
  expect(await readFile(outside, "utf8")).toBe("content for LICENSE.md");
});
test("a caller that stops waiting returns at once while the transfer finishes for the next caller", async () => {
  const f = await fixture(); const controller = new AbortController();
  let started!: () => void, release!: () => void, streams = 0;
  const sent = new Promise<void>(resolve => { started = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const runner: CommandRunner = { ...f.runner, async run(file, args, options) {
    if (file === "dd" && ++streams === 1) { started(); await waiting; }
    return f.runner.run(file, args, options);
  } };
  const { RemotePreparationPending } = await import("../src/remote-provision-error.ts");
  const first = prepareRemoteRuntime(runner, controller.signal, f.deps).then(() => null, error => error);
  await sent; controller.abort();
  expect(await first).toBeInstanceOf(RemotePreparationPending);
  // The next caller joins the running preparation instead of starting a second transfer.
  const second = prepareRemoteRuntime(runner, undefined, f.deps);
  release();
  const command = await second;
  expect(streams).toBe(files.length);
  expect((await readdir(path.dirname(command))).sort()).toEqual([...files].sort());
});
test("the remote machine downloads the pinned files itself and nothing is streamed", async () => {
  const f = await fixture();
  let streams = 0;
  const runner: CommandRunner = { ...f.runner, async run(file, args, options) {
    if (file === "dd") streams++;
    return f.runner.run(file, args, options);
  } };
  const release = `${pathToFileURL(path.join(f.runtime.root, "runtime")).href}/`;
  const command = await prepareRemoteRuntime(runner, undefined, { ...f.deps, releaseUrl: async () => release });
  expect(streams).toBe(0);
  expect(await readFile(command, "utf8")).toBe("content for cua-driver.exe");
  expect((await readdir(path.dirname(command))).sort()).toEqual([...files].sort());
});
test("a missing or altered download is streamed from this machine and never published as downloaded", async () => {
  const f = await fixture();
  const release = path.join(f.dir, "release");
  await mkdir(release);
  for (const name of files) if (name !== "LICENSE.md") await writeFile(path.join(release, name), name === "cua-driver.exe" ? "tampered" : `content for ${name}`);
  const streamed: string[] = [];
  const runner: CommandRunner = { ...f.runner, async run(file, args, options) {
    if (file === "dd") streamed.push(path.basename(args[1]));
    return f.runner.run(file, args, options);
  } };
  const command = await prepareRemoteRuntime(runner, undefined, { ...f.deps, releaseUrl: async () => `${pathToFileURL(release).href}/` });
  expect(streamed.sort()).toEqual(["LICENSE.md", "cua-driver.exe"]);
  expect(await readFile(command, "utf8")).toBe("content for cua-driver.exe");
  expect((await readdir(path.dirname(command))).sort()).toEqual([...files].sort());
});
test("a lost transfer response reports uncertain remote effects", async () => {
  const f = await fixture();
  const runner: CommandRunner = { ...f.runner, async run(file, args, options) {
    if (file === "dd") throw new Error("connection lost");
    return f.runner.run(file, args, options);
  } };
  const { RemotePreparationUncertain } = await import("../src/remote-provision-error.ts");
  await expect(prepareRemoteRuntime(runner, undefined, f.deps)).rejects.toBeInstanceOf(RemotePreparationUncertain);
});
test("an interrupted transfer leaves no partial published runtime", async () => {
  const f = await fixture(); const real = f.runner; let writes = 0;
  const runner: CommandRunner = { ...real, async run(file, args, options) {
    if (file === "dd" && ++writes === 2) throw new Error("transfer interrupted");
    return real.run(file, args, options);
  } };
  await expect(prepareRemoteRuntime(runner, undefined, f.deps)).rejects.toThrow();
  const command = await prepareRemoteRuntime(f.runner, undefined, f.deps);
  expect((await readdir(path.dirname(command))).sort()).toEqual([...files].sort());
});
