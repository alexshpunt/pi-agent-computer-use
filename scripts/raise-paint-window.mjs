import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

/** Read focus or raise only the exact live paint-probe window without activation. */
export function inspectPaintWindow(target, { raise = false } = {}) {
  assert.ok(Number.isSafeInteger(target.pid) && target.pid > 0);
  assert.ok(Number.isSafeInteger(target.window_id) && target.window_id > 0);
  const script = `$ErrorActionPreference="Stop"; $ProgressPreference="SilentlyContinue";
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PaintWindow {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct GUI {
    public uint cbSize, flags;
    public IntPtr active, focus, capture, menuOwner, moveSize, caret;
    public RECT caretRect;
  }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetGUIThreadInfo(uint thread, ref GUI info);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
}
'@;
$window=[IntPtr]${target.window_id}; [uint32]$owner=0;
[void][PaintWindow]::GetWindowThreadProcessId($window,[ref]$owner);
$title=New-Object System.Text.StringBuilder 256;
[void][PaintWindow]::GetWindowText($window,$title,$title.Capacity);
if (-not [PaintWindow]::IsWindow($window) -or $owner -ne ${target.pid} -or -not $title.ToString().StartsWith("Pi CUA paint probe")) { throw "Exact owned paint-probe identity refused" }
if ([PaintWindow]::IsIconic($window)) { throw "Paint-probe window must not be minimized" }
function Snapshot {
  $gui=New-Object PaintWindow+GUI; $gui.cbSize=[Runtime.InteropServices.Marshal]::SizeOf($gui);
  $guiRead=[PaintWindow]::GetGUIThreadInfo(0,[ref]$gui);
  $foreground=[PaintWindow]::GetForegroundWindow(); [uint32]$foregroundOwner=0; [uint32]$focusOwner=0;
  [void][PaintWindow]::GetWindowThreadProcessId($foreground,[ref]$foregroundOwner);
  [void][PaintWindow]::GetWindowThreadProcessId($gui.focus,[ref]$focusOwner);
  $foregroundProcess=Get-Process -Id $foregroundOwner -ErrorAction SilentlyContinue;
  $focusProcess=Get-Process -Id $focusOwner -ErrorAction SilentlyContinue;
  $rect=New-Object PaintWindow+RECT; $rectRead=[PaintWindow]::GetWindowRect($window,[ref]$rect);
  $rank=0; $previous=[PaintWindow]::GetWindow($window,3);
  while ($previous -ne [IntPtr]::Zero -and $rank -lt 10000) { $rank++; $previous=[PaintWindow]::GetWindow($previous,3) }
  [pscustomobject]@{time_ms=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); foreground_hwnd=$foreground.ToInt64(); foreground_pid=$foregroundOwner; foreground_process=$foregroundProcess.ProcessName; keyboard_focus_pid=$focusOwner; keyboard_focus_process=$focusProcess.ProcessName; gui_read=$guiRead; active_hwnd=$gui.active.ToInt64(); keyboard_focus_hwnd=$gui.focus.ToInt64(); target_z_rank=$rank; rect_read=$rectRead; bounds=@{left=$rect.left;top=$rect.top;right=$rect.right;bottom=$rect.bottom}}
}
$before=Snapshot; $raised=$false; $errorCode=0;
${raise ? `if ($before.foreground_hwnd -eq 0 -or $before.foreground_hwnd -eq $window.ToInt64()) { throw "Expected another foreground window before the no-activation control" }
$raised=[PaintWindow]::SetWindowPos($window,[IntPtr]::Zero,0,0,0,0,0x0013);
if (-not $raised) { $errorCode=[Runtime.InteropServices.Marshal]::GetLastWin32Error() }` : ""}
$after=Snapshot;
[pscustomobject]@{target_pid=$owner;target_hwnd=$window.ToInt64();operation="${raise ? "HWND_TOP|SWP_NOACTIVATE|SWP_NOMOVE|SWP_NOSIZE" : "read_only"}";raised=$raised;win32_error=$errorCode;before=$before;after=$after}|ConvertTo-Json -Depth 6 -Compress;
`;
  const result = execFileSync("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", timeout: 30_000 });
  return JSON.parse(result.replace(/^\uFEFF/, "").trim());
}
