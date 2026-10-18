import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { McpDriver } from "../src/driver.ts";
import { loadComputerConfig } from "../src/config.ts";

test("the separate action profile is accepted without changing the readonly profile", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  await mkdir(path.join(root, ".tmp/lpt-734"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/lpt-734/profile-"));
  try {
    await mkdir(path.join(cwd, ".pi"));
    const selected = { command: "isolated-candidate.exe", runtime: "windows-dom-actions" };
    await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify(selected));
    const config = await loadComputerConfig(cwd);
    expect(config).toEqual(selected);
    const driver = new McpDriver(config);
    try {
      for (const capability of ["domActions", "domInspection", "heldPaths", "heldKeys", "selectedDisplays", "captureBoundDrag", "nativePointer", "coordinateScroll", "windowRestore", "windowManagement", "persistentWgc"] as const)
        expect(driver[capability], capability).toBe(true);
    } finally { await driver.close(); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
test("the action candidate checks its pinned bytes before starting a mismatched executable", async () => {
  const driver = new McpDriver({ command: path.resolve(import.meta.dirname, "fixtures/dom-actions-driver.mjs"), runtime: "windows-dom-actions" });
  try { await expect(driver.call("list_windows", {})).rejects.toThrow("Native fork artifact hash mismatch"); }
  finally { await driver.close(); }
});

test("only exact DOM profiles expose an isolated runtime/browser/DPR raster policy", async () => {
  const identity = { source: "91989b6309884473e07c6cdb136ae6092a40eff3", sha256: "8ed27ba88b082b4c04f7a2bed88fcbcf48a29ed03205db8eeb0a5ab54279e9cc" };
  const expected = { runtime: identity, qualification: { runtime: identity,
    browser: { product: "Chrome/155.0.8059.40", revision: "@cfaadc5a132d78e1828635aa8405a499f3e14864" }, dpr: 1.5 } };
  for (const runtime of ["windows-dom-actions", "windows-dom-inspection", "windows-persistent-wgc", undefined] as const) {
    const driver = new McpDriver({ command: "must-not-start.exe", ...(runtime ? { runtime } : {}) });
    try {
      const policy = (driver as import("../src/session.ts").Driver).nativeDomRaster;
      if (runtime?.startsWith("windows-dom-")) {
        expect(policy).toEqual(expected);
        // A caller cannot mutate the trusted policy returned by a later read.
        (policy!.qualification as { dpr: number }).dpr = 2;
        expect((driver as import("../src/session.ts").Driver).nativeDomRaster).toEqual(expected);
      } else expect(policy).toBeUndefined();
    } finally { await driver.close(); }
  }
});
class CandidateFixture extends McpDriver {
  get domInspection() { return true; }
  get domActions() { return true; }
}
async function withPeer(mode: string, check: (driver: CandidateFixture, journal: () => Promise<string>) => Promise<void>) {
  const root = path.resolve(import.meta.dirname, "..");
  await mkdir(path.join(root, ".tmp/lpt-734"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/lpt-734/schema-")), log = path.join(cwd, "calls.jsonl");
  const driver = new CandidateFixture({ command: process.execPath, args: [path.join(root, "test/fixtures/dom-actions-driver.mjs"), log, mode] });
  try { await check(driver, () => readFile(log, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; })); }
  finally { await driver.close(); await rm(cwd, { recursive: true, force: true }); }
}
test.each(["missing_action", "wrong_route", "open_request", "duplicate_action"])("%s metadata cannot admit native locator actions", async mode => {
  await withPeer(mode, async (driver, journal) => {
    await expect(driver.call("list_windows", {})).rejects.toThrow("native_runtime_schema_missing: browser_dom_action");
    expect(await journal()).toBe("");
  });
});
test("a complete closed action schema admits a metadata call without dispatching input", async () => {
  await withPeer("valid", async (driver, journal) => {
    expect((await driver.call("list_windows", {})).structuredContent?.windows).toHaveLength(1);
    expect((await journal()).trim().split("\n").map(line => JSON.parse(line).name)).toEqual(["list_windows"]);
  });
});

test("the readonly DOM runtime cannot borrow locator input or start a peer for it", async () => {
  const driver = new McpDriver({ command: "must-not-start.exe", runtime: "windows-dom-inspection" });
  try {
    const result = await driver.call("browser_dom_action", { input_route: "dom_event", request: { action: "click", locator: { css: "button" } } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "dom_actions_unavailable", attempted: false, fallback: false });
  } finally { await driver.close(); }
});
