import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { loadComputerConfig } from "../src/config.ts";

// Read-only cleanup evidence for one disposable native input fixture; no termination or input.
const [hwnd, pid, directory] = process.argv.slice(2);
assert.match(hwnd ?? "", /^[1-9][0-9]*$/); assert.match(pid ?? "", /^[1-9][0-9]*$/);
assert.ok(directory?.startsWith(".tmp/cua-gestures/"));
const config = await loadComputerConfig(process.cwd());
const root = config.command.replace(/\/cua-driver-[^/]+\/cua-driver\.exe$/, "").replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
const script = String.raw`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CompleteCleanup { [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h); }';
@{OwnedWindowPresent=[CompleteCleanup]::IsWindow([IntPtr]${hwnd});
OwnedBrowserPresent=(@(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Count -gt 0);
DriverCount=@(Get-Process -Name cua-driver -ErrorAction SilentlyContinue).Count;
HelperCount=@(Get-Process -Name pi-window-overlay -ErrorAction SilentlyContinue).Count;
FixtureProfiles=@(Get-ChildItem -LiteralPath '${root.replaceAll("'", "''")}\.tmp' -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'cua-gestures-*' }).Count;
DriverProfiles=@(Get-ChildItem -LiteralPath "$env:LOCALAPPDATA\CuaDriver\BrowserProfiles" -ErrorAction SilentlyContinue).Count}|ConvertTo-Json -Compress`;
const result = JSON.parse(execFileSync("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
  ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  { timeout: 20000, encoding: "utf8", env: { ...process.env, WSL_INTEROP: config.interop ?? process.env.WSL_INTEROP } }));
await mkdir(directory, { recursive: true });
await writeFile(`${directory}/cleanup.json`, JSON.stringify({ ...result, operation: "read_only" }, null, 2));
assert.equal(result.OwnedWindowPresent, false); assert.equal(result.OwnedBrowserPresent, false);
for (const key of ["DriverCount", "HelperCount", "FixtureProfiles", "DriverProfiles"]) assert.equal(result[key], 0, key);
console.log(JSON.stringify(result));
