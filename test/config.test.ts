import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { loadComputerConfig } from "../src/config.ts";

const owned: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(owned.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function workspace() {
  await mkdir(".tmp", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp", "config-contract-"));
  owned.push(cwd);
  return cwd;
}

test("opening has no target-file prerequisite and respects a trusted Driver override", async () => {
  const cwd = await workspace();
  vi.stubEnv("CUA_DRIVER_PATH", "C:\\Trusted\\cua-driver.exe");
  expect(await loadComputerConfig(cwd)).toEqual({ command: "C:\\Trusted\\cua-driver.exe" });
});

test("an old target configuration is refused rather than silently changing its permission boundary", async () => {
  const cwd = await workspace();
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: "driver", target: { pid: 42, window_id: 100 } }));
  await expect(loadComputerConfig(cwd)).rejects.toThrow("Remove the old target field");
});
