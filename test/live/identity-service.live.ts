import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { machineConfig } from "../../src/machine.ts";
import { connectRelay } from "../../src/relay-auth.ts";
import { localRunner, sshRunner } from "../../src/runner.ts";
import { runnerHost } from "../../src/sandbox.ts";
import { remoteIdentityPeer, WindowIdentity } from "../../src/window-identity.ts";

// Run explicitly on an already configured Windows target, under the shared project worker lock.
// No GUI or user window is touched: authorized protocol requests use HWND/PID zero.
test("the real PowerShell identity service rejects foreign clients and preserves its idle peer", async () => {
  const name = process.env.LIVE_MACHINE ?? "lab";
  const runner = name === "local" ? localRunner(process.env.WSL_INTEROP) : sshRunner((await machineConfig(process.cwd(), name)).ssh);
  const host = runnerHost(runner);
  const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
  const local = (await host.powershell("$env:LOCALAPPDATA")).trim();
  const windows = `${local}\\PiComputerUse\\identity-checks\\${randomUUID()}`;
  const dir = await host.path(windows, "unix");
  const auth = { session: "identity-live", key: randomBytes(32).toString("hex") };
  let pid: number | undefined;
  let tunnel: { port: number; close(): void } | undefined;
  let identity: WindowIdentity | undefined;
  const sockets: Socket[] = [];
  const sources = new URL("../../scripts/", import.meta.url);
  const children = async () => JSON.parse(await host.powershell(`ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${pid}" | Where-Object { $_.Name -eq 'powershell.exe' } | ForEach-Object { [int]$_.ProcessId }) -Compress`)) as number[];
  try {
    await host.mkdir(dir);
    for (const name of ["identity-auth.ps1", "identity-channel.ps1", "identity-channel.cs", "window-identity.ps1"])
      await host.writeFile(`${dir}/${name}`, await readFile(new URL(name, sources), "utf8"));
    await host.writeFile(`${dir}/relay-auth.ps1`, await readFile(new URL("session/relay-auth.ps1", sources), "utf8"));
    await host.writeFile(`${dir}/guest-identity-bridge.ps1`, await readFile(new URL("sandbox/guest-identity-bridge.ps1", sources), "utf8"));
    await host.writeFile(`${dir}/identity.json`, JSON.stringify(auth));
    const port = Number((await host.powershell("$l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $l.Start(); $port = $l.LocalEndpoint.Port; $l.Stop(); $port")).trim());
    pid = Number((await host.powershell(`(Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList ${quote(`-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${windows}\\guest-identity-bridge.ps1" -Address 127.0.0.1 -Port ${port} -Peer "${windows}\\window-identity.ps1" -Credentials "${windows}\\identity.json"`)}).Id`)).trim());
    expect(pid).toBeGreaterThan(0);
    tunnel = await host.forward(port);
    identity = new WindowIdentity(remoteIdentityPeer(tunnel.port, "127.0.0.1", auth));
    let ready = false;
    for (let i = 0; i < 20; i++) {
      try { await identity.identify({ window_id: 0, pid: 0 }, false); ready = true; break; }
      catch { await delay(250); }
    }
    expect(ready).toBe(true);
    const peers = await children(); expect(peers).toHaveLength(1);
    const idle = connect(tunnel.port, "127.0.0.1"); sockets.push(idle); idle.on("error", () => {}); idle.resume();
    await new Promise<void>((resolve, reject) => { idle.once("connect", resolve); idle.once("error", reject); });
    let idleClosed = false; idle.once("close", () => { idleClosed = true; });
    const peer = await connectRelay(tunnel.port, auth, { channel: "identity", role: "client" }); sockets.push(peer);
    expect(idleClosed).toBe(false);
    peer.end();
    for (const [credentials, context] of [
      [{ ...auth, key: "00".repeat(32) }, { channel: "identity", role: "client" }],
      [{ ...auth, session: "another-session" }, { channel: "identity", role: "client" }],
      [auth, { channel: "driver", role: "client" }],
      [auth, { channel: "identity", role: "session" }],
    ] as const) await expect(connectRelay(tunnel.port, credentials, context)).rejects.toBeInstanceOf(Error);
    // A foreign client need not verify the server's reply. Test server enforcement with a raw forged proof too.
    const foreign = connect(tunnel.port, "127.0.0.1"); sockets.push(foreign); foreign.on("error", () => {});
    let response = ""; foreign.on("data", chunk => { response += chunk.toString(); });
    const rejected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Unauthenticated connection stayed open")), 4500);
      foreign.once("close", () => { clearTimeout(timer); resolve(); });
    });
    foreign.once("connect", () => foreign.write(JSON.stringify({ version: 1, session: auth.session, channel: "identity", role: "client",
      nonce: "cd".repeat(32), proof: "00".repeat(32) }) + "\n" + JSON.stringify({ window_id: 0, pid: 0, create: false }) + "\n"));
    await rejected;
    expect(response).not.toContain('"proof"');
    expect(response).not.toContain('"identity"');
    await delay(4000);
    expect(await identity.identify({ window_id: 0, pid: 0 }, false)).toBeUndefined();
    expect(await children()).toEqual(peers);
    await identity.close();
    let remaining: number[] = [];
    for (let i = 0; i < 10; i++) { remaining = await children(); if (!remaining.length) break; await delay(250); }
    expect(remaining).toEqual([]);
  } finally {
    sockets.forEach(socket => socket.destroy());
    await identity?.close(); tunnel?.close();
    if (pid) {
      for (let i = 0; i < 10; i++) { if (!(await children()).length) break; await delay(250); }
      await host.powershell(`$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p -and $p.CommandLine.Contains(${quote(`${windows}\\guest-identity-bridge.ps1`)})) {
  Get-CimInstance Win32_Process -Filter "ParentProcessId = ${pid}" | Where-Object { $_.Name -eq 'powershell.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id ${pid} -Force
}`);
    }
    await host.remove(dir);
  }
}, 90_000);
