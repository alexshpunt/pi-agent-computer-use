import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ComputerRequestError } from "./computer-resources.ts";
import type { GuestEndpoint } from "./config.ts";
import type { SandboxHost } from "./sandbox.ts";

const SCRIPTS = new URL("../scripts/session/", import.meta.url);
const SANDBOX_SCRIPTS = new URL("../scripts/sandbox/", import.meta.url);
const IDENTITY_SCRIPT = new URL("../scripts/window-identity.ps1", import.meta.url);
/** The session lives until it is closed; MXC still needs a process timeout for its exec. */
const EXEC_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const NETWORK = { egress: { default: "allow" }, ingress: { default: "allow", hostLoopback: "allow" } };

const psString = (value: string) => `'${value.replace(/'/g, "''")}'`;
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(new Error("Cancelled while starting the isolated session.")); };
  signal?.addEventListener("abort", abort, { once: true });
});

/**
 * An isolated Windows agent session from Microsoft Execution Containers (MXC `isolation_session`): a fresh agent user
 * with its own session, desktop, clipboard and input on the same machine, removed again on close. Several can run at
 * once, unlike Windows Sandbox. A CUA driver runs inside; the host reaches it through a reverse relay because the
 * session can dial the host's loopback but not the other way round. Needs `wxc-exec.exe` from scripts/install-mxc.sh.
 */
export class IsolatedSession {
  readonly ref = "is-" + randomUUID().slice(0, 8);
  endpoint?: GuestEndpoint;
  private id?: string;
  private user?: string;
  private wxc?: string;
  private workdir?: { windows: string; unix: string };
  private pids: number[] = [];
  private tunnels: { port: number; close(): void }[] = [];
  private closed = false;

  private constructor(private readonly host: SandboxHost) {}

  /** Provision and start a session with a running driver; on any failure everything started is removed again. */
  static async open(host: SandboxHost, runtimeCommand: string, signal?: AbortSignal): Promise<IsolatedSession> {
    const session = new IsolatedSession(host);
    try { await session.start(runtimeCommand, signal); }
    catch (error) { await session.close(); throw error; }
    return session;
  }

  private ps(script: string, signal?: AbortSignal, timeoutMs?: number) { return this.host.powershell(script, signal, timeoutMs); }

  /** Run one lifecycle phase through wxc-exec and return its parsed JSON result. */
  private async phase(operation: "provision" | "start" | "stop" | "deprovision", config: Record<string, unknown>, signal?: AbortSignal) {
    const { windows, unix } = this.workdir!;
    await this.host.writeFile(`${unix}/${operation}.json`, JSON.stringify(config));
    const out = await this.ps(`& ${psString(this.wxc!)} --operation ${operation} ${this.id ? `--container-id ${psString(this.id)} ` : ""}${psString(`${windows}\\${operation}.json`)} 2>&1 | Out-String`, signal, 120_000);
    const json = out.slice(out.indexOf("{"));
    let parsed: { result?: Record<string, unknown>; error?: { code?: string; message?: string } };
    try { parsed = JSON.parse(json); } catch { throw new Error(`wxc-exec ${operation} returned no JSON: ${out.trim().slice(0, 300)}`); }
    if (parsed.error) throw new Error(`wxc-exec ${operation} failed (${parsed.error.code}): ${parsed.error.message}`);
    return parsed.result ?? {};
  }

  private async start(runtimeCommand: string, signal?: AbortSignal): Promise<void> {
    const runtime = await this.host.path(path.dirname(runtimeCommand), "windows");
    if (!/^[A-Za-z]:\\/.test(runtime)) throw new ComputerRequestError("The driver runtime must be on a Windows drive to copy it into the session.");
    const local = (await this.ps("$env:LOCALAPPDATA", signal)).trim();
    this.wxc = `${local}\\PiComputerUse\\mxc\\wxc-exec.exe`;
    if ((await this.ps(`Test-Path -LiteralPath ${psString(this.wxc)}`, signal)).trim() !== "True")
      throw new ComputerRequestError(`MXC is not installed on this machine (${this.wxc}). Run scripts/install-mxc.sh for it, then open the session again.`);
    const windows = `${local}\\PiComputerUse\\sessions\\${this.ref}`;
    this.workdir = { windows, unix: await this.host.path(`${local}\\PiComputerUse\\sessions`, "unix").then(parent => `${parent}/${this.ref}`) };
    await this.host.mkdir(this.workdir.unix);

    let provisioned;
    try { provisioned = await this.phase("provision", { version: "1.0.0", containment: "isolation_session", network: NETWORK }, signal); }
    catch (error) { throw new ComputerRequestError(`Windows refused an isolated session: ${error instanceof Error ? error.message : error}. It needs Windows 11 24H2/25H2 build 9550 or later.`); }
    this.id = String(provisioned.sandboxId);
    const metadata = provisioned.metadata as { agentUserName?: string; ephemeralWorkspacePath?: string };
    this.user = metadata.agentUserName;
    const workspace = String(metadata.ephemeralWorkspacePath);
    const shared = await this.host.path(workspace, "unix");

    // The agent user can read only its own workspace: the runtime and scripts go there.
    await this.ps(`Copy-Item -Recurse -Force -LiteralPath ${psString(runtime)} -Destination ${psString(`${workspace}\\runtime`)}`, signal, 120_000);
    await this.host.writeFile(`${shared}/session-start.ps1`, await readFile(new URL("session-start.ps1", SCRIPTS), "utf8"));
    await this.host.writeFile(`${shared}/guest-identity-bridge.ps1`, await readFile(new URL("guest-identity-bridge.ps1", SANDBOX_SCRIPTS), "utf8"));
    await this.host.writeFile(`${shared}/window-identity.ps1`, await readFile(IDENTITY_SCRIPT, "utf8"));
    await this.host.writeFile(`${this.workdir.unix}/host-reverse.ps1`, await readFile(new URL("host-reverse.ps1", SCRIPTS), "utf8"));

    // No stdio redirection: it would inherit the interop pipes and keep this call waiting.
    await this.ps(`Start-Process powershell.exe -WindowStyle Hidden -ArgumentList ${psString(`-NoProfile -ExecutionPolicy Bypass -File "${windows}\\host-reverse.ps1" -Channels 2 -PortFile "${windows}\\ports.txt"`)}`, signal);
    let ports: number[] = [];
    for (let i = 0; i < 40 && ports.length !== 5; i++) {
      ports = (await this.host.readFile(`${this.workdir.unix}/ports.txt`)).trim().split(/\s+/).filter(Boolean).map(Number);
      if (ports.length !== 5) await sleep(250, signal);
    }
    if (ports.length !== 5) throw new Error("The host relay for the isolated session did not start.");
    const [driverClient, driverSession, identityClient, identitySession, relayPid] = ports;
    this.pids.push(relayPid);

    const token = randomBytes(32).toString("hex");
    await this.host.writeFile(`${shared}/session.json`, JSON.stringify({ token, hostDriverPort: driverSession, hostIdentityPort: identitySession }));
    await this.phase("start", { version: "1.0.0" }, signal);
    const exec = { version: "1.0.0", process: { commandLine: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${workspace}\\session-start.ps1" -Workspace "${workspace}"`, timeout: EXEC_TIMEOUT_MS } };
    await this.host.writeFile(`${this.workdir.unix}/exec.json`, JSON.stringify(exec));
    const pid = Number((await this.ps(`(Start-Process -FilePath ${psString(this.wxc)} -WindowStyle Hidden -PassThru -ArgumentList ${psString(`--operation exec --container-id ${this.id} "${windows}\\exec.json"`)}).Id`, signal)).trim());
    if (pid > 0) this.pids.push(pid);

    this.tunnels = [await this.host.forward(driverClient, signal), await this.host.forward(identityClient, signal)];
    this.endpoint = { url: `http://127.0.0.1:${this.tunnels[0].port}/mcp`, token, identityPort: this.tunnels[1].port, domain: "windows-session" };
  }

  /** Stop the session, remove its agent user and workspace, and stop the host relay. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const tunnel of this.tunnels) tunnel.close();
    this.tunnels = [];
    // Stop ends every process in the session; deprovision then removes the agent user and its workspace.
    if (this.id) for (const operation of ["stop", "deprovision"] as const)
      await this.phase(operation, { version: "1.0.0" }).catch(() => undefined);
    if (this.pids.length) await this.ps(`Stop-Process -Id ${this.pids.join(",")} -Force -ErrorAction SilentlyContinue`).catch(() => undefined);
    if (this.workdir) await this.host.remove(this.workdir.unix).catch(() => undefined);
  }

  /** Readable description for the session's address. */
  describe(source: string): string {
    return [`# Isolated Windows session`, `Address: ${source}`, `Agent user: ${this.user ?? "unknown"}`,
      "A separate Windows session for the agent on this machine (MXC isolation_session): its own desktop, clipboard and input, invisible to the human. Several can run at once.",
      "Search this address for its windows. Insert {\"action\":\"open\",\"app\":\"...\"} to start an app in it, or {\"action\":\"close\"} to remove it."].join("\n");
  }
}
