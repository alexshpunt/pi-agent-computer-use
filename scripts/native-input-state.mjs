import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Read Windows mouse-button metadata only. No capture, input, app launch, or process termination. */
export function nativeInputState() {
  const script = String.raw`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class CuaButtonMetadata { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key); }';
@{left_down=(([int][CuaButtonMetadata]::GetAsyncKeyState(1) -band 32768) -ne 0);right_down=(([int][CuaButtonMetadata]::GetAsyncKeyState(2) -band 32768) -ne 0);middle_down=(([int][CuaButtonMetadata]::GetAsyncKeyState(4) -band 32768) -ne 0)}|ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", timeout: 15000 }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  console.log(JSON.stringify(nativeInputState()));
