import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { computerSource, parseComputerAddress } from "../src/computer-address.ts";
import { ComputerRequestError, ComputerResources } from "../src/computer-resources.ts";
import { WINDOWS_POWERSHELL, type CommandRunner } from "../src/runner.ts";
import { parseSetupArgs, registerSetupCommand, splitArgs } from "../src/setup-command.ts";
import { MXC } from "../src/setup-pins.ts";
import { SetupError, allowProposedApi, runSetup, type SetupDeps } from "../src/setup.ts";
import { findWindowsNode } from "../src/windows-node.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function project(config?: unknown): Promise<string> {
  await mkdir(".tmp", { recursive: true });
  const dir = await mkdtemp(path.resolve(".tmp", "setup-"));
  dirs.push(dir);
  if (config) { await mkdir(path.join(dir, ".pi")); await writeFile(path.join(dir, ".pi", "computer-use.json"), JSON.stringify(config)); }
  return dir;
}

/** A runner that records commands and answers PowerShell with the decoded script's last expected line. */
function fakeRunner(answer: (script: string) => string = () => "") {
  const calls: { file: string; args: readonly string[]; script?: string }[] = [];
  const runner: CommandRunner = {
    spawn: () => { throw new Error("no spawn in this test"); },
    run: async (file, args, options) => {
      // Setup sends its PowerShell script on stdin as base64 of UTF-8 behind a short fixed command.
      const script = args.includes("-Command") && options?.input ? Buffer.from(String(options.input), "base64").toString("utf8") : undefined;
      calls.push({ file, args, ...(script ? { script } : {}) });
      return script ? answer(script) : "";
    },
  };
  return { runner, calls };
}

function deps(platform: NodeJS.Platform, runner: CommandRunner, wsl = true): Partial<SetupDeps> & { ssh: ReturnType<typeof vi.fn> } {
  return { platform, wsl: async () => wsl, local: () => runner, ssh: vi.fn(() => runner) };
}

test("command words become setup requests; quoted paths stay whole and bad shapes show the usage", () => {
  expect(splitArgs(` vscode-bridge "C:\\Tools\\VS Code\\bin\\code.cmd" 'C:\\a b\\argv.json'`))
    .toEqual(["vscode-bridge", "C:\\Tools\\VS Code\\bin\\code.cmd", "C:\\a b\\argv.json"]);
  expect(parseSetupArgs(["perception"])).toEqual({ part: "perception" });
  expect(parseSetupArgs(["mxc", "lab"])).toEqual({ part: "mxc", machine: "lab" });
  expect(parseSetupArgs(["machine", "lab-wsl", "lab"])).toEqual({ part: "machine", ssh: "lab-wsl", name: "lab" });
  expect(parseSetupArgs(["vscode-bridge", "lab"])).toEqual({ part: "vscode-bridge", machine: "lab" });
  expect(parseSetupArgs(["vscode-bridge", "c.cmd", "argv.json"])).toEqual({ part: "vscode-bridge", code: "c.cmd", argv: "argv.json" });
  expect(parseSetupArgs(["vscode-bridge", "lab", "c.cmd", "argv.json"])).toEqual({ part: "vscode-bridge", machine: "lab", code: "c.cmd", argv: "argv.json" });
  for (const bad of [[], ["flux"], ["machine"], ["mxc", "a", "b"]]) expect(parseSetupArgs(bad)).toBeUndefined();
});

test("argv.json gains the bridge in its proposed-API list without rewriting comments or other keys", () => {
  const id = "alexshpunt.pi-browser-bridge";
  expect(allowProposedApi("")).toBe(`{\n\t"enable-proposed-api": ["${id}"]\n}\n`);
  expect(allowProposedApi(`{\n  // keep\n  "locale": "en"\n}`)).toBe(`{\n\t"enable-proposed-api": ["${id}"],\n  // keep\n  "locale": "en"\n}`);
  expect(allowProposedApi(`{ "enable-proposed-api": [ /* none */ ] }`)).toBe(`{ "enable-proposed-api": ["${id}" /* none */ ] }`);
  expect(allowProposedApi(`{ "enable-proposed-api": ["a.b"] }`)).toBe(`{ "enable-proposed-api": ["${id}", "a.b"] }`);
  expect(allowProposedApi(`{ "enable-proposed-api": ["${id}"] }`)).toBeUndefined();
});

test("a part installs through PowerShell on the right Windows: interop from WSL, directly on Windows, SSH for a machine", async () => {
  const cwd = await project({ interop: "/run/WSL/1_interop", machines: { lab: { ssh: "lab-wsl", command: "/mnt/c/rt/cua-driver.exe" } } });
  const installed = (script: string) => script.includes("wxc-exec.exe") ? "C:\\Users\\u\\AppData\\Local\\PiComputerUse\\mxc\\wxc-exec.exe" : "";

  const wsl = fakeRunner(installed);
  const local = vi.fn(() => wsl.runner);
  expect(await runSetup({ part: "mxc" }, cwd, { deps: { ...deps("linux", wsl.runner), local } }))
    .toBe(`Installed MXC ${MXC.version} on this machine: C:\\Users\\u\\AppData\\Local\\PiComputerUse\\mxc\\wxc-exec.exe`);
  expect(local).toHaveBeenCalledWith("/run/WSL/1_interop");
  expect(wsl.calls[0].file).toBe(WINDOWS_POWERSHELL);
  // The download is checked against its pin on that Windows before anything is unpacked.
  expect(wsl.calls[0].script).toContain(`Get-Pinned '${MXC.url}' $zip '${MXC.sha256}'`);
  expect(wsl.calls[0].script!.indexOf("Get-Pinned '")).toBeLessThan(wsl.calls[0].script!.indexOf("Expand-Zip $zip"));

  const windows = fakeRunner(installed);
  await runSetup({ part: "mxc" }, cwd, { deps: deps("win32", windows.runner) });
  expect(windows.calls[0].file).toBe("powershell.exe");

  const remote = fakeRunner(installed);
  const viaSsh = deps("linux", remote.runner);
  expect(await runSetup({ part: "mxc", machine: "lab" }, cwd, { deps: viaSsh })).toContain("on machine lab");
  expect(viaSsh.ssh).toHaveBeenCalledWith("lab-wsl");
});

test("setup refuses before any command for an unknown machine, another OS or a machine without its browser worker", async () => {
  const cwd = await project({ machines: { lab: { ssh: "lab-wsl", command: "/mnt/c/rt/cua-driver.exe" } } });
  const { runner, calls } = fakeRunner();
  const viaSsh = deps("linux", runner);
  await expect(runSetup({ part: "mxc", machine: "nowhere" }, cwd, { deps: viaSsh })).rejects.toThrow(SetupError);
  expect(viaSsh.ssh).not.toHaveBeenCalled();
  await expect(runSetup({ part: "mxc" }, cwd, { deps: deps("linux", runner, false) })).rejects.toThrow(/Pi on Windows or in WSL/);
  await expect(runSetup({ part: "firefox", machine: "lab" }, cwd, { deps: deps("linux", runner) })).rejects.toThrow(/no browser worker yet/);
  await expect(runSetup({ part: "machine", ssh: "lab-wsl", name: "local" }, cwd, { deps: deps("linux", runner) })).rejects.toThrow(/not local/);
  // Pi on Windows runs the Playwright worker with its own Node.
  expect(await runSetup({ part: "browser" }, cwd, { deps: deps("win32", runner) })).toMatch(/Pi's own Node\. Nothing to install/);
  expect(calls).toEqual([]);
});

test("the agent's setup Insert installs without starting the machine's driver and refuses malformed requests first", async () => {
  const cwd = await project();
  const getSession = vi.fn(), start = vi.fn();
  const resources = new ComputerResources(getSession, async () => { throw new Error("unused"); }, undefined, start);
  const insert = (ref: string, command: unknown) => resources.perform(parseComputerAddress(computerSource("machine", ref))!, cwd, JSON.stringify(command), "insert");
  await expect(insert("local", { action: "setup", part: "flux" })).rejects.toThrow(/setup needs part.*explicitly allowed/);
  await expect(insert("local", { action: "setup", part: "mxc", ssh: "x" })).rejects.toThrow(/belong to setup part machine/);
  await expect(insert("lab", { action: "setup", part: "machine", ssh: "lab-wsl" })).rejects.toThrow(/from computer:machine\/local/);
  await expect(insert("nowhere", { action: "setup", part: "mxc" })).rejects.toThrow(ComputerRequestError);
  expect(getSession).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

test("/computer-setup shows the usage, reports progress in the status line and the result or failure as a notification", async () => {
  const commands = new Map<string, { getArgumentCompletions: (prefix: string) => unknown; handler: (args: string, ctx: unknown) => Promise<void> }>();
  const run = vi.fn(async (_request: unknown, _cwd: string, options?: { progress?: (step: string) => void }) => { options?.progress?.("downloading"); return "Installed."; });
  registerSetupCommand({ registerCommand: (name: string, command: never) => commands.set(name, command) } as unknown as ExtensionAPI, run as never);
  const command = commands.get("computer-setup")!;
  expect(command.getArgumentCompletions("pe")).toEqual([expect.objectContaining({ value: "perception" })]);
  expect(command.getArgumentCompletions("perception l")).toBeNull();
  const ui = { notify: vi.fn(), setStatus: vi.fn() };
  await command.handler("", { cwd: "/p", ui });
  expect(ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("machine SSH_ALIAS [NAME]"), "info");
  await command.handler("perception lab", { cwd: "/p", ui });
  expect(run).toHaveBeenCalledWith({ part: "perception", machine: "lab" }, "/p", expect.anything());
  expect(ui.setStatus).toHaveBeenCalledWith("computer-setup", "Computer setup: perception: downloading…");
  expect(ui.notify).toHaveBeenLastCalledWith("Installed.", "info");
  run.mockRejectedValueOnce(new Error("offline"));
  await command.handler("mxc", { cwd: "/p", ui });
  expect(ui.notify).toHaveBeenLastCalledWith("Computer setup: mxc failed: offline", "error");
  expect(ui.setStatus).toHaveBeenLastCalledWith("computer-setup", undefined);
});

test("browsers use the portable Windows Node from setup first, an installed Node next, and otherwise name the setup step", async () => {
  const fake = (present: string[]) => ({ localAppData: async () => "/mnt/c/Users/u/AppData/Local", exists: async (file: string) => present.includes(file) });
  const portable = "/mnt/c/Users/u/AppData/Local/Programs/PiComputerUse/node-v22.22.2-win-x64/node.exe";
  const installed = "/mnt/c/Program Files/nodejs/node.exe";
  expect(await findWindowsNode(undefined, fake([portable, installed]))).toBe(portable);
  expect(await findWindowsNode(undefined, fake([installed]))).toBe(installed);
  await expect(findWindowsNode(undefined, fake([]))).rejects.toThrow(/Ask the user.*"part":"browser"/);
});
