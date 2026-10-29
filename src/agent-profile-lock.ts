import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

/** Serialize our launches across processes and refuse a profile already used by a running browser. */
export async function lockAgentProfile(browser: "chrome" | "msedge" | "firefox", directory: string): Promise<ChildProcess> {
  const name = "Global\\PiComputerUseBrowser-" + createHash("sha256").update(directory.toLowerCase()).digest("hex");
  const script = `$m = [System.Threading.Mutex]::new($false, '${name}'); try { $acquired = $m.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }; if (-not $acquired) { [Console]::WriteLine('busy'); exit 2 }; [Console]::WriteLine('locked'); [Console]::ReadLine() | Out-Null; $m.ReleaseMutex(); $m.Dispose()`;
  const guard = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => finish(new Error("Could not acquire the agent profile lock.")), 15_000);
      const finish = (error?: Error) => { clearTimeout(timer); guard.stdout?.off("data", data); guard.off("error", failed); guard.off("exit", exited); error ? reject(error) : resolve(); };
      const data = (chunk: Buffer) => { output += chunk.toString(); if (output.includes("locked")) finish(); else if (output.includes("busy")) finish(new Error("The agent browser profile is already in use.")); };
      const failed = (error: Error) => finish(error);
      const exited = () => finish(new Error("Could not acquire the agent profile lock."));
      guard.stdout?.on("data", data); guard.once("error", failed); guard.once("exit", exited);
    });
    const escaped = directory.replace(/'/g, "''");
    const processName = browser + ".exe";
    const check = `$p = @(Get-CimInstance Win32_Process -ErrorAction Stop -Filter "Name='${processName}'"); if ($p | Where-Object { $null -eq $_.CommandLine }) { throw 'Cannot inspect browser process command lines' }; ConvertTo-Json -InputObject @($p | Where-Object { $_.CommandLine.IndexOf('${escaped}', [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -ExpandProperty ProcessId) -Compress`;
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", check], { windowsHide: true, timeout: 15_000 });
    const running = JSON.parse(stdout.trim() || "[]") as number[];
    if (running.length) throw new Error("The agent browser profile is already in use; the running browser was not changed.");
    return guard;
  } catch (error) {
    guard.stdin?.end("\n");
    throw error;
  }
}
