import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { localRunner } from "../src/runner.ts";
import { prepareWorkerPackage } from "../src/remote-browser.ts";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/remote-browser-")); temporary.push(root);
  const source = path.join(root, "package"), home = path.join(root, "remote"), playwright = path.join(root, "playwright");
  await mkdir(path.join(source, "src"), { recursive: true }); await mkdir(path.join(playwright, "lib"), { recursive: true }); await mkdir(home);
  await writeFile(path.join(source, "src", "web-worker.ts"), "export const version = 1;\n");
  await writeFile(path.join(source, "package.json"), '{"type":"module"}');
  await writeFile(path.join(playwright, "package.json"), '{"name":"playwright-core"}');
  await writeFile(path.join(playwright, "lib", "code.js"), "export const x = 1;\n");
  return { source, home, playwright, runner: localRunner() };
}

test("a supplied remote Node is reused without trying to install another one", async () => {
  const { prepareRemoteBrowser } = await import("../src/remote-browser.ts");
  const f = await fixture();
  const prepareNode = async () => { throw new Error("network unavailable"); };
  const prepareWorker = async () => "/managed/worker";
  expect(await prepareRemoteBrowser(f.runner, undefined, { node: "/trusted/node.exe" }, { node: prepareNode, worker: prepareWorker }))
    .toEqual({ node: "/trusted/node.exe", package: "/managed/worker" });
});
test("an uncertain worker failure takes precedence over an ordinary Node failure", async () => {
  const { prepareRemoteBrowser } = await import("../src/remote-browser.ts");
  const { RemotePreparationUncertain } = await import("../src/remote-provision-error.ts");
  const f = await fixture();
  const uncertain = new RemotePreparationUncertain("lost response");
  await expect(prepareRemoteBrowser(f.runner, undefined, {}, {
    node: async () => { throw new Error("cancelled"); }, worker: async () => { throw uncertain; },
  })).rejects.toBe(uncertain);
});

test("a redirected worker cache parent is refused before creating files outside the home", async () => {
  const f = await fixture();
  const parent = path.join(f.home, ".local/share/pi-computer-use");
  const outside = path.join(path.dirname(f.home), "outside");
  await mkdir(path.dirname(parent), { recursive: true });
  await mkdir(outside);
  await symlink(outside, parent);
  await expect(prepareWorkerPackage(f.runner, f.source, f.playwright, f.home)).rejects.toThrow();
  expect(await readdir(outside)).toEqual([]);
});
test("remote worker is copied once, verified on reuse and refreshed to a different immutable directory after an update", async () => {
  const f = await fixture();
  const first = await prepareWorkerPackage(f.runner, f.source, f.playwright, f.home);
  const same = await prepareWorkerPackage(f.runner, f.source, f.playwright, f.home);
  expect(same).toBe(first);
  expect(await readFile(path.join(first, "node_modules/playwright-core/lib/code.js"), "utf8")).toBe("export const x = 1;\n");
  await writeFile(path.join(f.source, "src/web-worker.ts"), "export const version = 2;\n");
  const next = await prepareWorkerPackage(f.runner, f.source, f.playwright, f.home);
  expect(next).not.toBe(first);
  expect(await readFile(path.join(first, "src/web-worker.ts"), "utf8")).toBe("export const version = 1;\n");
  expect(await readFile(path.join(next, "src/web-worker.ts"), "utf8")).toBe("export const version = 2;\n");
});

test("changed remote worker files are never reused or overwritten", async () => {
  const f = await fixture();
  const worker = await prepareWorkerPackage(f.runner, f.source, f.playwright, f.home);
  const file = path.join(worker, "node_modules/playwright-core/lib/code.js");
  await writeFile(file, "changed");
  await expect(prepareWorkerPackage(f.runner, f.source, f.playwright, f.home)).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe("changed");
});

test("concurrent first use shares one complete worker; cancellation does not publish partial files", async () => {
  const f = await fixture();
  await expect(prepareWorkerPackage(f.runner, f.source, f.playwright, f.home, AbortSignal.abort())).rejects.toThrow();
  const [a, b] = await Promise.all([prepareWorkerPackage(f.runner, f.source, f.playwright, f.home), prepareWorkerPackage(f.runner, f.source, f.playwright, f.home)]);
  expect(a).toBe(b);
  expect(await readFile(path.join(a, "src/web-worker.ts"), "utf8")).toBe("export const version = 1;\n");
  expect((await readdir(path.dirname(a))).filter(name => name.startsWith(".staging-"))).toEqual([]);
});

test("cancellation during transfer leaves no published worker or staging directory", async () => {
  const f = await fixture();
  const abort = new AbortController();
  let started!: () => void;
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  const runner = { ...f.runner, spawn: () => { const child = f.runner.spawn("bash", ["-c", "cat >/dev/null"]); started(); return child; } };
  const pending = prepareWorkerPackage(runner, f.source, f.playwright, f.home, abort.signal);
  await dispatched; abort.abort();
  await expect(pending).rejects.toThrow();
  expect(await readdir(path.join(f.home, ".local/share/pi-computer-use/workers"))).toEqual([]);
});
test("a link in the worker source or in an existing remote copy is refused", async () => {
  const f = await fixture();
  await symlink("web-worker.ts", path.join(f.source, "src", "link.ts"));
  await expect(prepareWorkerPackage(f.runner, f.source, f.playwright, f.home)).rejects.toThrow();
  await rm(path.join(f.source, "src", "link.ts"));
  const worker = await prepareWorkerPackage(f.runner, f.source, f.playwright, f.home);
  await symlink("web-worker.ts", path.join(worker, "src", "link.ts"));
  await expect(prepareWorkerPackage(f.runner, f.source, f.playwright, f.home)).rejects.toThrow();
});
