import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SETUP_SCRIPT, registerSetupCommand, runSetup, splitArgs } from "../src/setup-command.ts";
import { findWindowsNode } from "../src/windows-node.ts";

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function temp(): Promise<string> {
  await mkdir(".tmp", { recursive: true });
  const dir = await mkdtemp(path.resolve(".tmp", "setup-"));
  dirs.push(dir);
  return dir;
}

/** Run scripts/setup.sh from a project folder; these cases stop before any download, SSH or Windows call. */
async function setup(cwd: string, ...args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await run("bash", [SETUP_SCRIPT, ...args], { cwd, timeout: 20_000 });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, out: failed.stdout + failed.stderr };
  }
}

test("setup.sh lists its components and refuses unknown components and machines before doing anything", async () => {
  const cwd = await temp();
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi", "computer-use.json"), JSON.stringify({ machines: { lab: { ssh: "lab-host", command: "/mnt/c/x/cua-driver.exe" } } }));
  const help = await setup(cwd);
  expect(help.code).toBe(0);
  for (const name of ["browser", "firefox", "perception", "mxc", "vscode-bridge", "machine"]) expect(help.out).toContain(name);
  expect(await setup(cwd, "flux")).toMatchObject({ code: 2, out: expect.stringContaining("Unknown component: flux") });
  expect(await setup(cwd, "mxc", "nowhere")).toMatchObject({ code: 1, out: expect.stringContaining("No machine named nowhere") });
  // A machine prepared without the browser worker names the step that adds it.
  expect(await setup(cwd, "firefox", "lab")).toMatchObject({ code: 1, out: expect.stringContaining('Machine lab has no "node"; prepare it with: setup.sh machine lab-host lab') });
  expect((await setup(cwd, "machine")).code).not.toBe(0);
});

test("the command passes quoted paths whole and reports the exit code with the cleaned output tail and full log", async () => {
  expect(splitArgs(` vscode-bridge local "/mnt/c/Tools/VS Code/bin/code.cmd" '/mnt/c/a b/argv.json'`))
    .toEqual(["vscode-bridge", "local", "/mnt/c/Tools/VS Code/bin/code.cmd", "/mnt/c/a b/argv.json"]);
  const dir = await temp();
  const script = path.join(dir, "fake-setup.sh");
  await writeFile(script, 'printf "args:%s|" "$@"; echo; printf "10%%\\r50%%\\r100%%\\n"; echo oops >&2; exit 3\n');
  const result = await runSetup(["perception", "lab"], dir, script);
  expect(result.code).toBe(3);
  expect(result.tail).toBe("args:perception|args:lab|\n100%\noops");
  expect(await readFile(result.log, "utf8")).toContain("10%\r50%\r100%");

  const commands = new Map<string, { getArgumentCompletions: (prefix: string) => unknown; handler: (args: string, ctx: unknown) => Promise<void> }>();
  registerSetupCommand({ registerCommand: (name: string, command: never) => commands.set(name, command) } as unknown as ExtensionAPI, script);
  const command = commands.get("computer-setup")!;
  expect(command.getArgumentCompletions("pe")).toEqual([expect.objectContaining({ value: "perception" })]);
  expect(command.getArgumentCompletions("perception l")).toBeNull();
  const ui = { notify: vi.fn(), setStatus: vi.fn() };
  await command.handler("perception lab", { cwd: dir, ui });
  expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/^Computer setup failed \(exit 3\): perception lab\n.*oops\nFull log: /s), "error");
  expect(ui.setStatus).toHaveBeenLastCalledWith("computer-setup", undefined);
});

test("browsers use the portable Windows Node from setup first, an installed Node next, and otherwise name the setup step", async () => {
  const deps = (present: string[]) => ({ localAppData: async () => "/mnt/c/Users/u/AppData/Local", exists: async (file: string) => present.includes(file) });
  const portable = "/mnt/c/Users/u/AppData/Local/Programs/PiComputerUse/node-v22.22.2-win-x64/node.exe";
  const installed = "/mnt/c/Program Files/nodejs/node.exe";
  expect(await findWindowsNode(undefined, deps([portable, installed]))).toBe(portable);
  expect(await findWindowsNode(undefined, deps([installed]))).toBe(installed);
  await expect(findWindowsNode(undefined, deps([]))).rejects.toThrow(/Ask the user.*\/computer-setup browser/);
});
