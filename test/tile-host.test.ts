import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { SandboxHost } from "../src/sandbox.ts";
import { buildScript, startTileHost, tileHostSources, tileHostVersion, TILE_HOST_FILES, TILE_HOST_INSTANCE, WEBVIEW2_SDK } from "../src/tile-host.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** A machine whose PowerShell answers from `answer`; files land under a temp root. */
async function machine(answer: (script: string) => string) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-tile-host-test-"));
  roots.push(root);
  const scripts: string[] = [];
  const host: SandboxHost = {
    powershell: async script => { scripts.push(script); return answer(script); },
    path: async value => path.join(root, value.replace(/^C:\\/, "").replaceAll("\\", "/")),
    mkdir: async dir => { await mkdir(dir, { recursive: true }); },
    writeFile: (file, content) => writeFile(file, content),
    readFile: file => readFile(file, "utf8").catch(() => ""),
    remove: dir => rm(dir, { recursive: true, force: true }),
    forward: async port => ({ port, close: () => {} }),
    publish: async port => ({ port, close: () => {} }),
  };
  return { host, scripts, root };
}

test("the first start stages the sources, builds against the pinned WebView2 SDK and starts the host", async () => {
  const { version, files } = await tileHostSources();
  const m = await machine(script => script.startsWith("Test-Path") ? "False\r\n" : script.includes("csc.exe") ? "built\r\n" : "started\r\n");
  expect(await startTileHost(m.host, "C:\\Local")).toBe("started");
  const [check, build, start] = m.scripts;
  expect(check).toContain(`C:\\Local\\PiComputerUse\\tile-host\\${version}\\pi-tile-host.exe`);
  // Every source is staged next to the build, unchanged.
  const staging = /\$staging = '([^']+)'/.exec(build)![1];
  expect(staging).toMatch(new RegExp(`^C:\\\\Local\\\\PiComputerUse\\\\tile-host\\\\${version}\\.staging-`));
  for (const file of files) expect(await readFile(path.join(m.root, staging.replace(/^C:\\/, "").replaceAll("\\", "/"), file.name), "utf8")).toBe(file.content);
  expect(files.map(file => file.name)).toEqual([...TILE_HOST_FILES]);
  // The SDK is downloaded only from its pinned URL and must match its hash.
  expect(build).toContain(WEBVIEW2_SDK.url);
  expect(build).toContain(WEBVIEW2_SDK.sha256.toUpperCase());
  expect(start).toContain("Start-Process");
  // The start script asks the same instance mutex the host owns.
  expect(start).toContain(`'${TILE_HOST_INSTANCE}'`);
  expect(files.find(file => file.name === "TileHost.cs")!.content).toContain(`Name = @"${TILE_HOST_INSTANCE}"`);
});

test("a built host is only started, and a running one is left alone", async () => {
  const running = await machine(script => script.startsWith("Test-Path") ? "True\r\n" : "running\r\n");
  expect(await startTileHost(running.host, "C:\\Local")).toBe("running");
  expect(running.scripts).toHaveLength(2);
  expect(running.scripts.some(script => script.includes("csc.exe"))).toBe(false);
});

test("a failed build or start is reported, not taken for a running host", async () => {
  const broken = await machine(script => script.startsWith("Test-Path") ? "False" : script.includes("csc.exe") ? "error CS1002: ; expected" : "started");
  await expect(startTileHost(broken.host, "C:\\Local")).rejects.toThrow(/build reported: error CS1002/);
  const silent = await machine(script => script.startsWith("Test-Path") ? "True" : "");
  await expect(startTileHost(silent.host, "C:\\Local")).rejects.toThrow(/start reported: nothing/);
});

test("the build version is a stable hash of the sources and the build recipe", async () => {
  const a = await tileHostSources(), b = await tileHostSources();
  expect(a.version).toMatch(/^[0-9a-f]{16}$/);
  expect(b.version).toBe(a.version);
  expect(tileHostVersion(a.files)).toBe(a.version);
  // A changed source or compiler call needs a new build, not the one built from the old recipe.
  expect(tileHostVersion(a.files.map((file, i) => i ? file : { ...file, content: `${file.content} ` }))).not.toBe(a.version);
  expect(tileHostVersion(a.files, buildScript("", "", "").replace("/optimize+", "/optimize-"))).not.toBe(a.version);
});
