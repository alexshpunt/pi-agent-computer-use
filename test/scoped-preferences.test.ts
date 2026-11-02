import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { readScopedPreferences, writeScopedPreference } from "../src/scoped-preferences.ts";

const dirs: string[] = [];
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(async () => { if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir; await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "cua-scopes-")); dirs.push(root);
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  return { a: path.join(root, "a"), b: path.join(root, "b"), root };
}
test("project preferences override global per setting and clearing restores inheritance", async () => {
  const { a, b } = await fixture();
  await writeScopedPreference(a, "global", "cap", 900);
  await writeScopedPreference(a, "global", "hints", false);
  await writeScopedPreference(a, "project", "cap", 700);
  expect((await readScopedPreferences(a)).effective).toEqual({ cap: 700, hints: false });
  expect((await readScopedPreferences(a)).sources).toEqual({ cap: "project", hints: "global" });
  expect((await readScopedPreferences(b)).effective).toEqual({ cap: 900, hints: false });
  expect((await readScopedPreferences(a, false)).effective).toEqual({ cap: 900, hints: false });
  await writeScopedPreference(a, "project", "cap", undefined);
  expect((await readScopedPreferences(a)).effective.cap).toBe(900);
});
test("simultaneous writes keep unrelated settings", async () => {
  const { a } = await fixture();
  await Promise.all([
    writeScopedPreference(a, "global", "mode", "safe"),
    writeScopedPreference(a, "global", "escape", false),
    writeScopedPreference(a, "global", "cap", 800),
  ]);
  expect((await readScopedPreferences(a)).effective).toEqual({ mode: "safe", escape: false, cap: 800 });
});
test("concurrent processes do not discard each other's settings", async () => {
  const { a } = await fixture();
  const run = promisify(execFile);
  const moduleUrl = new URL("../src/scoped-preferences.ts", import.meta.url).href;
  const entries = [["mode", "safe"], ["escape", false], ["cap", 800]] as const;
  await Promise.all(entries.map(([key, value]) => run(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    `import { writeScopedPreference } from ${JSON.stringify(moduleUrl)}; await writeScopedPreference(${JSON.stringify(a)}, "global", ${JSON.stringify(key)}, ${JSON.stringify(value)});`], { env: process.env })));
  expect((await readScopedPreferences(a)).effective).toEqual({ mode: "safe", escape: false, cap: 800 });
});
test("invalid settings and malformed files are never overwritten", async () => {
  const { a } = await fixture();
  await expect(writeScopedPreference(a, "global", "cap", 2)).rejects.toThrow();
  await mkdir(path.join(a, ".pi"), { recursive: true });
  const file = path.join(a, ".pi", "computer-use-settings.json");
  await writeFile(file, "broken");
  await expect(writeScopedPreference(a, "project", "mode", "safe")).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe("broken");
});
