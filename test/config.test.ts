import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { loadComputerConfig, readMachineSettings } from "../src/config.ts";

// These tests read configuration only; the live WSL interop socket of the machine running them stays out.
vi.mock("../src/wsl-interop.ts", () => ({ liveInterop: vi.fn(async () => undefined) }));

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

test("the shortcut setting is read for local and remote desktop drivers", async () => {
  const cwd = await workspace(); await mkdir(path.join(cwd, ".pi"));
  const file = path.join(cwd, ".pi/computer-use.json");
  for (const escapeStop of [true, false]) {
    await writeFile(file, JSON.stringify({ command: "driver", escapeStop }));
    expect((await loadComputerConfig(cwd)).escapeStop).toBe(escapeStop);
    expect((await readMachineSettings(cwd)).escapeStop).toBe(escapeStop);
  }
  await writeFile(file, JSON.stringify({ command: "driver", escapeStop: "false" }));
  await expect(loadComputerConfig(cwd)).rejects.toThrow();
  await expect(readMachineSettings(cwd)).rejects.toThrow();
});

// LPT-1830: screen zones of the shared sandbox are off unless the project turns them on.
test("the sandbox zones setting is read for local and remote sandboxes, and is off when absent", async () => {
  const cwd = await workspace(); await mkdir(path.join(cwd, ".pi"));
  const file = path.join(cwd, ".pi/computer-use.json");
  await writeFile(file, JSON.stringify({ command: "driver" }));
  expect((await loadComputerConfig(cwd)).sandbox).toBeUndefined();
  expect((await readMachineSettings(cwd)).sandbox).toBeUndefined();
  for (const zones of [true, false]) {
    await writeFile(file, JSON.stringify({ command: "driver", sandbox: { zones } }));
    expect((await loadComputerConfig(cwd)).sandbox).toEqual({ zones });
    expect((await readMachineSettings(cwd)).sandbox).toEqual({ zones });
  }
  for (const sandbox of [{ zones: "on" }, { zones: true, size: 4 }, [true]]) {
    await writeFile(file, JSON.stringify({ command: "driver", sandbox }));
    await expect(loadComputerConfig(cwd)).rejects.toThrow();
    await expect(readMachineSettings(cwd)).rejects.toThrow();
  }
});

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
test("the desktop runtime requires an explicit artifact and refuses custom transport arguments", async () => {
  const cwd = await workspace(); await mkdir(path.join(cwd, ".pi"));
  const config = { command: "/owned/candidate/cua-driver.exe", runtime: "windows-desktop" };
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

test("machines in the agent directory reach every project, and a project machine of the same name replaces one", async () => {
  const agentDir = await workspace();
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const cwd = await workspace();
  await writeFile(path.join(agentDir, "computer-use.json"), JSON.stringify({ machines: { lab: { ssh: "lab-wsl" }, pc: { ssh: "pc-wsl" } } }));
  expect((await readMachineSettings(cwd)).machines).toEqual({ lab: { ssh: "lab-wsl" }, pc: { ssh: "pc-wsl" } });
  vi.stubEnv("CUA_DRIVER_PATH", "/driver.exe");
  expect((await loadComputerConfig(cwd)).machines).toEqual({ lab: { ssh: "lab-wsl" }, pc: { ssh: "pc-wsl" } });
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ machines: { lab: { ssh: "other-wsl" } } }));
  expect((await readMachineSettings(cwd)).machines).toEqual({ lab: { ssh: "other-wsl" }, pc: { ssh: "pc-wsl" } });
  // The global machines file accepts only machines.
  await writeFile(path.join(agentDir, "computer-use.json"), JSON.stringify({ machines: {}, command: "/old/cua-driver.exe" }));
  await expect(readMachineSettings(cwd)).rejects.toThrow("only \"machines\"");
});

test("project arguments continue to select the environment driver", async () => {
  const agentDir = await workspace();
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("CUA_DRIVER_PATH", "/environment/driver.exe");
  const cwd = await workspace();
  await writeFile(path.join(agentDir, "computer-use-local.json"), JSON.stringify({ command: "/trusted/driver.exe", runtime: "windows-desktop", driverOverride: true }));
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ args: ["custom"] }));
  expect(await loadComputerConfig(cwd)).toMatchObject({ command: "/environment/driver.exe", args: ["custom"] });
  expect((await loadComputerConfig(cwd)).driverOverride).toBeUndefined();
});

test("a trusted local driver applies across projects without changing remote machines", async () => {
  const agentDir = await workspace();
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("CUA_DRIVER_PATH", "/fallback/driver.exe");
  const cwd = await workspace();
  await writeFile(path.join(agentDir, "computer-use-local.json"), JSON.stringify({ command: "/trusted/cua-driver.exe", runtime: "windows-desktop", driverOverride: true }));
  await writeFile(path.join(agentDir, "computer-use.json"), JSON.stringify({ machines: { lab: { ssh: "lab-wsl" } } }));
  expect(await loadComputerConfig(cwd)).toEqual({ command: "/trusted/cua-driver.exe", runtime: "windows-desktop", driverOverride: true, machines: { lab: { ssh: "lab-wsl" } } });
  expect((await readMachineSettings(cwd)).machines).toEqual({ lab: { ssh: "lab-wsl" } });
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: "/project/driver.exe" }));
  expect((await loadComputerConfig(cwd)).command).toBe("/project/driver.exe");
  expect((await loadComputerConfig(cwd)).driverOverride).toBeUndefined();
  await rm(path.join(cwd, ".pi/computer-use.json"));
  for (const localDriver of [{ command: "/driver" }, { command: "/driver", runtime: "unknown" }, { command: "/driver", runtime: "windows-desktop", driverOverride: false }]) {
    await writeFile(path.join(agentDir, "computer-use-local.json"), JSON.stringify(localDriver));
    await expect(loadComputerConfig(cwd)).rejects.toThrow();
  }
});

// LPT-967: without a configured socket, the live one found on the machine is used; a configured socket stays as given.
test("an unconfigured interop socket is the live one; a configured one is kept", async () => {
  const { liveInterop } = await import("../src/wsl-interop.ts");
  vi.mocked(liveInterop).mockResolvedValue("/run/WSL/1_interop");
  const bare = await mkdtemp(path.join(".tmp", "config-interop-"));
  owned.push(bare);
  await mkdir(path.join(bare, ".pi"), { recursive: true });
  await writeFile(path.join(bare, ".pi/computer-use.json"), JSON.stringify({ command: "/driver.exe" }));
  expect((await loadComputerConfig(bare)).interop).toBe("/run/WSL/1_interop");
  await writeFile(path.join(bare, ".pi/computer-use.json"), JSON.stringify({ command: "/driver.exe", interop: "/run/WSL/7_interop" }));
  expect((await loadComputerConfig(bare)).interop).toBe("/run/WSL/7_interop");
  vi.mocked(liveInterop).mockResolvedValue(undefined);
});

