import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import path from "node:path";
import type { ComputerConfig } from "./config.ts";
import { ComputerRequestError } from "./computer-resources.ts";
import { SSH_OPTIONS, powershellOf, runnerFiles, type CommandRunner } from "./runner.ts";
import { startSessionRelay } from "./session-relay-host.ts";
import type { SessionRelay, SessionRelayKeys } from "./session-relay.ts";
import type { RelayCredentials } from "./relay-auth.ts";
import { ActivityPublisher, STREAM_FILE } from "./isolated-session.ts";
import { createStreamHub, type StreamHub } from "./session-stream.ts";
import type { TileHostStarter } from "./tile-host.ts";
import type { HighlightFrame } from "./native-visuals.ts";

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
  /** Host-owned Node reverse relay; only needed for MXC, not Sandbox. */
  reverseRelay?(workdir: string, keys: SessionRelayKeys, signal?: AbortSignal): Promise<SessionRelay>;
}

/**
 * One host folder shared with the guest. Import is read-only unless requested; export is writable. Without an explicit
 * guest folder it goes under the agent's own folder C:\pi\agents\<sandbox ref>\, so agents in one sandbox never collide.
 */
export interface SandboxShare { host: string; guest?: string; writable: boolean; kind: "import" | "export" }
export interface SandboxOptions { shares: SandboxShare[] }

/** A host relay port that reaches one guest port, with the relay process to stop. */
interface Relay { port: number; pid: number }

/** What the agents attached to the shared sandbox read from its host folder; written once by the agent that starts it. */
interface SharedState {
  /** Bumped when agents of this version cannot use a sandbox an earlier version started. */
  version: 2;
  id: string;
  token: string;
  identityAuth: RelayCredentials;
  /** The Windows runtime folder mapped into the guest; agents with another runtime cannot use this guest driver. */
  runtime: string;
  startedAt: string;
  relays: { driver: Relay; identity: Relay; lease: Relay; stream: Relay };
  /** The guest cua-spacesd's token, for the window streams of the session tiles. */
  spacesdToken: string;
  watchdog: { key: string; pid: number };
}

const GUEST_ROOT = "C:\\pi";
const DRIVER_GUEST_PORT = 47800;
const IDENTITY_GUEST_PORT = 47802;
const LEASE_GUEST_PORT = 47803;
const STREAM_GUEST_PORT = 47804;
/** Agents touch their file this often; the host watchdog drops one whose file is older than STALE_SECONDS. */
const HEARTBEAT_MS = 30_000;
const STALE_SECONDS = 120;
/** The sandbox stops this long after its last agent left. */
export const IDLE_SECONDS = 600;
const SCRIPTS = new URL("../scripts/sandbox/", import.meta.url);
const COMMON_SCRIPTS = new URL("../scripts/", import.meta.url);
const RELAY_AUTH_SCRIPT = new URL("../scripts/session/relay-auth.ps1", import.meta.url);

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
    shares.push({ host, ...(guest !== undefined ? { guest: guest as string } : {}), writable: writable === true, kind: "import" });
  }
  if (command.export !== undefined) {
    if (typeof command.export !== "string" || !command.export) throw new Error("export is one host folder path.");
    shares.push({ host: command.export, writable: true, kind: "export" });
  }
  for (const share of shares) {
    const guest = share.guest?.toLowerCase();
    if (guest !== undefined && (!/^[a-z]:\\/.test(guest) || guest === "c:\\pi" || guest.startsWith("c:\\pi\\")))
      throw new Error(`Guest folder ${share.guest} must be an absolute Windows path outside ${GUEST_ROOT}.`);
  }
  const guests = shares.map(share => guestFolder(share, "sb-check").toLowerCase());
  if (new Set(guests).size !== guests.length) throw new Error("Two shares use the same guest folder; set guest explicitly.");
  return { shares };
}

/** Where a share appears in the guest: its explicit folder, or one under this agent's own folder. */
export function guestFolder(share: SandboxShare, ref: string): string {
  if (share.guest) return share.guest;
  const root = `${GUEST_ROOT}\\agents\\${ref}`;
  return share.kind === "export" ? `${root}\\export` : `${root}\\import\\${path.win32.basename(share.host.replace(/[\\/]+$/, "")) || "folder"}`;
}

/** Windows Sandbox configuration: no clipboard, audio, video or printer redirection. Agents add their own folders with wsb share. */
export function sandboxConfig(runtime: string, config: string, out: string): string {
  const folder = (host: string, guest: string, readOnly: boolean) =>
    `    <MappedFolder><HostFolder>${xml(host)}</HostFolder><SandboxFolder>${xml(guest)}</SandboxFolder><ReadOnly>${readOnly}</ReadOnly></MappedFolder>`;
  return ["<Configuration>",
    "  <VGpu>Disable</VGpu>", "  <Networking>Enable</Networking>", "  <ClipboardRedirection>Disable</ClipboardRedirection>",
    "  <AudioInput>Disable</AudioInput>", "  <VideoInput>Disable</VideoInput>", "  <PrinterRedirection>Disable</PrinterRedirection>",
    "  <MappedFolders>",
    folder(runtime, `${GUEST_ROOT}\\runtime`, true), folder(config, `${GUEST_ROOT}\\config`, true), folder(out, `${GUEST_ROOT}\\out`, false),
    "  </MappedFolders>", "</Configuration>", ""].join("\n");
}

/** A TCP connection to this machine's loopback port, cancellable while it connects. */
export function connectLoopback(port: number, signal?: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Cancelled while connecting.")); return; }
    const socket = connect({ host: "127.0.0.1", port });
    const abort = () => socket.destroy(new Error("Cancelled while connecting."));
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => { signal?.removeEventListener("abort", abort); resolve(socket); });
    socket.once("error", error => { signal?.removeEventListener("abort", abort); reject(error); });
  });
}

/** Run the sandbox host through a command runner: this machine's Windows, or another machine's over SSH. */
export function runnerHost(runner: CommandRunner): SandboxHost {
  const run = async (file: string, args: string[], signal?: AbortSignal, timeoutMs = 60_000, input?: string) =>
    (await runner.run(file, args, { signal, timeoutMs, input })).replace(/\r/g, "");
  const files = runnerFiles(runner);
  return {
    // Plain-text errors: an encoded command otherwise reports progress and errors as CLIXML on stderr.
    powershell: (script, signal, timeout) => run(powershellOf(runner),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(
        // Continue: under Stop, Windows PowerShell turns redirected native stderr into exceptions. Scripts throw real failures.
        // Explicit exit 0: -Command otherwise exits 1 when the last command only set $? to false.
        `$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Continue'\ntry {\n${script}\nexit 0\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`,
        "utf16le").toString("base64")], signal, timeout),
    path: (value, to) => to === "windows" ? files.windows(value) : files.native(value),
    mkdir: dir => files.mkdir(dir),
    writeFile: (file, content) => files.write(file, content),
    readFile: file => files.read(file).then(bytes => bytes.toString("utf8").replace(/\r/g, ""), () => ""),
    remove: dir => files.remove(dir),
    forward: async (port, signal) => runner.ssh ? tunnel(runner.ssh, port, signal) : { port, close: () => {} },
    reverseRelay: (workdir, keys, signal) => startSessionRelay(runner, workdir, keys, signal),
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

const GUEST_ATTEMPT_MS = 5_000;
/** Wait until the guest driver answers; it starts a few seconds after the guest session. */
export async function waitForGuestDriver(driver: { call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ isError?: boolean }>; close(): Promise<void> },
  signal?: AbortSignal, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    // Until the guest connects its relay, an attempt waits out the full request timeout of 15 s. Short attempts notice
    // the guest within seconds; the last 15 s go to one long attempt for a guest that answers slowly.
    const remaining = deadline - Date.now();
    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(new Error("The guest driver did not answer this attempt.")), remaining > 15_000 ? GUEST_ATTEMPT_MS : remaining);
    try {
      if (!(await driver.call("list_windows", {}, signal ? AbortSignal.any([signal, limit.signal]) : limit.signal)).isError) return;
      last = "list_windows failed";
    } catch (error) {
      signal?.throwIfAborted();
      last = error instanceof Error ? error.message : String(error);
      await driver.close().catch(() => undefined);
    } finally { clearTimeout(timer); }
    await sleep(1000, signal);
  }
  throw new Error(`The sandbox driver did not answer within ${timeoutMs / 1000} s. ${last}`);
}
/**
 * One agent's place in the machine's shared Windows Sandbox. Windows runs one sandbox at a time, so every agent on the
 * machine works in the same one: the first agent starts it, later agents attach, and each gets its own session on the
 * one guest driver and its own folders. Input takes turns through the guest's lease service. The sandbox window stays
 * minimized; a watchdog on the host stops the sandbox IDLE_SECONDS after the last agent leaves, or cleans up when the
 * human closes it.
 */
export class WindowsSandbox {
  readonly ref = "sb-" + randomUUID().slice(0, 8);
  id?: string;
  endpoint?: NonNullable<ComputerConfig["endpoint"]> & { leasePort: number; streamPort: number; spacesdToken: string };
  /** This agent started the sandbox; later agents attached to it. */
  started = false;
  /** The guest folders of this agent's shares. */
  readonly guestShares: (SandboxShare & { guest: string })[];
  private tunnels: { port: number; close(): void }[] = [];
  private heartbeat?: NodeJS.Timeout;
  private dir?: { windows: string; unix: string };
  private registered = false;
  private closed = false;
  /** The host's %LOCALAPPDATA%, where tile hosts find this agent's window stream. */
  private localAppData?: string;
  private hub?: StreamHub;
  private publisher?: ActivityPublisher;
  private tiles: { state: "off" | "starting" | "started" | "running" | "failed"; error?: string } = { state: "off" };
  private streamFolder?: string;

  /** Report the agent's window activity to its stream hub, for the agent cursor on its tiles; a no-op without tiles. */
  readonly activity = (frame: HighlightFrame): void => { this.publisher?.observe(frame); };

  /**
   * Show this agent's sandbox windows as tiles on the human's desktop, like an isolated session's: a stream hub in this
   * process serves only the windows of processes `accept` names, and the machine's tile host finds it through
   * stream.json in the host user's own folder. The hub runs in this Pi process, so tiles need the sandbox's machine to be
   * this one. A failed tile host start is reported by describe() and never fails the sandbox.
   */
  async showTiles(accept: (pid: number) => boolean, tileHost: TileHostStarter, signal?: AbortSignal): Promise<void> {
    const endpoint = this.endpoint, local = this.localAppData;
    if (!endpoint || !local) return;
    const viewer = randomBytes(32).toString("hex");
    this.hub = await createStreamHub({ session: this.ref, spacesdToken: endpoint.spacesdToken, viewerToken: viewer, accept,
      connect: connectSignal => connectLoopback(endpoint.streamPort, connectSignal) });
    const folder = `${await this.host.path(`${local}\\PiComputerUse\\sessions`, "unix")}/${this.ref}`;
    await this.host.mkdir(folder);
    this.streamFolder = folder;
    await this.host.writeFile(`${folder}/${STREAM_FILE}`, JSON.stringify({ version: 1, session: this.ref, agentUser: this.ref,
      url: `ws://127.0.0.1:${this.hub.port}/v1/stream`, token: viewer }, null, 2));
    this.publisher = new ActivityPublisher(this.hub.port, viewer);
    signal?.throwIfAborted();
    this.tiles = { state: "starting" };
    void tileHost(this.host, local).then(state => { this.tiles = { state }; },
      error => { this.tiles = { state: "failed", error: error instanceof Error ? error.message : String(error) }; });
  }
  private constructor(private readonly host: SandboxHost, shares: readonly SandboxShare[]) {
    this.guestShares = shares.map(share => ({ ...share, guest: guestFolder(share, this.ref) }));
  }

  /** Attach to the machine's shared sandbox, starting it when none runs. Any failure leaves nothing of this agent behind. */
  static async open(host: SandboxHost, runtimeCommand: string, options: SandboxOptions, signal?: AbortSignal): Promise<WindowsSandbox> {
    const sandbox = new WindowsSandbox(host, options.shares);
    try { await sandbox.attach(runtimeCommand, signal); }
    catch (error) { await sandbox.close(); throw error; }
    return sandbox;
  }

  private ps(script: string, signal?: AbortSignal, timeoutMs?: number) { return this.host.powershell(script, signal, timeoutMs); }
  private wsb(args: string) { return `& (Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps\\wsb.exe') ${args}`; }

  private async attach(runtimeCommand: string, signal?: AbortSignal): Promise<void> {
    const runtime = await this.host.path(path.dirname(runtimeCommand), "windows");
    if (!/^[A-Za-z]:\\/.test(runtime)) throw new ComputerRequestError("The driver runtime must be on a Windows drive to map it into the sandbox.");
    for (const share of this.guestShares) {
      const windows = /^[A-Za-z]:\\/.test(share.host) ? share.host : await this.host.path(share.host, "windows");
      if (!/^[A-Za-z]:\\/.test(windows)) throw new ComputerRequestError(`Shared folder ${share.host} must be on a Windows drive; Windows Sandbox cannot map ${windows}.`);
      share.host = windows;
    }
    const check = await this.ps(`$missing = @(${this.guestShares.map(share => psString(share.host)).join(",")}) | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Container) }
"sandbox=" + (Test-Path 'C:\\Windows\\System32\\WindowsSandbox.exe') + ";wsb=" + (Test-Path (Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps\\wsb.exe')) + ";missing=" + ($missing -join '|') + ";local=" + $env:LOCALAPPDATA`, signal);
    const facts = Object.fromEntries(check.trim().split(";").map(part => part.split("=") as [string, string]));
    // Nothing has started yet: these are refusals, not unknown outcomes.
    if (facts.sandbox !== "True" || facts.wsb !== "True") throw new ComputerRequestError("Windows Sandbox and its wsb command are not available on this host. Enable the Windows Sandbox feature first.");
    if (facts.missing) throw new ComputerRequestError(`Shared host folders do not exist: ${facts.missing}`);

    const parent = `${facts.local}\\PiComputerUse\\sandboxes`;
    const windows = `${parent}\\shared`;
    this.dir = { windows, unix: `${await this.host.path(parent, "unix")}/shared` };
    await this.host.mkdir(`${this.dir.unix}/agents`);
    await this.lock(signal);
    let state: SharedState;
    try {
      const status = (await this.ps(sharedStatus(windows), signal)).trim();
      if (status === "foreign") throw new ComputerRequestError("A Windows Sandbox that computer use did not start is running on this machine, and Windows allows only one. "
        + "Close it first, then open the sandbox again. Nothing was started.");
      if (status === "stale") await this.ps(stopShared(windows), undefined, 120_000);
      state = status === "alive" ? this.parseState(await this.host.readFile(`${this.dir.unix}/sandbox.json`)) : await this.start(runtime, signal);
      if (state.runtime.toLowerCase() !== runtime.toLowerCase()) throw new ComputerRequestError("The shared sandbox runs another computer-use runtime, so this agent cannot use its driver. "
        + `It stops ${IDLE_SECONDS / 60} minutes after its last agent leaves; open the sandbox again after that. Nothing was changed.`);
      this.id = state.id;
      await this.touch();
      this.registered = true;
    } finally { await this.host.remove(`${this.dir.unix}/lock`).catch(() => undefined); }
    this.heartbeat = setInterval(() => { void this.touch().catch(() => undefined); }, HEARTBEAT_MS);
    this.heartbeat.unref();

    for (const share of this.guestShares)
      await this.ps(`${this.wsb(`share --id ${state.id} -f ${psString(share.host)} -s ${psString(share.guest)}${share.writable ? " --allow-write" : ""}`)} 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { throw ${psString(`Could not share ${share.host} as ${share.guest}.`)} }`, signal);
    // Another machine's relays listen on its loopback; reach them through SSH tunnels.
    for (const relay of [state.relays.driver, state.relays.identity, state.relays.lease, state.relays.stream]) this.tunnels.push(await this.host.forward(relay.port, signal));
    this.endpoint = { url: `http://127.0.0.1:${this.tunnels[0].port}/mcp`, token: state.token, identityPort: this.tunnels[1].port,
      identityAuth: state.identityAuth, leasePort: this.tunnels[2].port, streamPort: this.tunnels[3].port, spacesdToken: state.spacesdToken };
    this.localAppData = facts.local;
  }

  /**
   * Take the shared folder's start lock; the agent that holds it starts the sandbox or registers with it. The lock is a
   * file created with CreateNew, which is atomic: New-Item -ItemType Directory checks and then creates, so agents that
   * race can all succeed.
   */
  private async lock(signal?: AbortSignal): Promise<void> {
    await this.ps(`${takeLock(`${this.dir!.windows}\\lock`)}
throw 'Another agent is still starting the shared sandbox; try again in a few minutes.'`, signal, 330_000);
  }

  private parseState(text: string): SharedState {
    let state: SharedState | undefined;
    try { state = JSON.parse(text) as SharedState; } catch { /* Reported below. */ }
    if (state && state.version !== 2) throw new ComputerRequestError("The shared sandbox was started by another version of computer use, so this agent cannot use it. "
      + `It stops ${IDLE_SECONDS / 60} minutes after its last agent leaves; open the sandbox again after that. Nothing was changed.`);
    if (state && typeof state.id === "string" && state.relays?.lease?.port > 0 && state.relays?.stream?.port > 0) return state;
    throw new Error("The shared sandbox's state is unreadable.");
  }

  /** Mark this agent as present; the host watchdog keeps the sandbox while any agent's mark is fresh. */
  private touch(): Promise<void> {
    return this.host.writeFile(`${this.dir!.unix}/agents/${this.ref}.json`, JSON.stringify({ ref: this.ref, at: new Date().toISOString() }));
  }

  /** Start the sandbox, its guest driver and lease service, the host relays and the watchdog; called under the lock. */
  private async start(runtime: string, signal?: AbortSignal): Promise<SharedState> {
    const { windows, unix } = this.dir!;
    this.started = true;
    let startedAt: string | undefined;
    let launched = false;
    let id: string | undefined;
    const relays: Relay[] = [];
    try {
      await this.host.mkdir(`${unix}/config`);
      await this.host.mkdir(`${unix}/out`);
      for (const name of ["guest-setup.ps1", "guest-start.ps1", "guest-identity-bridge.ps1", "guest-lease.ps1", "guest-lease.cs", "host-relay.ps1", "host-watchdog.ps1"])
        await this.host.writeFile(`${unix}/config/${name}`, await readFile(new URL(name, SCRIPTS), "utf8"));
      for (const name of ["window-identity.ps1", "identity-auth.ps1", "identity-channel.ps1", "identity-channel.cs"])
        await this.host.writeFile(`${unix}/config/${name}`, await readFile(new URL(name, COMMON_SCRIPTS), "utf8"));
      await this.host.writeFile(`${unix}/config/relay-auth.ps1`, await readFile(RELAY_AUTH_SCRIPT, "utf8"));
      const token = randomBytes(32).toString("hex");
      const identityAuth = { session: "sb-shared", key: randomBytes(32).toString("hex") };
      await this.host.writeFile(`${unix}/config/token.txt`, token);
      const spacesdToken = randomBytes(32).toString("hex");
      await this.host.writeFile(`${unix}/config/spacesd-token.txt`, spacesdToken);
      await this.host.writeFile(`${unix}/config/identity.json`, JSON.stringify(identityAuth));
      await this.host.writeFile(`${unix}/sandbox.wsb`, sandboxConfig(runtime, `${windows}\\config`, `${windows}\\out`));

      // A WindowsSandboxServer started by wsb.exe or WindowsSandbox.exe from WSL/SSH fails; launch through the user's shell
      // and call wsb only once a sandbox VM exists.
      const ids = `@(${this.wsb("list")} | Where-Object { $_ -match '^[0-9a-f-]{36}$' })`;
      await this.ps("Get-Process WindowsSandboxServer -ErrorAction SilentlyContinue | Stop-Process -Force", signal);
      startedAt = new Date().toISOString();
      launched = true;
      await this.ps(`Start-Process explorer.exe -ArgumentList ${psString(`${windows}\\sandbox.wsb`)}`, signal);
      id = (await this.ps(`for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 1000
  if (Get-Process vmmemWindowsSandbox -ErrorAction SilentlyContinue) {
    $id = ${ids} | Select-Object -First 1
    if ($id) { $id; exit }
  }
}
throw 'The sandbox did not start within 120 s.'`, signal, 150_000)).trim();

      // Hide the sandbox window from the human without activating it; closing it would stop the sandbox.
      await this.ps(`Add-Type -Namespace PiSandbox -Name User32 -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);'
$since = [DateTime]::Parse(${psString(startedAt)}).AddSeconds(-5)
for ($i = 0; $i -lt 30; $i++) {
  $client = Get-Process WindowsSandboxRemoteSession -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $since -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($client) { [void][PiSandbox.User32]::ShowWindow($client.MainWindowHandle, 7); exit }
  Start-Sleep -Milliseconds 500
}`, signal);

      await this.ps(`for ($i = 0; $i -lt 120; $i++) {
  ${this.wsb(`exec --id ${id} --run-as ExistingLogin -c 'cmd.exe /c exit 0'`)} *> $null
  if ($LASTEXITCODE -eq 0) { exit }
  Start-Sleep -Seconds 1
}
throw 'The sandbox user session did not become available within 120 s.'`, signal, 180_000);
      const ip = (await this.ps(`${this.wsb(`exec --id ${id} --run-as System -c 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${GUEST_ROOT}\\config\\guest-setup.ps1'`)} *> $null
${this.wsb(`exec --id ${id} --run-as ExistingLogin -c 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${GUEST_ROOT}\\config\\guest-start.ps1'`)} *> $null
((${this.wsb(`ip --id ${id} --raw`)} | Out-String | ConvertFrom-Json).Networks | Select-Object -First 1).IpV4Address`, signal, 120_000)).trim();
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error("The sandbox reported no IPv4 address.");

      const relay = async (guestPort: number): Promise<Relay> => {
        const file = `${windows}\\out\\relay-${guestPort}.txt`;
        // No stdio redirection: it would inherit the interop pipes and keep this call waiting.
        await this.ps(`Start-Process powershell.exe -WindowStyle Hidden -ArgumentList ${psString(`-NoProfile -ExecutionPolicy Bypass -File "${windows}\\config\\host-relay.ps1" -GuestIp ${ip} -GuestPort ${guestPort} -PortFile "${file}"`)}`, signal);
        for (let i = 0; i < 40; i++) {
          const text = await this.host.readFile(`${unix}/out/relay-${guestPort}.txt`);
          const [port, pid] = text.trim().split(/\s+/).map(Number);
          if (port > 0 && pid > 0) { const started = { port, pid }; relays.push(started); return started; }
          await sleep(250, signal);
        }
        throw new Error("The host relay did not start.");
      };
      const state: SharedState = { version: 2, id, token, identityAuth, runtime, startedAt, spacesdToken,
        relays: { driver: await relay(DRIVER_GUEST_PORT), identity: await relay(IDENTITY_GUEST_PORT), lease: await relay(LEASE_GUEST_PORT), stream: await relay(STREAM_GUEST_PORT) },
        watchdog: { key: randomBytes(16).toString("hex"), pid: 0 } };
      await this.host.writeFile(`${unix}/sandbox.json`, JSON.stringify(state));
      const pid = Number((await this.ps(`(Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList ${psString(`-NoProfile -ExecutionPolicy Bypass -File "${windows}\\config\\host-watchdog.ps1" -Dir "${windows}" -Key ${state.watchdog.key} -IdleSeconds ${IDLE_SECONDS} -StaleSeconds ${STALE_SECONDS}`)}).Id`, signal)).trim());
      if (!(pid > 0)) throw new Error("The sandbox watchdog did not start.");
      state.watchdog.pid = pid;
      await this.host.writeFile(`${unix}/sandbox.json`, JSON.stringify(state));
      return state;
    } catch (error) {
      // A cancelled launch may have started a sandbox before its id was known; only this launch's sandbox can be running.
      // Call wsb only once a VM exists (see above).
      const unknown = launched && !id ? [`$ids = @()`,
        `for ($i = 0; $i -lt 60 -and -not $ids; $i++) { if (Get-Process vmmemWindowsSandbox -ErrorAction SilentlyContinue) { $ids = @(${this.wsb("list")} | Where-Object { $_ -match '^[0-9a-f-]{36}$' }) }; if (-not $ids) { Start-Sleep 1 } }`,
        `foreach ($id in $ids) { ${this.wsb("stop --id $id")} *> $null }`] : [];
      await this.ps([
        ...unknown,
        ...(id ? [`${this.wsb(`stop --id ${id}`)} *> $null`] : []),
        // wsb stop is what stops the VM; closing the sandbox client this launch started only removes its window.
        ...(startedAt ? [`Get-Process WindowsSandboxRemoteSession -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge [DateTime]::Parse(${psString(startedAt)}).AddSeconds(-5) } | Stop-Process -Force`] : []),
        ...(relays.length ? [`Stop-Process -Id ${relays.map(relay => relay.pid).join(",")} -Force -ErrorAction SilentlyContinue`] : []),
        "exit 0",
      ].join("\n"), undefined, 120_000).catch(() => undefined);
      for (const name of ["sandbox.json", "sandbox.wsb", "config", "out"]) await this.host.remove(`${unix}/${name}`).catch(() => undefined);
      throw error;
    }
  }

  /** Leave the shared sandbox: this agent's tunnels and presence go; the sandbox stays for other agents. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.publisher?.close();
    if (this.streamFolder) await this.host.remove(this.streamFolder).catch(() => undefined);
    await this.hub?.close().catch(() => undefined);
    for (const tunnel of this.tunnels) tunnel.close();
    this.tunnels = [];
    if (this.registered) await this.host.remove(`${this.dir!.unix}/agents/${this.ref}.json`).catch(() => undefined);
  }

  /** Readable description for the sandbox address. */
  describe(source: string): string {
    const lines = [`# Windows Sandbox`, `Address: ${source}`, `Sandbox id: ${this.id ?? "unknown"}`,
      `Shared: other agents on this machine work in the same sandbox. This session sees only the windows of apps it starts here; input waits for its turn with theirs.`,
      "The sandbox window stays minimized on the host. Clipboard, audio, video and printers are not shared with the host.",
      ...(this.tiles.state === "off" ? [] : [this.tiles.state === "failed" ? `Live tiles of this session's windows on the human's desktop: unavailable (${this.tiles.error}).`
        : this.tiles.state === "starting" ? "Live tiles of this session's windows on the human's desktop: starting."
        : "Live tiles of this session's windows on the human's desktop: shown under all windows; Ctrl+Alt+Space raises them over all windows."])];
    for (const share of this.guestShares) lines.push(`Folder: ${share.host} -> ${share.guest} (${share.writable ? "read/write" : "read-only"})`);
    lines.push(`Search this address for this session's guest windows. computer_open at this address starts a guest app. Delete leaves the sandbox and closes the apps this session started; the sandbox stops ${IDLE_SECONDS / 60} minutes after its last agent leaves.`);
    return lines.join("\n");
  }
}

/** PowerShell that waits up to 5 minutes for the lock file and exits once it holds it; a lock older than 10 minutes is stale. */
export function takeLock(lock: string): string {
  return `for ($i = 0; $i -lt 1200; $i++) {
  try { ([IO.File]::Open(${psString(lock)}, 'CreateNew', 'Write', 'None')).Dispose(); exit } catch {}
  $held = Get-Item -LiteralPath ${psString(lock)} -ErrorAction SilentlyContinue
  if ($held -and $held.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddMinutes(-10)) { Remove-Item -LiteralPath ${psString(lock)} -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 250
}`;
}

/** Whether the shared sandbox runs: alive (with its relays and watchdog), stale (state left without them), foreign (another sandbox runs) or none. */
function sharedStatus(dir: string): string {
  return `$state = Join-Path ${psString(dir)} 'sandbox.json'
$client = [bool](Get-Process WindowsSandboxRemoteSession -ErrorAction SilentlyContinue)
if (Test-Path -LiteralPath $state) {
  try { $s = Get-Content -Raw -LiteralPath $state | ConvertFrom-Json } catch { 'stale'; exit }
  $pids = @($s.relays.driver.pid, $s.relays.identity.pid, $s.relays.lease.pid, $s.relays.stream.pid, $s.watchdog.pid)
  $running = @($pids | Where-Object { $_ -gt 0 -and (Get-Process -Id $_ -ErrorAction SilentlyContinue) }).Count
  if ($client -and (Get-Process vmmemWindowsSandbox -ErrorAction SilentlyContinue) -and $running -eq $pids.Count) { 'alive' } else { 'stale' }
} elseif ($client) { 'foreign' } else { 'none' }`;
}

/**
 * Stop what a stale shared state names: its sandbox, client, relays and watchdog; then forget the state. Only wsb stop
 * stops the VM: with the client and server gone, the VM keeps running.
 */
function stopShared(dir: string): string {
  return `$state = Join-Path ${psString(dir)} 'sandbox.json'
try { $s = Get-Content -Raw -LiteralPath $state | ConvertFrom-Json } catch { $s = $null }
if ($s) {
  if ($s.id -match '^[0-9a-f-]{36}$') { & (Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps\\wsb.exe') stop --id $s.id *> $null }
  foreach ($id in @($s.relays.driver.pid, $s.relays.identity.pid, $s.relays.lease.pid, $s.relays.stream.pid, $s.watchdog.pid)) { if ($id -gt 0) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } }
  Get-Process WindowsSandboxRemoteSession -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge [DateTime]::Parse($s.startedAt).AddSeconds(-5) } | Stop-Process -Force
}
foreach ($name in 'sandbox.json', 'sandbox.wsb', 'config', 'out', 'agents') { Remove-Item -LiteralPath (Join-Path ${psString(dir)} $name) -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path (Join-Path ${psString(dir)} 'agents') | Out-Null
for ($i = 0; $i -lt 30 -and (Get-Process vmmemWindowsSandbox -ErrorAction SilentlyContinue); $i++) { Start-Sleep 1 }`;
}
