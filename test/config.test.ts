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

test.each([{runtime:"windows-held-paths"},{runtime:"windows-key-holds"},{command:"driver",runtime:"latest"},
  {command:"driver",runtime:["windows-key-holds"]},
  ...["windows-held-paths","windows-key-holds"].map(runtime=>({command:"driver",runtime,args:["mcp","--socket","elsewhere"]}))])("held paths cannot silently discover or borrow an unqualified runtime: %j", async config => {
  const cwd = await workspace(); await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify(config));
  await expect(loadComputerConfig(cwd)).rejects.toThrow("Invalid computer-use configuration");
});
test.each(["windows-held-paths", "windows-key-holds", "windows-selected-displays", "windows-capture-drag", "windows-shell-desktops", "windows-single-png", "windows-semantic-actions", "windows-fast-bilinear", "windows-direct-process", "windows-persistent-wgc", "windows-native-pointer"])("%s selection is explicit trusted config and does not replace discovery defaults", async runtime => {
  const cwd = await workspace(); await mkdir(path.join(cwd, ".pi"));
  const config = {command:"/owned/candidate/cua-driver.exe",runtime};
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify(config));
  expect(await loadComputerConfig(cwd)).toEqual(config);
});
test("an old target configuration is refused rather than silently changing its permission boundary", async () => {
  const cwd = await workspace();
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: "driver", target: { pid: 42, window_id: 100 } }));
  await expect(loadComputerConfig(cwd)).rejects.toThrow("Remove the old target field");
});

test("window restore is an explicit artifact profile and rejects missing command or custom transport", async () => {
  const cwd = await workspace(); await mkdir(path.join(cwd, ".pi"));
  const config = { command: "/owned/candidate/cua-driver.exe", runtime: "windows-window-restore" };
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify(config));
  expect(await loadComputerConfig(cwd)).toEqual(config);
  for (const invalid of [{ runtime: config.runtime }, { ...config, args: ["mcp"] }]) {
    await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify(invalid));
    await expect(loadComputerConfig(cwd)).rejects.toThrow("Invalid computer-use configuration");
  }
});
test("management selects only an explicit artifact profile and fixed transport", async () => {
  const cwd = await workspace(); await mkdir(path.join(cwd, ".pi"));
  const config = { command: "/owned/candidate/cua-driver.exe", runtime: "windows-window-management" };
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify(config));
  expect(await loadComputerConfig(cwd)).toEqual(config);
  for (const invalid of [{ runtime: config.runtime }, { ...config, args: ["mcp"] }]) {
    await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify(invalid));
    await expect(loadComputerConfig(cwd)).rejects.toThrow("Invalid computer-use configuration");
  }
});
test("DOM inspection requires an explicit artifact and refuses custom transport arguments", async () => {
  const cwd = await workspace(); await mkdir(path.join(cwd, ".pi"));
  const config = { command: "/owned/candidate/cua-driver.exe", runtime: "windows-dom-inspection" };
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify(config));
  expect(await loadComputerConfig(cwd)).toEqual(config);
  for (const invalid of [{ runtime: config.runtime }, { ...config, args: ["mcp"] }]) {
    await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify(invalid));
    await expect(loadComputerConfig(cwd)).rejects.toThrow("Invalid computer-use configuration");
  }
});
test("coordinate scroll is an explicit trusted artifact profile, never an implicit runtime", async () => {
  const cwd = await workspace(); await mkdir(path.join(cwd, ".pi"));
  const config = { command: "/owned/candidate/cua-driver.exe", runtime: "windows-coordinate-scroll" };
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify(config));
  expect(await loadComputerConfig(cwd)).toEqual(config);
  for (const invalid of [{ runtime: config.runtime }, { ...config, args: ["mcp"] }]) {
    await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify(invalid));
    await expect(loadComputerConfig(cwd)).rejects.toThrow("Invalid computer-use configuration");
  }
});