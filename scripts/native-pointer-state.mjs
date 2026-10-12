import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Read-only foreground/pointer witness. Returned desktop coordinates must never become input targets. */
export async function nativePointerState(interop) {
  const script = String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';
Add-Type 'using System;using System.ComponentModel;using System.Runtime.InteropServices;
public class NativePointerMetadata {
[StructLayout(LayoutKind.Sequential)] public struct POINT {public int x,y;}
[DllImport("user32.dll",SetLastError=true)] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll",SetLastError=true)] static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
[DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flag);
public static long[] Read(){
if(!SetProcessDpiAwarenessContext(new IntPtr(-4)))throw new Win32Exception(Marshal.GetLastWin32Error());
POINT p;if(!GetCursorPos(out p))throw new Win32Exception(Marshal.GetLastWin32Error());
return new long[]{GetForegroundWindow().ToInt64(),p.x,p.y,GetAncestor(WindowFromPoint(p),2).ToInt64()};
}}';[NativePointerMetadata]::Read()|ConvertTo-Json -Compress`;
  try {
    const { stdout } = await execute("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { timeout: 10000, env: { ...process.env, WSL_INTEROP: interop ?? process.env.WSL_INTEROP } });
    const values = JSON.parse(stdout);
    assert.ok(Array.isArray(values) && values.length === 4 && values.every(Number.isSafeInteger), "Invalid native metadata");
    return { status: "measured", measured_ms: Date.now(), foreground_window: values[0],
      pointer: { x: values[1], y: values[2], space: "windows_desktop_pixels", read_only: true }, window_at_pointer: values[3] };
  } catch (error) { return { status: "unavailable", reason: String(error), foreground_window: null, pointer: null, window_at_pointer: null }; }
}
