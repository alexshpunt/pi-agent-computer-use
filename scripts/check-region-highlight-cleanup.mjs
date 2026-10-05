import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

// Read-only cleanup evidence. Never terminate an app, driver or helper here.
const [hwnd, pid, directory] = process.argv.slice(2);
assert.match(hwnd ?? "", /^[1-9][0-9]*$/); assert.match(pid ?? "", /^[1-9][0-9]*$/);
assert.ok(directory?.startsWith(".tmp/region-highlights/"));
const script = String.raw`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
Add-Type 'using System; using System.Runtime.InteropServices; public class RegionCleanup { [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h); }';
@{OwnedWindowPresent=[RegionCleanup]::IsWindow([IntPtr]${hwnd});
OwnedBrowserPresent=(@(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Count -gt 0);
DriverCount=@(Get-Process -Name cua-driver -ErrorAction SilentlyContinue).Count;
HelperCount=@(Get-Process -Name pi-window-overlay -ErrorAction SilentlyContinue).Count;
Profiles=@(Get-ChildItem -LiteralPath "$env:LOCALAPPDATA\CuaDriver\BrowserProfiles" -ErrorAction SilentlyContinue).Count}|ConvertTo-Json -Compress`;
const result = JSON.parse(execFileSync("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
  ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  { timeout: 20000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
await mkdir(directory, { recursive: true });
await writeFile(`${directory}/cleanup.json`, JSON.stringify({ ...result, checkedAt: new Date().toISOString(), operation: "read_only" }, null, 2));
assert.equal(result.OwnedWindowPresent, false); assert.equal(result.OwnedBrowserPresent, false);
assert.equal(result.DriverCount, 0); assert.equal(result.HelperCount, 0); assert.equal(result.Profiles, 0);
console.log(JSON.stringify(result));
