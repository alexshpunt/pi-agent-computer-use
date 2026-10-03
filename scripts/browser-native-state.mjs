import { execFile } from "node:child_process";

/** Read-only metadata for our marked profiles/workers. Never enumerates personal tab content or sends input. */
export async function browserNativeState() {
  const script = `
    $ErrorActionPreference='Stop'
    $rows=@(Get-CimInstance Win32_Process)
    $roots=@($rows | Where-Object { $_.Name -in @('chrome.exe','msedge.exe') -and $_.CommandLine -match '--user-data-dir=.*pi-visible-browser-' -and $_.CommandLine -notmatch '--type=' })
    $windows=@($roots | ForEach-Object { $p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; [pscustomobject]@{pid=$_.ProcessId;window_id=$p.MainWindowHandle.ToInt64().ToString();title=$p.MainWindowTitle;commandLine=$_.CommandLine} })
    $workers=@($rows | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'pi-agent-computer-use.*browser-worker.ts' })
    $profiles=@(Get-ChildItem -LiteralPath (Join-Path $env:TEMP '.tmp') -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^pi-visible-browser-[A-Za-z0-9]+$' } | ForEach-Object { $_.FullName })
    $pids=@($roots | ForEach-Object {$_.ProcessId})
    $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.OwningProcess -in $pids} | ForEach-Object {[pscustomobject]@{address=$_.LocalAddress;port=$_.LocalPort}})
    [pscustomobject]@{workerCount=$workers.Count;browserCount=$roots.Count;profiles=$profiles;windows=$windows;listeners=$listeners} | ConvertTo-Json -Compress -Depth 5
  `;
  const command = process.platform === "win32" ? "powershell.exe" : "/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe";
  return new Promise((resolve, reject) => {
    const child = execFile(command, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      {timeout:20_000,maxBuffer:200_000}, (error, stdout) => {
        if (error) reject(error);
        else { try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); } }
      });
    child.stdin.end();
  });
}
