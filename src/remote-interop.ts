import { WINDOWS_POWERSHELL, type CommandRunner } from "./runner.ts";

// WTSConnectState (8) identifies whether the session that launched this process is active. Session 0 can
// itself be active, but it is the services session and never the user's interactive desktop.
const SESSION_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class InteropSessionProbe {
  [DllImport("wtsapi32.dll", SetLastError=true)] public static extern bool WTSQuerySessionInformation(IntPtr server, int session, int info, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr memory);
}
'@
$id = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
$buffer = [IntPtr]::Zero; $bytes = 0
if (-not [InteropSessionProbe]::WTSQuerySessionInformation([IntPtr]::Zero, $id, 8, [ref]$buffer, [ref]$bytes)) { throw 'WTSQuerySessionInformation failed' }
try { Write-Output ("{0}:{1}" -f $id, [Runtime.InteropServices.Marshal]::ReadInt32($buffer)) }
finally { [InteropSessionProbe]::WTSFreeMemory($buffer) }
`;

/** Select a socket attached to the one active interactive Windows session, never the WSL init service session. */
export async function selectRemoteInterop(runner: CommandRunner, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  // Paths are emitted only for sockets with WSL's numeric names; do not execute output as a command.
  const output = await runner.run("bash", ["-c", "for f in /run/WSL/[0-9]*_interop; do [ -S \"$f\" ] && printf '%s\\n' \"$f\"; done; true"],
    { signal, timeoutMs: 10_000 });
  const sockets = [...new Set(output.split(/\r?\n/).filter(path => /^\/run\/WSL\/\d+_interop$/.test(path)))];
  if (sockets.length > 64) throw new Error("Too many WSL interop sockets to identify the active Windows session safely.");
  const sessions = new Map<number, string>();
  // Limit parallel Windows startups while keeping discovery within the connection deadline.
  for (let offset = 0; offset < sockets.length; offset += 4) {
    const results = await Promise.all(sockets.slice(offset, offset + 4).map(async socket => {
      signal?.throwIfAborted();
      try {
        const response = await runner.run(WINDOWS_POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
          Buffer.from(SESSION_PROBE, "utf16le").toString("base64")], { env: { WSL_INTEROP: socket }, signal, timeoutMs: 5_000 });
        return { socket, match: /^(\d+):(\d+)\s*$/.exec(response.trim()) };
      } catch {
        signal?.throwIfAborted();
        return { socket, match: null };
      }
    }));
    for (const { socket, match } of results) {
      if (!match) continue;
      const id = Number(match[1]);
      if (id > 0 && match[2] === "0" && !sessions.has(id)) sessions.set(id, socket);
    }
  }
  if (sessions.size > 1) throw new Error("More than one active Windows session has a WSL interop socket. Select the intended session before connecting.");
  const socket = sessions.values().next().value;
  if (!socket) throw new Error("No WSL interop socket reaches an active Windows desktop session. Start a WSL terminal from the active desktop and try again.");
  return socket;
}
