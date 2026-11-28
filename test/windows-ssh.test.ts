import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BundledRuntime } from "../src/native-runtime.ts";
import { RemotePreparationUncertain } from "../src/remote-provision-error.ts";
import { installRemoteWindowsRuntime } from "../src/remote-windows-runtime.ts";
import { remoteTransport } from "../src/remote-transport.ts";
import { runnerFiles, type CommandRunner } from "../src/runner.ts";
import { clientCommand, directWindowsRunner, identityScriptPath, prepareSessionHost, sessionHostSources, sessionSshArguments, windowsSshRunner } from "../src/windows-ssh.ts";

/**
 * A fake `ssh` program first on PATH: it records each call's arguments and input, and answers like a Windows machine
 * (or a WSL one) would, so the real runners run their real child processes.
 */
let dir: string;
let originalPath: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pi-fake-ssh-"));
  await writeFile(path.join(dir, "ssh"), `#!/bin/bash
n=$(ls "$FAKE_SSH_DIR" | grep -c '^args-')
printf '%s\\n' "$@" > "$FAKE_SSH_DIR/args-$n"
cat > "$FAKE_SSH_DIR/stdin-$n"
last="\${@: -1}"
kind=other
case "$last" in bash*) kind=bash;; powershell.exe*) kind=powershell;; esac
[ -f "$FAKE_SSH_DIR/$kind.err" ] && cat "$FAKE_SSH_DIR/$kind.err" >&2
[ -f "$FAKE_SSH_DIR/$kind.out" ] && cat "$FAKE_SSH_DIR/$kind.out"
[ -f "$FAKE_SSH_DIR/$kind.code" ] && exit "$(cat "$FAKE_SSH_DIR/$kind.code")"
exit 0
`);
  await chmod(path.join(dir, "ssh"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  process.env.FAKE_SSH_DIR = dir;
});
afterEach(async () => {
  process.env.PATH = originalPath;
  delete process.env.FAKE_SSH_DIR;
  await rm(dir, { recursive: true, force: true });
});
const reply = (kind: "bash" | "powershell" | "other", { out, err, code }: { out?: string | Buffer; err?: string; code?: number }) =>
  Promise.all([out !== undefined && writeFile(path.join(dir, `${kind}.out`), out), err !== undefined && writeFile(path.join(dir, `${kind}.err`), err),
    code !== undefined && writeFile(path.join(dir, `${kind}.code`), String(code))]);
const calls = async () => Promise.all((await readdir(dir)).filter(name => name.startsWith("args-")).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
  .map(async name => ({ args: (await readFile(path.join(dir, name), "utf8")).trimEnd().split("\n"), stdin: await readFile(path.join(dir, name.replace("args-", "stdin-"))) })));
/** Decode the base64 request a client command carries. */
const requestOf = (command: string) => JSON.parse(Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf8"));
const FOLDER = "C:\\Users\\u\\AppData\\Local\\PiComputerUse\\session-host\\0123456789abcdef";
/** Install the helper on a machine whose login shell is answered by a stub, so the machine's folder is known. */
async function prepared(alias: string): Promise<void> {
  const direct: CommandRunner = { ssh: alias, windows: true, spawn: () => { throw new Error("no spawn"); }, run: async () => `${FOLDER}\r\nready\r\n` };
  await prepareSessionHost(direct);
}

test("the remote command line is the helper's own program and plain tokens, and carries no secret", async () => {
  await prepared("lab");
  await prepared("other");
  const command = clientCommand("lab", { file: "C:\\Program Files\\x\\cua-driver.exe", args: ["mcp", "--direct"], env: { A: "it's" } });
  const tokens = command.split(" ");
  // No PowerShell: it would not pass the program's input on as it arrives.
  expect(tokens.slice(0, 2)).toEqual([`${FOLDER}\\pi-session-client.exe`, "run"]);
  expect(tokens).toHaveLength(4);
  expect(tokens[2]).toMatch(/^pi-computer-use-[0-9a-f-]+$/);
  expect(tokens[3]).toMatch(/^[A-Za-z0-9+/=]+$/);
  expect(requestOf(command)).toEqual({ file: "C:\\Program Files\\x\\cua-driver.exe", args: ["mcp", "--direct"], env: { A: "it's" } });
  expect(clientCommand("lab", "ensure")).toBe(`${FOLDER}\\pi-session-client.exe ensure ${tokens[2]}`);
  // One pipe per machine and Pi process: every command of a machine reaches the same helper.
  expect(clientCommand("other", "ensure").split(" ")[2]).not.toBe(tokens[2]);
  expect(() => clientCommand("unprepared", "ensure")).toThrow(/not prepared/);
});

test("ssh keeps strict host-key checking and never prompts, as for every remote machine", async () => {
  await prepared("lab");
  const args = sessionSshArguments("lab", { file: "driver.exe", args: [] });
  expect(args).toContain("StrictHostKeyChecking=yes");
  expect(args).toContain("BatchMode=yes");
  expect(args.at(-2)).toBe("lab");
});

test("a program runs through the helper with its request in the command line, its input untouched, and its output comes back", async () => {
  await prepared("lab");
  await reply("other", { out: "hello\r\n" });
  const runner = windowsSshRunner("lab");
  expect(runner.windows).toBe(true);
  expect(runner.ssh).toBe("lab");
  const bytes = Buffer.from([0, 255, 10, 13, 128]);
  expect(await runner.run("powershell.exe", ["-NoLogo", "a b"], { input: bytes, env: { X: "1" } })).toBe("hello\r\n");
  const [call] = await calls();
  expect(requestOf(call.args.at(-1)!)).toEqual({ file: "powershell.exe", args: ["-NoLogo", "a b"], env: { X: "1" } });
  expect(call.stdin).toEqual(bytes);
});

test("a failed helper reports its message without PowerShell's progress records", async () => {
  await prepared("lab");
  await reply("other", { err: "#< CLIXML\nNo interactive Windows session of u is active on this machine.\n<Objs Version=\"1.1.0.1\"><Obj S=\"progress\"/></Objs>", code: 125 });
  await expect(windowsSshRunner("lab").run("powershell.exe", [])).rejects.toThrow(/^Remote command failed: No interactive Windows session of u is active on this machine\.$/);
});

test("a spawned program gets what the caller writes, and ending its input reaches the helper", async () => {
  await prepared("lab");
  await reply("other", { out: "ready\n" });
  const child = windowsSshRunner("lab").spawn("C:\\driver.exe", ["mcp"], { CUA: "1" });
  child.stdin.write("{\"id\":1}\n");
  child.stdin.end();
  const output = await new Promise<string>(resolve => { let text = ""; child.stdout.on("data", chunk => { text += chunk; }); child.on("close", () => resolve(text)); });
  expect(output).toBe("ready\n");
  const [call] = await calls();
  expect(requestOf(call.args.at(-1)!)).toEqual({ file: "C:\\driver.exe", args: ["mcp"], env: { CUA: "1" } });
  expect(call.stdin.toString()).toBe("{\"id\":1}\n");
});

test("the login session runs only plain tokens, so cmd.exe and PowerShell cannot read a command differently", async () => {
  const direct = directWindowsRunner("lab");
  await reply("powershell", { out: "ok" });
  expect(await direct.run("powershell.exe", ["-EncodedCommand", "QUJD+/=="])).toBe("ok");
  expect(() => direct.run("powershell.exe", ["a b"])).toThrow(/cannot be passed/);
  expect(() => direct.run("powershell.exe", ["a;b"])).toThrow(/cannot be passed/);
  expect(() => direct.run("powershell.exe", ["$(x)"])).toThrow(/cannot be passed/);
  expect(() => directWindowsRunner("-oProxyCommand=x")).toThrow(/Invalid SSH alias/);
  expect(await calls()).toHaveLength(1);
});

test("the helper is built on the machine from the package's own sources, once per version", async () => {
  const scripts: { script: string; input: string }[] = [];
  const direct: CommandRunner = { ssh: "built", spawn: () => { throw new Error("no spawn"); },
    run: async (_file, args, options) => { scripts.push({ script: Buffer.from(args.at(-1)!, "base64").toString("utf16le"), input: String(options?.input) }); return `${FOLDER}\r\nready\r\n`; } };
  await prepareSessionHost(direct);
  const { source, start, identity, version } = sessionHostSources();
  const [{ script, input }] = scripts;
  expect(JSON.parse(input)).toEqual({ source, start, identity });
  // The identity peer's script is far longer than a command line allows, so it is installed beside the helper.
  expect(identityScriptPath("built")).toBe(`${FOLDER}\\window-identity.ps1`);
  // The compiler that ships with Windows builds both programs from one source; an installed version is left alone.
  expect(script).toContain("csc.exe");
  expect(script).toContain("'winexe', 'pi-session-host.exe'");
  expect(script).toContain("'exe', 'pi-session-client.exe'");
  expect(script).toContain(`'${version}'`);
  expect(script.indexOf("Test-Path -LiteralPath (Join-Path $dir 'pi-session-host.exe')")).toBeLessThan(script.indexOf("csc.exe"));
  expect(start).toContain("Register-ScheduledTask");
  expect(start).toContain("-LogonType Interactive");
  const failing: CommandRunner = { ...direct, run: async () => "boom" };
  await expect(prepareSessionHost(failing)).rejects.toThrow(/installation reported: boom/);
});

test("the helper's sources use only what the machine's own C# 5 compiler accepts", async () => {
  const { source } = sessionHostSources();
  expect(source).not.toMatch(/\$"|\?\.|nameof\(|=> /);
  // The pipe must refuse the network by its own flag and the user alone may open it.
  expect(source).toContain("RejectRemoteClients");
  expect(source).toContain("WindowsIdentity.GetCurrent().User");
  expect(source).toContain("0x40000000");
  expect(source).not.toMatch(/TcpListener|TcpClient|System\.Net/);
  // The .NET console streams never see input that arrives after a read began on the overlapped pipes of Windows OpenSSH.
  expect(source).not.toContain("Console.OpenStandard");
  expect(source).toContain("GetOverlappedResult");
});

test("a login that runs bash is a WSL machine, as before; one that only runs PowerShell is Windows without WSL", async () => {
  await reply("bash", { out: "pi-wsl" });
  expect(await remoteTransport("transport-wsl")).toBe("wsl");
  expect((await calls()).map(call => call.args.at(-1)!.split(" ")[0])).toEqual(["bash"]);

  await reply("bash", { out: "", err: "'bash' is not recognized as an internal or external command", code: 1 });
  await reply("powershell", { out: "pi-windows\r\n" });
  expect(await remoteTransport("transport-windows")).toBe("windows");
  // The answer is kept: asking again starts no other SSH command.
  const before = (await calls()).length;
  expect(await remoteTransport("transport-windows")).toBe("windows");
  expect(await calls()).toHaveLength(before);
  // The trusted configuration decides without asking.
  expect(await remoteTransport("transport-configured", "windows")).toBe("windows");
  expect(await calls()).toHaveLength(before);
});

test("a login with neither bash nor PowerShell, or no connection, says so and is asked again next time", async () => {
  await reply("bash", { err: "nope", code: 1 });
  await reply("powershell", { err: "ssh: connect to host x port 22: No route to host", code: 255 });
  await expect(remoteTransport("transport-down")).rejects.toThrow(/runs neither bash \(a WSL login\) nor Windows PowerShell.*No route to host/);
  await reply("powershell", { out: "pi-windows", code: 0 });
  expect(await remoteTransport("transport-down")).toBe("windows");
});

test("files of a Windows machine without WSL travel through PowerShell with exact bytes and Windows paths", async () => {
  const seen: { script: string; input?: string | Buffer }[] = [];
  const answers: string[] = ["", "", "", Buffer.from("png bytes").toString("base64"), "", "a.png\t12\nb.txt\t3\n", ""];
  const runner: CommandRunner = { ssh: "lab", windows: true, spawn: () => { throw new Error("no spawn"); },
    run: async (file, args, options) => { expect(file).toBe("powershell.exe"); seen.push({ script: Buffer.from(args.at(-1)!, "base64").toString("utf16le"), input: options?.input }); return answers.shift() ?? ""; } };
  const files = runnerFiles(runner);
  expect(files.join("C:\\Temp", "pi", "a.png")).toBe("C:\\Temp\\pi\\a.png");
  expect(await files.native("C:\\x")).toBe("C:\\x");
  await files.mkdir("C:\\Temp\\it's");
  expect(seen[0].script).toContain("'C:\\Temp\\it''s'");
  const bytes = Buffer.from([1, 2, 3, 255]);
  await files.write("C:\\Temp\\a.png", bytes);
  expect(seen[1].input).toEqual(bytes);
  expect(seen[1].script).toContain("OpenStandardInput");
  await files.rename("C:\\Temp\\a.png", "C:\\Temp\\b.png");
  expect((await files.read("C:\\Temp\\b.png")).toString()).toBe("png bytes");
  await files.remove("C:\\Temp\\b.png");
  expect(await files.list("C:\\Temp")).toEqual([{ name: "a.png", bytes: 12 }, { name: "b.txt", bytes: 3 }]);
});

/** A runtime of three small files in a folder, as the package carries it. */
async function runtimeFixture(): Promise<BundledRuntime> {
  const root = await mkdtemp(path.join(dir, "runtime-"));
  await mkdir(path.join(root, "runtime"));
  const files: Record<string, string> = {};
  for (const [index, name] of ["cua-driver.exe", "cua-spacesd.exe", "LICENSE.md"].entries()) {
    await writeFile(path.join(root, "runtime", name), `bytes of ${name}`);
    files[name] = String(index).repeat(64);
  }
  return { command: path.join(root, "runtime", "cua-driver.exe"), root, target: "win32-x64", source: "a".repeat(40), version: "1", driverVersion: "1", files };
}
/** A login session that answers the runtime installer's PowerShell steps; each step is told apart by its script. */
function installer(state: { present: boolean; bad?: string[]; staged?: string[]; failTransfer?: string; failPublish?: boolean }) {
  const log: { step: string; input?: string | Buffer }[] = [];
  const staging = "C:\\Users\\u\\AppData\\Local\\PiComputerUse\\native-runtimes\\s\\i\\.staging-ab12cd34";
  const runner: CommandRunner = { ssh: "lab", windows: true, spawn: () => { throw new Error("no spawn"); },
    run: async (_file, args, options) => {
      const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
      const step = script.includes("present = $false") ? "status" : script.includes("'.staging-'") ? "stage" : script.includes("remote_runtime_staging_invalid") ? "publish"
        : script.includes("OpenStandardInput") ? "transfer" : "cleanup";
      log.push({ step, input: options?.input });
      if (step === "status") return JSON.stringify(state.present ? { present: true, destination: "C:\\cache\\win32-x64", bad: state.bad ?? [] } : { present: false, destination: "C:\\cache\\win32-x64" });
      if (step === "stage") return JSON.stringify({ staging, bad: state.staged ?? ["cua-driver.exe", "cua-spacesd.exe", "LICENSE.md"] });
      if (step === "transfer" && state.failTransfer && script.includes(state.failTransfer)) throw new Error("ssh dropped");
      if (step === "publish") { if (state.failPublish) throw new Error("remote_runtime_hash_mismatch: the staged runtime does not match the package"); return "C:\\cache\\win32-x64\\runtime\\cua-driver.exe"; }
      return "";
    } };
  return { runner, log, staging };
}

test("the runtime of a machine without WSL is staged, streamed where the machine could not download it, checked and published", async () => {
  const runtime = await runtimeFixture();
  const f = installer({ present: false, staged: ["cua-spacesd.exe", "LICENSE.md"] });
  expect(await installRemoteWindowsRuntime(f.runner, runtime, "i".repeat(64), "https://example.invalid/release/")).toBe("C:\\cache\\win32-x64\\runtime\\cua-driver.exe");
  expect(f.log.map(entry => entry.step)).toEqual(["status", "stage", "transfer", "transfer", "publish"]);
  // The machine's own download is asked for; only the files it did not get are sent, byte for byte.
  expect(JSON.parse(String(f.log[1].input)).url).toBe("https://example.invalid/release/");
  expect(f.log.filter(entry => entry.step === "transfer").map(entry => String(entry.input))).toEqual(["bytes of LICENSE.md", "bytes of cua-spacesd.exe"]);
  expect(JSON.parse(String(f.log[4].input))).toMatchObject({ staging: f.staging, files: runtime.files });
});

test("a published runtime is verified and reused, and a modified one is refused, never replaced", async () => {
  const runtime = await runtimeFixture();
  const good = installer({ present: true });
  expect(await installRemoteWindowsRuntime(good.runner, runtime, "i".repeat(64), undefined)).toBe("C:\\cache\\win32-x64\\runtime\\cua-driver.exe");
  expect(good.log.map(entry => entry.step)).toEqual(["status"]);
  const modified = installer({ present: true, bad: ["cua-driver.exe"] });
  await expect(installRemoteWindowsRuntime(modified.runner, runtime, "i".repeat(64), undefined)).rejects.toThrow(/existing remote runtime was not replaced/);
  expect(modified.log.map(entry => entry.step)).toEqual(["status"]);
});

test("a transfer that may still be running is reported as unknown, and the staging folder is removed after a failure", async () => {
  const runtime = await runtimeFixture();
  const dropped = installer({ present: false, failTransfer: "cua-spacesd.exe" });
  await expect(installRemoteWindowsRuntime(dropped.runner, runtime, "i".repeat(64), undefined)).rejects.toBeInstanceOf(RemotePreparationUncertain);
  expect(dropped.log.map(entry => entry.step).at(-1)).toBe("cleanup");
  const mismatch = installer({ present: false, failPublish: true });
  await expect(installRemoteWindowsRuntime(mismatch.runner, runtime, "i".repeat(64), undefined)).rejects.toThrow(/staged runtime does not match/);
  expect(mismatch.log.map(entry => entry.step).at(-1)).toBe("cleanup");
});

test("a machine may name its transport and a Windows path for its driver, and nothing else", async () => {
  const { loadComputerConfig } = await import("../src/config.ts");
  const root = await mkdtemp(path.join(dir, "config-"));
  await mkdir(path.join(root, ".pi"));
  const write = (machines: unknown) => writeFile(path.join(root, ".pi/computer-use.json"), JSON.stringify({ command: "/x/cua-driver.exe", machines }));
  await write({ lab: { ssh: "lab", transport: "windows", command: "C:\\rt\\cua-driver.exe", runtime: "windows-desktop" } });
  expect((await loadComputerConfig(root)).machines?.lab).toEqual({ ssh: "lab", transport: "windows", command: "C:\\rt\\cua-driver.exe", runtime: "windows-desktop" });
  await write({ lab: { ssh: "lab" } });
  expect((await loadComputerConfig(root)).machines?.lab).toEqual({ ssh: "lab" });
  for (const bad of [{ lab: { ssh: "lab", transport: "ssh" } }, { lab: { ssh: "lab", transport: "windows", command: "/mnt/c/x.exe" } }, { lab: { ssh: "lab", transport: "wsl", command: "C:\\x.exe" } }]) {
    await write(bad);
    await expect(loadComputerConfig(root)).rejects.toThrow(/Invalid machines/);
  }
}, 30_000);

test("sandboxes and isolated sessions are refused on a Windows machine without WSL before any SSH work", async () => {
  const { sandboxFactory } = await import("../src/machine.ts");
  const transport = vi.spyOn(await import("../src/remote-transport.ts"), "remoteTransport").mockResolvedValue("windows");
  const root = await mkdtemp(path.join(dir, "sandbox-"));
  await mkdir(path.join(root, ".pi"));
  await writeFile(path.join(root, ".pi/computer-use.json"), JSON.stringify({ machines: { lab: { ssh: "lab-win" } } }));
  try {
    const factory = sandboxFactory({ settings: () => ({ kernel: "lanczos3", maxLongEdge: 1280, scale: 1, version: 0, route: "cua_native" }) });
    await expect(factory(root, { action: "open_sandbox" }, undefined, "lab")).rejects.toThrow(/not available on machine lab.*without WSL/);
    await expect(factory(root, { action: "open_session" }, undefined, "lab")).rejects.toThrow(/not available on machine lab.*without WSL/);
    expect(await calls()).toEqual([]);
  } finally { transport.mockRestore(); }
}, 30_000);

test("preparing a Windows machine without WSL installs the helper and the driver, starts the helper and prepares no browser worker", async () => {
  const { runSetup, SetupError } = await import("../src/setup.ts");
  const runtime = await import("../src/remote-runtime.ts");
  const browser = await import("../src/remote-browser.ts");
  const prepareDriver = vi.spyOn(runtime, "prepareRemoteRuntime").mockResolvedValue("C:\\driver\\cua-driver.exe");
  const prepareBrowser = vi.spyOn(browser, "prepareRemoteBrowser");
  const steps: string[] = [];
  const direct: CommandRunner = { ssh: "lab", spawn: () => { throw new Error("no spawn"); }, run: async () => { steps.push("helper installed"); return `${FOLDER}\nready`; } };
  const runner: CommandRunner = { ssh: "lab", windows: true, direct, spawn: () => { throw new Error("no spawn"); }, run: async () => "" };
  const deps = { transport: async () => "windows" as const, windowsSsh: () => runner, ensureSessionHost: async () => { steps.push("helper started"); },
    ssh: () => { throw new Error("a WSL runner must not be used"); } };
  const progress: string[] = [];
  try {
    const message = await runSetup({ part: "machine", ssh: "lab", name: "office" }, ".", { deps, progress: step => progress.push(step) });
    expect(steps).toEqual(["helper installed", "helper started"]);
    expect(prepareDriver).toHaveBeenCalledWith(runner, undefined);
    expect(prepareBrowser).not.toHaveBeenCalled();
    expect(progress).toEqual(["preparing the session helper", "preparing the driver", "starting the session helper in the interactive session"]);
    expect(message).toContain("without WSL");
    expect(JSON.parse(message.slice(message.indexOf("{")))).toEqual({ office: { ssh: "lab", transport: "windows" } });
    // The other parts install through WSL on the machine, which it lacks.
    const root = await mkdtemp(path.join(dir, "setup-"));
    await mkdir(path.join(root, ".pi"));
    await writeFile(path.join(root, ".pi/computer-use.json"), JSON.stringify({ machines: { office: { ssh: "lab" } } }));
    await expect(runSetup({ part: "firefox", machine: "office" }, root, { deps })).rejects.toBeInstanceOf(SetupError);
  } finally { prepareDriver.mockRestore(); prepareBrowser.mockRestore(); }
}, 30_000);
