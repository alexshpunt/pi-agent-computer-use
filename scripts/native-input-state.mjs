import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Read Windows mouse buttons and optional virtual-key codes only; never send input. */
export function nativeInputState(keys = []) {
  if (!Array.isArray(keys) || keys.length > 8 || keys.some(key => !Number.isInteger(key) || key < 1 || key > 255))
    throw new Error("Pass at most eight valid Win32 virtual-key codes.");
  const script = String.raw`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class CuaButtonMetadata { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key); }';
$keys=@{}; foreach($key in @(${keys.join(",")})) { $keys[[string]$key]=(([int][CuaButtonMetadata]::GetAsyncKeyState($key) -band 32768) -ne 0) }
@{left_down=(([int][CuaButtonMetadata]::GetAsyncKeyState(1) -band 32768) -ne 0);right_down=(([int][CuaButtonMetadata]::GetAsyncKeyState(2) -band 32768) -ne 0);middle_down=(([int][CuaButtonMetadata]::GetAsyncKeyState(4) -band 32768) -ne 0);keys=$keys}|ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", timeout: 15000 }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  console.log(JSON.stringify(nativeInputState()));
