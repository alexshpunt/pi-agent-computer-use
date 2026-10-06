import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createUiResourcesSite } from "../test/fixtures/ui-resources-site.mjs";
import { openCompleteInputWindow } from "./complete-input-window.mjs";
import { loadComputerConfig } from "../src/config.ts";
import { McpDriver } from "../src/driver.ts";

// Hold one owned fixture for real production computer_* calls. Send finish to clean it.
const mode = process.argv[2]; assert.ok(["browser", "native"].includes(mode), "Choose browser or native.");
const directory = `.tmp/ui-resources/${mode}-${Date.now()}`; await mkdir(directory, { recursive: true });
const config = await loadComputerConfig(process.cwd()); const driver = new McpDriver(config);
const root = config.command.replace(/\/cua-driver-[^/]+\/cua-driver\.exe$/, "");
assert.ok(root.startsWith("/mnt/c/"), "Use the installed trusted Windows runtime.");
const windowsPath = value => value.replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
let site, fixture, child, nativeDirectory, target;
try {
  if (mode === "browser") {
    site = await createUiResourcesSite(); fixture = await openCompleteInputWindow(driver, site.url, windowsPath(root));
    target = fixture.target;
  } else {
    nativeDirectory = path.join(root, ".tmp", `ui-resources-${Date.now()}`); await mkdir(nativeDirectory, { recursive: true });
    const source = execFileSync("wslpath", ["-w", path.resolve("scripts/ui-resources-window.ps1")], { encoding: "utf8" }).trim();
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const command = `& ([scriptblock]::Create([IO.File]::ReadAllText(${quote(source)}))) -Directory ${quote(windowsPath(nativeDirectory))}`;
    child = spawn("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", command], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", data => process.stdout.write(data)); child.stderr.on("data", data => process.stderr.write(data));
    let ready;
    for (let i = 0; i < 100; i++) {
      try { ready = JSON.parse((await readFile(path.join(nativeDirectory, "native-ready.json"), "utf8")).replace(/^\uFEFF/, "")); break; } catch { /* Wait for this owned fixture's ready file. */ }
      if (child.exitCode !== null) throw Error(`Native fixture exited ${child.exitCode}.`);
      await delay(100);
    }
    assert.ok(ready, "Owned native fixture did not become ready; do not relaunch blindly.");
    target = { pid: ready.pid, window_id: ready.window_id };
    fixture = { other_window_id: ready.other_window_id };
  }
  const info = { directory, mode, target, title: mode === "browser" ? "Pi UI resources fixture" : "Pi UI native fixture",
    ...(site ? { url: site.url } : { nativeDirectory, other_window_id: fixture.other_window_id }) };
  await writeFile(`${directory}/fixture.json`, JSON.stringify(info, null, 2)); console.log(JSON.stringify(info));
  const input = createInterface({ input: process.stdin });
  for await (const line of input) { if (line.trim() === "finish") break; } input.close();
} finally {
  let cleanup;
  if (mode === "browser" && fixture?.close) cleanup = await fixture.close();
  else if (target) {
    const view = await driver.call("get_window_state", { ...target, max_elements: 200, max_image_dimension: 500 });
    const controls = (view.structuredContent?.elements ?? []).filter(e => e.label === "Close" && e.element_token);
    assert.equal(controls.length, 1, "Require exactly one native Close control for the owned main form.");
    const closed = await driver.call("click", { target: { kind: "window", ...target }, element_token: controls[0].element_token, delivery_mode: "background" });
    assert.ok(!closed.isError, "Owned fixture Close refused.");
    let gone = false;
    for (let i = 0; i < 30; i++) { const windows = await driver.call("list_windows", {}); gone = !windows.structuredContent.windows.some(w => w.pid === target.pid); if (gone) break; await delay(100); }
    assert.ok(gone, "Owned native fixture is still present."); cleanup = { sourceGone: true };
  }
  const events = site ? site.events() : nativeDirectory ? (await readFile(path.join(nativeDirectory, "native-events.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  await driver.close(); await site?.close();
  if (cleanup?.sourceGone && nativeDirectory) await rm(nativeDirectory, { recursive: true, force: true });
  await writeFile(`${directory}/run.json`, JSON.stringify({ events, cleanup, private_fixture: true }, null, 2));
  console.log(JSON.stringify({ directory, cleanup }));
}
