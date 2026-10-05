import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

// Recover only explicitly recorded profiles from interrupted owned overlay probes, never personal profiles.
const receipts = process.argv.slice(2);
assert.ok(receipts.length);
const owned = [];
for (const path of receipts) {
  assert.match(path, /^\.tmp\/qt-overlay\/interrupted-profile-[0-9]+\.json$/);
  const receipt = JSON.parse(await readFile(path, "utf8"));
  assert.match(receipt.profile, /^isolated-[0-9a-f-]{36}$/);
  assert.ok(Number.isSafeInteger(receipt.created_ms));
  assert.ok(Number.isSafeInteger(receipt.run_ms));
  if (receipt.window_id !== null) {
    assert.ok(Number.isSafeInteger(receipt.window_id) && receipt.window_id > 0);
    const source = JSON.parse(await readFile(`.tmp/qt-overlay/native-${receipt.run_ms}/source-metadata.json`, "utf8"));
    assert.equal(source.target.window_id, receipt.window_id);
  } else {
    // Early probes predate identity receipts; retain their actual capture as run provenance.
    await readFile(`.tmp/qt-overlay/native-${receipt.run_ms}/overview.png`);
  }
  assert.ok(Math.abs(receipt.created_ms - receipt.run_ms) < 10000);
  owned.push(receipt);
}
const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
Add-Type 'using System; using System.Runtime.InteropServices; public class InterruptedFrameSource { [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h); }';
if (@(Get-Process cua-driver,pi-window-overlay -ErrorAction SilentlyContinue).Count -ne 0) { throw 'Owned runtimes must be closed first.' }
if (@(Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like 'Pi Qt observation frame check*' }).Count -ne 0) { throw 'Owned fixture browser still exists.' }
${owned.map(r => `${r.window_id === null ? "" : `if ([InterruptedFrameSource]::IsWindow([IntPtr]${r.window_id})) { throw 'Source window still exists.' }`}
$p=Join-Path "$env:LOCALAPPDATA\\CuaDriver\\BrowserProfiles" '${r.profile}';
if (Test-Path -LiteralPath $p) {
$f=Get-Item -LiteralPath $p;
if ([Math]::Abs(([DateTimeOffset]$f.CreationTimeUtc).ToUnixTimeMilliseconds()-${r.created_ms}) -gt 100) { throw 'Profile identity changed.' }
Remove-Item -LiteralPath $p -Recurse -Force;
}`).join("\n")}
@{removed_owned_profiles=${owned.length}; operation='owned_runtime_cleanup'}|ConvertTo-Json -Compress`;
console.log(execFileSync("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
  ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 20000 }).trim());
