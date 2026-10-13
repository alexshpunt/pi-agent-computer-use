import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const flag = value => value === -1 ? null : value === 1;
function validateTargets(targets) {
  assert.ok(Array.isArray(targets) && targets.length >= 1 && targets.length <= 2, "Use one or two exact fixture windows.");
  for (const target of targets) assert.ok(Number.isSafeInteger(target.pid) && target.pid > 0 && target.pid <= 2147483647 &&
    Number.isSafeInteger(target.window_id) && target.window_id > 0, "Invalid exact fixture target.");
  assert.equal(new Set(targets.map(target => `${target.pid}:${target.window_id}`)).size, targets.length, "Duplicate fixture target.");
}

/** Decode readonly Win32 measurements; the original fixture targets remain explicit and never authorize input. */
export function parseNativeWindowState(stdout, targets) {
  validateTargets(targets);
  const rows = JSON.parse(stdout);
  assert.ok(Array.isArray(rows) && rows.length === targets.length + 1, "Invalid native window measurement count.");
  assert.ok(Array.isArray(rows[0]) && rows[0].length === 4 && rows[0].every(Number.isSafeInteger), "Invalid native desktop metadata.");
  const [foreground_window, x, y, window_at_pointer] = rows[0];
  assert.ok(foreground_window >= 0 && window_at_pointer >= 0, "Invalid native window handle.");
  const windows = targets.map((target, index) => {
    const row = rows[index + 1];
    assert.ok(Array.isArray(row) && row.length === 7 && row.every(Number.isSafeInteger), "Invalid native window row.");
    const [window_id, owner_pid, exists, minimized, visible, foreground, focus] = row;
    assert.equal(window_id, target.window_id, "Native row substituted another window.");
    assert.ok(owner_pid >= 0 && owner_pid <= 4294967295 && [0, 1].includes(exists), "Invalid native ownership measurement.");
    assert.ok([minimized, visible, foreground, focus].every(value => [-1, 0, 1].includes(value)), "Invalid native state flag.");
    if (exists) {
      assert.equal(owner_pid, target.pid, "Native owner differs from the fixture target.");
      assert.ok([minimized, visible, foreground].every(value => value !== -1), "Existing native state is incomplete.");
      assert.equal(foreground === 1, foreground_window === target.window_id, "Native foreground measurements disagree.");
    } else assert.ok([minimized, visible, foreground, focus].every(value => value === -1), "Invalid or reused window cannot retain measured state.");
    return { ...target, owner_pid, exists: exists === 1, minimized: flag(minimized), visible: flag(visible),
      foreground_at_target: flag(foreground), keyboard_focus_at_target: flag(focus) };
  });
  return { status: "measured", measured_ms: Date.now(), foreground_window,
    pointer: { x, y, space: "windows_desktop_pixels", read_only: true }, window_at_pointer, windows };
}

/** Read exact ownership, minimized/visible state, foreground and focus without activation, capture or input. */
export async function nativeWindowState(interop, targets) {
  validateTargets(targets);
  const handles = targets.map(target => target.window_id).join(",");
  const pids = targets.map(target => target.pid).join(",");
  const script = String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';
Add-Type 'using System;using System.ComponentModel;using System.Runtime.InteropServices;
public class NativeWindowMetadata {
[StructLayout(LayoutKind.Sequential)] public struct POINT {public int x,y;}
[StructLayout(LayoutKind.Sequential)] public struct RECT {public int left,top,right,bottom;}
[StructLayout(LayoutKind.Sequential)] public struct GUI {public uint cbSize,flags;public IntPtr active,focus,capture,menuOwner,moveSize,caret;public RECT caretRect;}
[DllImport("user32.dll",SetLastError=true)] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll",SetLastError=true)] static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
[DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flag);
[DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
[DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
[DllImport("user32.dll")] static extern bool IsChild(IntPtr parent,IntPtr child);
[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
[DllImport("user32.dll",SetLastError=true)] static extern bool GetGUIThreadInfo(uint thread,out GUI gui);
public static long[][] Read(long[] handles,long[] pids){
if(!SetProcessDpiAwarenessContext(new IntPtr(-4)))throw new Win32Exception(Marshal.GetLastWin32Error());
POINT p;if(!GetCursorPos(out p))throw new Win32Exception(Marshal.GetLastWin32Error());
IntPtr foreground=GetForegroundWindow();GUI gui=new GUI();gui.cbSize=(uint)Marshal.SizeOf(typeof(GUI));bool measuredFocus=GetGUIThreadInfo(0,out gui);
long[][] rows=new long[handles.Length+1][];rows[0]=new long[]{foreground.ToInt64(),p.x,p.y,GetAncestor(WindowFromPoint(p),2).ToInt64()};
for(int i=0;i<handles.Length;i++){
IntPtr window=new IntPtr(handles[i]);uint owner;GetWindowThreadProcessId(window,out owner);
long minimized=-1,visible=-1,atForeground=-1,focus=-1;bool exists=IsWindow(window)&&owner==pids[i];
if(exists){minimized=IsIconic(window)?1:0;visible=IsWindowVisible(window)?1:0;atForeground=foreground==window?1:0;focus=measuredFocus?(gui.focus==window||IsChild(window,gui.focus)?1:0):-1;
uint afterOwner;GetWindowThreadProcessId(window,out afterOwner);if(!IsWindow(window)||afterOwner!=owner){exists=false;owner=afterOwner;minimized=visible=atForeground=focus=-1;}}
rows[i+1]=new long[]{handles[i],owner,exists?1:0,minimized,visible,atForeground,focus};
}return rows;
}}';$rows=[NativeWindowMetadata]::Read([long[]]@(${handles}),[long[]]@(${pids}));ConvertTo-Json -InputObject $rows -Compress -Depth 4`;
  try {
    const { stdout } = await execute("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { timeout: 10000, env: { ...process.env, WSL_INTEROP: interop ?? process.env.WSL_INTEROP } });
    return parseNativeWindowState(stdout, targets);
  } catch (error) {
    return { status: "unavailable", reason: String(error).slice(0, 4000), measured_ms: Date.now(),
      foreground_window: null, pointer: null, window_at_pointer: null, windows: targets.map(target => ({ ...target,
        owner_pid: null, exists: null, minimized: null, visible: null, foreground_at_target: null, keyboard_focus_at_target: null })) };
  }
}
