import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const flag = value => value === -1 ? null : value === 1;
const unavailableFrame = (code, hresult = null) => ({ source: "dwm_extended_frame_bounds", status: "unavailable", bounds: null,
  error: { code, hresult } });
function measuredBounds([left, top, right, bottom], route) {
  assert.ok([left, top, right, bottom].every(value => value >= -2147483648 && value <= 2147483647) &&
    right > left && bottom > top, `Invalid native ${route} bounds.`);
  return { x: left, y: top, width: right - left, height: bottom - top, space: "windows_desktop_pixels", read_only: true, route,
    ...(route === "GetWindowRect" ? { includes_invisible_resize_borders: true } : {}) };
}
function validateTargets(targets) {
  assert.ok(Array.isArray(targets) && targets.length >= 1 && targets.length <= 2, "Use one or two exact fixture windows.");
  for (const target of targets) assert.ok(Number.isSafeInteger(target.pid) && target.pid > 0 && target.pid <= 2147483647 &&
    Number.isSafeInteger(target.window_id) && target.window_id > 0, "Invalid exact fixture target.");
  assert.equal(new Set(targets.map(target => `${target.pid}:${target.window_id}`)).size, targets.length, "Duplicate fixture target.");
}

/** Decode readonly Win32 measurements; the original fixture targets never authorize input.
 * Outer bounds retain GetWindowRect semantics. visible_frame names the independent DWM query and never falls back to outer bounds.
 */
export function parseNativeWindowState(stdout, targets) {
  validateTargets(targets);
  const rows = JSON.parse(stdout);
  assert.ok(Array.isArray(rows) && rows.length === targets.length + 1, "Invalid native window measurement count.");
  assert.ok(Array.isArray(rows[0]) && rows[0].length === 4 && rows[0].every(Number.isSafeInteger), "Invalid native desktop metadata.");
  const [foreground_window, x, y, window_at_pointer] = rows[0];
  assert.ok(foreground_window >= 0 && window_at_pointer >= 0, "Invalid native window handle.");
  const windows = targets.map((target, index) => {
    const row = rows[index + 1];
    // GetWindowRect and DWM visible-frame measurements are separate; neither substitutes for the other.
    assert.ok(Array.isArray(row) && row.length === 19 && row.every(Number.isSafeInteger), "Invalid native window row.");
    const [window_id, owner_pid, exists, minimized, visible, foreground, focus, maximized, left, top, right, bottom, dpi,
      dwmStatus, hresult, frameLeft, frameTop, frameRight, frameBottom] = row;
    const frame = [frameLeft, frameTop, frameRight, frameBottom];
    assert.equal(window_id, target.window_id, "Native row substituted another window.");
    assert.ok(owner_pid >= 0 && owner_pid <= 4294967295 && [0, 1].includes(exists), "Invalid native ownership measurement.");
    assert.ok([minimized, visible, foreground, focus, maximized].every(value => [-1, 0, 1].includes(value)), "Invalid native state flag.");
    let bounds = null, visible_frame = unavailableFrame("window_unavailable");
    if (exists) {
      assert.equal(owner_pid, target.pid, "Native owner differs from the fixture target.");
      assert.ok([minimized, visible, foreground, maximized].every(value => value !== -1), "Existing native state is incomplete.");
      assert.equal(foreground === 1, foreground_window === target.window_id, "Native foreground measurements disagree.");
      bounds = measuredBounds([left, top, right, bottom], "GetWindowRect");
      assert.ok(dpi > 0 && dpi <= 4294967295, "Invalid native window DPI.");
      assert.ok([-3, -2, 0, 1].includes(dwmStatus) && hresult >= -2147483648 && hresult <= 2147483647,
        "Invalid native DWM query status.");
      if (dwmStatus === 1) {
        assert.ok(hresult >= 0, "Failed DWM query cannot retain measured visible bounds.");
        visible_frame = { source: "dwm_extended_frame_bounds", status: "measured",
          bounds: measuredBounds(frame, "DwmGetWindowAttribute:DWMWA_EXTENDED_FRAME_BOUNDS"), error: null };
      } else {
        assert.ok(frame.every(value => value === 0), "Unavailable DWM query cannot retain visible geometry.");
        assert.ok(dwmStatus === 0 ? hresult < 0 : dwmStatus === -2 ? hresult === 0 : hresult >= 0,
          "Native DWM status contradicts its HRESULT.");
        visible_frame = unavailableFrame(dwmStatus === 0 ? "dwm_query_failed" : dwmStatus === -2 ? "dwm_api_unavailable" : "dwm_frame_unavailable",
          dwmStatus === -2 ? null : hresult);
      }
    } else {
      assert.ok([minimized, visible, foreground, focus, maximized].every(value => value === -1), "Invalid or reused window cannot retain measured state.");
      assert.ok([left, top, right, bottom, dpi, hresult, ...frame].every(value => value === 0) && dwmStatus === -1,
        "Invalid or reused window cannot retain bounds, DPI or a DWM query.");
    }
    return { ...target, owner_pid, exists: exists === 1, minimized: flag(minimized), visible: flag(visible),
      foreground_at_target: flag(foreground), keyboard_focus_at_target: flag(focus), maximized: flag(maximized),
      bounds, dpi: exists ? dpi : null, visible_frame };
  });
  return { status: "measured", measured_ms: Date.now(), foreground_window,
    pointer: { x, y, space: "windows_desktop_pixels", read_only: true }, window_at_pointer, windows };
}

/** Read exact ownership and state without activation, capture or input.
 * GetWindowRect outer bounds and DWM visible-frame bounds are independent physical-pixel samples, never input authority.
 * GetWindowRect may include invisible resize borders; target-window DPI is separate, not a coordinate scale.
 */
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
[DllImport("user32.dll")] static extern bool IsZoomed(IntPtr window);
[DllImport("user32.dll",SetLastError=true)] static extern bool GetWindowRect(IntPtr window,out RECT rect);
[DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
[DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window,uint attribute,out RECT rect,uint size);
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
long minimized=-1,visible=-1,atForeground=-1,focus=-1,maximized=-1,left=0,top=0,right=0,bottom=0,dpi=0;
long dwmStatus=-1,dwmHResult=0,dwmLeft=0,dwmTop=0,dwmRight=0,dwmBottom=0;bool exists=IsWindow(window)&&owner==pids[i];
if(exists){
minimized=IsIconic(window)?1:0;maximized=IsZoomed(window)?1:0;visible=IsWindowVisible(window)?1:0;atForeground=foreground==window?1:0;focus=measuredFocus?(gui.focus==window||IsChild(window,gui.focus)?1:0):-1;
RECT rect;bool measuredRect=GetWindowRect(window,out rect);int rectangleError=measuredRect?0:Marshal.GetLastWin32Error();uint measuredDpi=GetDpiForWindow(window);
RECT frameRect=new RECT();int frameResult=0;long frameStatus;
try{frameResult=DwmGetWindowAttribute(window,9,out frameRect,(uint)Marshal.SizeOf(typeof(RECT)));
frameStatus=frameResult<0?0:frameRect.right>frameRect.left&&frameRect.bottom>frameRect.top?1:-3;}
catch(DllNotFoundException){frameStatus=-2;}catch(EntryPointNotFoundException){frameStatus=-2;}
if(frameStatus!=1)frameRect=new RECT();
uint afterOwner;GetWindowThreadProcessId(window,out afterOwner);
if(!IsWindow(window)||afterOwner!=owner){exists=false;owner=afterOwner;minimized=visible=atForeground=focus=maximized=-1;}
else{if(!measuredRect)throw new Win32Exception(rectangleError);if(measuredDpi==0)throw new InvalidOperationException("GetDpiForWindow returned no measurement.");
left=rect.left;top=rect.top;right=rect.right;bottom=rect.bottom;dpi=measuredDpi;
dwmStatus=frameStatus;dwmHResult=frameResult;dwmLeft=frameRect.left;dwmTop=frameRect.top;dwmRight=frameRect.right;dwmBottom=frameRect.bottom;}
}
rows[i+1]=new long[]{handles[i],owner,exists?1:0,minimized,visible,atForeground,focus,maximized,left,top,right,bottom,dpi,dwmStatus,dwmHResult,dwmLeft,dwmTop,dwmRight,dwmBottom};
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
        owner_pid: null, exists: null, minimized: null, visible: null, foreground_at_target: null, keyboard_focus_at_target: null,
        maximized: null, bounds: null, dpi: null, visible_frame: unavailableFrame("native_metadata_unavailable") })) };
  }
}
