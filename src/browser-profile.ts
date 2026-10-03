import { execFile } from "node:child_process";
import { lstat, rm } from "node:fs/promises";
import path from "node:path";
function run(command: string, args: string[], options: { timeout: number; maxBuffer?: number }): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, options, (error, stdout) => error ? reject(error) : resolve({ stdout }));
    child.stdin?.end();
  });
}

/** Clean an exact profile lease created by our worker, after that worker exits. Never accepts a personal profile. */
export async function cleanupBrowserProfile(profile: string): Promise<void> {
  if (!/^[A-Za-z]:\\/.test(profile) || path.win32.basename(path.win32.dirname(profile)) !== ".tmp" ||
    !/^pi-visible-browser-[A-Za-z0-9]+$/.test(path.win32.basename(profile)))
    throw new Error("Refusing cleanup outside an exact owned disposable profile lease.");
  const local = process.platform === "win32" ? profile : (await run("wslpath", ["-u", profile], { timeout: 5000 })).stdout.trim();
  let stat;
  try { stat = await lstat(local); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("Owned profile is not a regular directory; cleanup refused.");
  const literal = profile.replace(/'/g, "''");
  const script = `$ErrorActionPreference='Stop'; $profile='${literal}'; $owned=@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($profile,[StringComparison]::OrdinalIgnoreCase) -ge 0 }); $owned.Count`;
  const powershell = process.platform === "win32" ? "powershell.exe" : "/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe";
  const count = (await run(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { timeout: 15_000, maxBuffer: 100_000 })).stdout.trim();
  if (count !== "0") throw new Error("Owned browser may still be running; profile cleanup refused.");
  await rm(local, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
