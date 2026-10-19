import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect, createServer, type AddressInfo } from "node:net";
import path from "node:path";
import type { ComputerConfig } from "./config.ts";
import { ComputerRequestError } from "./computer-resources.ts";
import { SSH_OPTIONS, WINDOWS_POWERSHELL, type CommandRunner } from "./runner.ts";

/** Host-side commands for the sandbox lifecycle; replaced by a fake in tests. */
export interface SandboxHost {
  /** Run one Windows PowerShell script on the host and return its stdout. */
  powershell(script: string, signal?: AbortSignal, timeoutMs?: number): Promise<string>;
  /** Convert a WSL path to a Windows path, or the reverse with `unix`. */
  path(value: string, to: "windows" | "unix"): Promise<string>;
  /** Files in the host's WSL. readFile returns "" for a missing file. */
  mkdir(path: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  remove(path: string): Promise<void>;
  /** Reach a port on the host's loopback from this machine: the same port locally, an SSH tunnel for another machine. */
  forward(port: number, signal?: AbortSignal): Promise<{ port: number; close(): void }>;
}

/** One host folder shared with the guest. Import is read-only unless requested; export is writable. */
export interface SandboxShare { host: string; guest: string; writable: boolean }
export interface SandboxOptions { shares: SandboxShare[] }

/** A host relay port that reaches one guest port, with the relay process to stop. */
interface Relay { port: number; pid: number }

const GUEST_ROOT = "C:\\pi";
const DRIVER_GUEST_PORT = 47800;
const IDENTITY_GUEST_PORT = 47802;
const SCRIPTS = new URL("../scripts/sandbox/", import.meta.url);
const IDENTITY_SCRIPT = new URL("../scripts/window-identity.ps1", import.meta.url);

const psString = (value: string) => `'${value.replace(/'/g, "''")}'`;
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Validate open_sandbox's explicit file channels before any host work. */
export function sandboxOptions(command: Record<string, unknown>): SandboxOptions {
  const allowed = ["action", "import", "export"];
  if (Object.keys(command).some(key => !allowed.includes(key))) throw new Error("open_sandbox accepts only import and export.");
  const shares: SandboxShare[] = [];
  const imports = command.import ?? [];
  if (!Array.isArray(imports) || imports.length > 8) throw new Error("import is a list of up to 8 host folders.");
  for (const entry of imports) {
    const item = typeof entry === "string" ? { host: entry } : entry;
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each import is a host folder path or {host, guest?, writable?}.");
    const { host, guest, writable } = item as Record<string, unknown>;
    if (Object.keys(item).some(key => !["host", "guest", "writable"].includes(key)) || typeof host !== "string" || !host
      || (guest !== undefined && typeof guest !== "string") || (writable !== undefined && typeof writable !== "boolean"))
      throw new Error("Each import is a host folder path or {host, guest?, writable?}.");
    shares.push({ host, guest: guest as string | undefined ?? `${GUEST_ROOT}\\import\\${path.win32.basename(host.replace(/[\\/]+$/, "")) || "folder"}`, writable: writable === true });
  }
  if (command.export !== undefined) {
    if (typeof command.export !== "string" || !command.export) throw new Error("export is one host folder path.");
    shares.push({ host: command.export, guest: `${GUEST_ROOT}\\export`, writable: true });
  }
  const guests = shares.map(share => share.guest.toLowerCase());
  if (new Set(guests).size !== guests.length) throw new Error("Two shares use the same guest folder; set guest explicitly.");
  for (const share of shares) {
    const guest = share.guest.toLowerCase();
    const reserved = guest === "c:\\pi" || guest.startsWith("c:\\pi\\") && !guest.startsWith("c:\\pi\\import\\") && guest !== "c:\\pi\\export";
    if (!/^[a-z]:\\/.test(guest) || reserved) throw new Error(`Guest folder ${share.guest} must be an absolute Windows path outside ${GUEST_ROOT}.`);
  }
  return { shares };
}

/** Windows Sandbox configuration: no clipboard, audio, video or printer redirection; explicit folders only. */
export function sandboxConfig(runtime: string, config: string, out: string, shares: readonly SandboxShare[]): string {
  const folder = (host: string, guest: string, readOnly: boolean) =>
    `    <MappedFolder><HostFolder>${xml(host)}</HostFolder><SandboxFolder>${xml(guest)}</SandboxFolder><ReadOnly>${readOnly}</ReadOnly></MappedFolder>`;
  return ["<Configuration>",
    "  <VGpu>Disable</VGpu>", "  <Networking>Enable</Networking>", "  <ClipboardRedirection>Disable</ClipboardRedirection>",
    "  <AudioInput>Disable</AudioInput>", "  <VideoInput>Disable</VideoInput>", "  <PrinterRedirection>Disable</PrinterRedirection>",
    "  <MappedFolders>",
    folder(runtime, `${GUEST_ROOT}\\runtime`, true), folder(config, `${GUEST_ROOT}\\config`, true), folder(out, `${GUEST_ROOT}\\out`, false),
    ...shares.map(share => folder(share.host, share.guest, !share.writable)),
    "  </MappedFolders>", "</Configuration>", ""].join("\n");
}

/** Run the sandbox host through a command runner: this machine's Windows, or another machine's over SSH. */
export function runnerHost(runner: CommandRunner): SandboxHost {
  const run = async (file: string, args: string[], signal?: AbortSignal, timeoutMs = 60_000, input?: string) =>
    (await runner.run(file, args, { signal, timeoutMs, input })).replace(/\r/g, "");
  return {
    // Plain-text errors: an encoded command otherwise reports progress and errors as CLIXML on stderr.
    powershell: (script, signal, timeout) => run(WINDOWS_POWERSHELL,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(
        // Continue: under Stop, Windows PowerShell turns redirected native stderr into exceptions. Scripts throw real failures.
        // Explicit exit 0: -Command otherwise exits 1 when the last command only set $? to false.
        `$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Continue'\ntry {\n${script}\nexit 0\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`,
        "utf16le").toString("base64")], signal, timeout),
    path: async (value, to) => (await run("wslpath", [to === "windows" ? "-w" : "-u", value])).trim(),
    mkdir: async dir => { await run("mkdir", ["-p", dir]); },
    writeFile: async (file, content) => { await run("dd", ["status=none", `of=${file}`], undefined, 60_000, content); },
    readFile: file => run("cat", [file]).catch(() => ""),
    remove: async dir => { await run("rm", ["-rf", dir]); },
    forward: async (port, signal) => runner.ssh ? tunnel(runner.ssh, port, signal) : { port, close: () => {} },
  };
}

/** Forward a free local port to a port on the remote machine's loopback over SSH. */
async function tunnel(alias: string, remotePort: number, signal?: AbortSignal): Promise<{ port: number; close(): void }> {
  const local = await new Promise<number>((resolve, reject) => {
    const server = createServer().listen(0, "127.0.0.1", () => { const { port } = server.address() as AddressInfo; server.close(() => resolve(port)); });
    server.on("error", reject);
  });
  const child = spawn("ssh", [...SSH_OPTIONS, "-N", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${local}:127.0.0.1:${remotePort}`, alias], { stdio: "ignore" });
  const close = () => { if (child.exitCode === null) child.kill(); };
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("The SSH tunnel to the sandbox did not start.");
    if (signal?.aborted) { close(); throw new Error("Cancelled while starting the sandbox."); }
    const open = await new Promise<boolean>(resolve => {
      const socket = connect({ host: "127.0.0.1", port: local }, () => { socket.destroy(); resolve(true); });
      socket.on("error", () => resolve(false));
    });
    if (open) return { port: local, close };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  close();
  throw new Error("The SSH tunnel to the sandbox did not start.");
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(new Error("Cancelled while starting the sandbox.")); };
  signal?.addEventListener("abort", abort, { once: true });
});

/** Wait until the guest driver answers; it starts a few seconds after the guest session. */
export async function waitForGuestDriver(driver: { call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ isError?: boolean }>; close(): Promise<void> },
  signal?: AbortSignal, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      if (!(await driver.call("list_windows", {}, signal)).isError) return;
      last = "list_windows failed";
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      await driver.close().catch(() => undefined);
    }
    await sleep(1000, signal);
  }
  throw new Error(`The sandbox driver did not answer within ${timeoutMs / 1000} s. ${last}`);
}
/**
 * One disposable Windows Sandbox with its own CUA driver. It exists for self-isolation, so the agent's work
 * does not touch the human's desktop. The sandbox window is minimized without activation and must stay open.
 */
export class WindowsSandbox {
  readonly ref = "sb-" + randomUUID().slice(0, 8);
  id?: string;
  endpoint?: NonNullable<ComputerConfig["endpoint"]>;
  private relays: Relay[] = [];
  private tunnels: { port: number; close(): void }[] = [];
  /** Sandboxes that existed before this launch; after a launch without a known id, newer ones are this sandbox. */
  private before: string[] = [];
  private launched = false;
  private workdir?: { windows: string; unix: string };
  private closed = false;

  private constructor(private readonly host: SandboxHost, readonly shares: readonly SandboxShare[]) {}

  /** Start a sandbox and its guest driver. Any failure or cancellation stops everything started so far. */
  static async open(host: SandboxHost, runtimeCommand: string, options: SandboxOptions, signal?: AbortSignal): Promise<WindowsSandbox> {
    const sandbox = new WindowsSandbox(host, options.shares);
    try { await sandbox.start(runtimeCommand, signal); }
    catch (error) { await sandbox.close(); throw error; }
    return sandbox;
  }

  private ps(script: string, signal?: AbortSignal, timeoutMs?: number) { return this.host.powershell(script, signal, timeoutMs); }
  private wsb(args: string) { return `& (Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps\\wsb.exe') ${args}`; }

  private async start(runtimeCommand: string, signal?: AbortSignal): Promise<void> {
    const runtime = await this.host.path(path.dirname(runtimeCommand), "windows");
    const shares: SandboxShare[] = [];
    for (const share of this.shares) {
      const windows = /^[A-Za-z]:\\/.test(share.host) ? share.host : await this.host.path(share.host, "windows");
      if (!/^[A-Za-z]:\\/.test(windows)) throw new ComputerRequestError(`Shared folder ${share.host} must be on a Windows drive; Windows Sandbox cannot map ${windows}.`);
      shares.push({ ...share, host: windows });
    }
    if (!/^[A-Za-z]:\\/.test(runtime)) throw new ComputerRequestError("The driver runtime must be on a Windows drive to map it into the sandbox.");
    const check = await this.ps(`$missing = @(${shares.map(share => psString(share.host)).join(",")}) | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Container) }
"sandbox=" + (Test-Path 'C:\\Windows\\System32\\WindowsSandbox.exe') + ";wsb=" + (Test-Path (Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps\\wsb.exe')) + ";missing=" + ($missing -join '|') + ";local=" + $env:LOCALAPPDATA`, signal);
    const facts = Object.fromEntries(check.trim().split(";").map(part => part.split("=") as [string, string]));
    // Nothing has started yet: these are refusals, not unknown outcomes.
    if (facts.sandbox !== "True" || facts.wsb !== "True") throw new ComputerRequestError("Windows Sandbox and its wsb command are not available on this host. Enable the Windows Sandbox feature first.");
    if (facts.missing) throw new ComputerRequestError(`Shared host folders do not exist: ${facts.missing}`);

    const windows = `${facts.local}\\PiComputerUse\\sandboxes\\${this.ref}`;
    const unix = await this.host.path(windows.replace(/\\[^\\]+$/, ""), "unix").then(parent => `${parent}/${this.ref}`);
    this.workdir = { windows, unix };
    await this.host.mkdir(`${unix}/config`);
    await this.host.mkdir(`${unix}/out`);
    for (const name of ["guest-setup.ps1", "guest-start.ps1", "guest-identity-bridge.ps1", "host-relay.ps1"])
      await this.host.writeFile(`${unix}/config/${name}`, await readFile(new URL(name, SCRIPTS), "utf8"));
    await this.host.writeFile(`${unix}/config/window-identity.ps1`, await readFile(IDENTITY_SCRIPT, "utf8"));
    const token = randomBytes(32).toString("hex");
    await this.host.writeFile(`${unix}/config/token.txt`, token);
    await this.host.writeFile(`${unix}/sandbox.wsb`, sandboxConfig(runtime, `${windows}\\config`, `${windows}\\out`, shares));

    // A WindowsSandboxServer started by wsb.exe or WindowsSandbox.exe from WSL/SSH fails; launch through the user's shell
    // and call wsb only once a sandbox VM exists.
    const ids = `@(${this.wsb("list")} | Where-Object { $_ -match '^[0-9a-f-]{36}$' })`;
    const existing = await this.ps(`if (Get-Process WindowsSandboxRemoteSession -ErrorAction SilentlyContinue) { ${ids} }
else { Get-Process WindowsSandboxServer -ErrorAction SilentlyContinue | Stop-Process -Force }`, signal);
    this.before = existing.split("\n").map(line => line.trim()).filter(Boolean);
    const startedAt = new Date().toISOString();
    this.launched = true;
    await this.ps(`Start-Process explorer.exe -ArgumentList ${psString(`${windows}\\sandbox.wsb`)}`, signal);
    const id = await this.ps(`$before = @(${this.before.map(psString).join(",")})
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 1000
  if (Get-Process vmmemWindowsSandbox -ErrorAction SilentlyContinue) {
    $id = ${ids} | Where-Object { $before -notcontains $_ } | Select-Object -First 1
    if ($id) { $id; exit }
  }
}
throw 'The sandbox did not start within 120 s.'`, signal, 150_000);
    this.id = id.trim();

    // Hide the sandbox window from the human without activating it; closing it would stop the sandbox.
    await this.ps(`Add-Type -Namespace PiSandbox -Name User32 -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);'
$since = [DateTime]::Parse(${psString(startedAt)}).AddSeconds(-5)
for ($i = 0; $i -lt 30; $i++) {
  $client = Get-Process WindowsSandboxRemoteSession -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $since -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($client) { [void][PiSandbox.User32]::ShowWindow($client.MainWindowHandle, 7); exit }
  Start-Sleep -Milliseconds 500
}`, signal);

    await this.ps(`for ($i = 0; $i -lt 120; $i++) {
  ${this.wsb(`exec --id ${this.id} --run-as ExistingLogin -c 'cmd.exe /c exit 0'`)} *> $null
  if ($LASTEXITCODE -eq 0) { exit }
  Start-Sleep -Seconds 1
}
throw 'The sandbox user session did not become available within 120 s.'`, signal, 180_000);
    await this.ps(`${this.wsb(`exec --id ${this.id} --run-as System -c 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${GUEST_ROOT}\\config\\guest-setup.ps1'`)} *> $null
${this.wsb(`exec --id ${this.id} --run-as ExistingLogin -c 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${GUEST_ROOT}\\config\\guest-start.ps1'`)} *> $null
((${this.wsb(`ip --id ${this.id} --raw`)} | Out-String | ConvertFrom-Json).Networks | Select-Object -First 1).IpV4Address`, signal, 120_000)
      .then(ip => this.startRelays(ip.trim(), token, signal));
  }

  private async startRelays(ip: string, token: string, signal?: AbortSignal): Promise<void> {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error("The sandbox reported no IPv4 address.");
    const { windows, unix } = this.workdir!;
    const relay = async (guestPort: number): Promise<Relay> => {
      const file = `${windows}\\out\\relay-${guestPort}.txt`;
      // No stdio redirection: it would inherit the interop pipes and keep this call waiting.
      await this.ps(`Start-Process powershell.exe -WindowStyle Hidden -ArgumentList ${psString(`-NoProfile -ExecutionPolicy Bypass -File "${windows}\\config\\host-relay.ps1" -GuestIp ${ip} -GuestPort ${guestPort} -PortFile "${file}"`)}`, signal);
      for (let i = 0; i < 40; i++) {
        const text = await this.host.readFile(`${unix}/out/relay-${guestPort}.txt`);
        const [port, pid] = text.trim().split(/\s+/).map(Number);
        if (port > 0 && pid > 0) return { port, pid };
        await sleep(250, signal);
      }
      throw new Error("The host relay did not start.");
    };
    this.relays.push(await relay(DRIVER_GUEST_PORT));
    this.relays.push(await relay(IDENTITY_GUEST_PORT));
    // Another machine's relays listen on its loopback; reach them through SSH tunnels.
    this.tunnels = [await this.host.forward(this.relays[0].port, signal), await this.host.forward(this.relays[1].port, signal)];
    this.endpoint = { url: `http://127.0.0.1:${this.tunnels[0].port}/mcp`, token, identityPort: this.tunnels[1].port };
  }

  /** Stop the sandbox, its relays and its host folder. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pids = this.relays.map(relay => relay.pid);
    this.relays = [];
    for (const tunnel of this.tunnels) tunnel.close();
    this.tunnels = [];
    // A cancelled launch may have started a sandbox before its id was known: stop every sandbox newer than the launch.
    // Call wsb only once a VM exists (see start).
    const unknown = this.launched && !this.id ? [`$before = @(${this.before.map(psString).join(",")}); $ids = @()`,
      `for ($i = 0; $i -lt 60 -and -not $ids; $i++) { if (Get-Process vmmemWindowsSandbox -ErrorAction SilentlyContinue) { $ids = @(${this.wsb("list")} | Where-Object { $_ -match '^[0-9a-f-]{36}$' -and $before -notcontains $_ }) }; if (-not $ids) { Start-Sleep 1 } }`,
      `foreach ($id in $ids) { ${this.wsb("stop --id $id")} *> $null }`] : [];
    await this.ps([
      ...unknown,
      ...(this.id ? [`${this.wsb(`stop --id ${this.id}`)} *> $null`] : []),
      ...(pids.length ? [`Stop-Process -Id ${pids.join(",")} -Force -ErrorAction SilentlyContinue`] : []),
      "exit 0",
    ].join("\n"), undefined, 120_000).catch(() => undefined);
    if (this.workdir) await this.host.remove(this.workdir.unix).catch(() => undefined);
  }

  /** Readable description for the sandbox address. */
  describe(source: string): string {
    const lines = [`# Windows Sandbox`, `Address: ${source}`, `Sandbox id: ${this.id ?? "unknown"}`,
      "The sandbox window stays minimized on the host; closing it stops the sandbox. Clipboard, audio, video and printers are not shared."];
    for (const share of this.shares) lines.push(`Shared: ${share.host} -> ${share.guest} (${share.writable ? "read/write" : "read-only"})`);
    lines.push("Search this address for guest windows. Insert {\"action\":\"open\",\"app\":\"...\"} to start a guest app, or {\"action\":\"close\"} to destroy the sandbox.");
    return lines.join("\n");
  }
}
