import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

function validateTarget(target) {
  assert.ok(Number.isSafeInteger(target?.pid) && target.pid > 0 && target.pid <= 2147483647 &&
    Number.isSafeInteger(target.window_id) && target.window_id > 0, "Invalid exact fixture target.");
}
function bounds(values) {
  const [left, top, right, bottom] = values;
  assert.ok(values.every(value => value >= -2147483648 && value <= 2147483647) && right > left && bottom > top,
    "Invalid native bounds.");
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Decode an independent readonly viewport witness for one task-owned HWND.
 * Physical client rectangles never authorize input or prove which CDP tab is selected.
 */
export function parseNativeBrowserViewport(stdout, target) {
  validateTarget(target);
  const rows = JSON.parse(stdout);
  assert.ok(Array.isArray(rows) && rows.length >= 1 && rows.length <= 1025, "Invalid native viewport row count.");
  const root = rows[0];
  assert.ok(Array.isArray(root) && root.length === 10 && root.every(Number.isSafeInteger), "Invalid native root row.");
  const [window, owner, exists, minimized, left, top, right, bottom, visited, complete] = root;
  assert.equal(window, target.window_id, "Native root substituted another window.");
  assert.equal(owner, target.pid, "Native root owner changed.");
  assert.equal(exists, 1, "Native root no longer exists.");
  assert.ok([0, 1].includes(minimized) && [0, 1].includes(complete) && visited >= 0 && visited <= 1025,
    "Invalid native scan metadata.");
  const outer = bounds([left, top, right, bottom]);
  const candidates = rows.slice(1).map(row => {
    assert.ok(Array.isArray(row) && row.length === 6 && row.every(Number.isSafeInteger), "Invalid native candidate row.");
    const [window_id, measured, ...rectangle] = row;
    assert.ok(window_id > 0 && [0, 1].includes(measured), "Invalid native candidate identity.");
    if (!measured) {
      assert.ok(rectangle.every(value => value === 0), "An unavailable candidate cannot retain geometry.");
      return { window_id, bounds: null };
    }
    const measuredBounds = bounds(rectangle);
    assert.ok(measuredBounds.x >= outer.x && measuredBounds.y >= outer.y &&
      measuredBounds.x + measuredBounds.width <= outer.x + outer.width &&
      measuredBounds.y + measuredBounds.height <= outer.y + outer.height, "Native viewport lies outside its exact root.");
    return { window_id, bounds: measuredBounds };
  });
  assert.equal(new Set(candidates.map(candidate => candidate.window_id)).size, candidates.length, "Duplicate native candidate.");
  assert.ok(candidates.length <= visited, "Native scan counts contradict its candidates.");
  const status = minimized || !complete || candidates.some(candidate => !candidate.bounds) ? "unavailable"
    : candidates.length === 1 ? "measured" : "ambiguous";
  return { status, measured_ms: Date.now(), target: { ...target }, minimized: !!minimized, bounds: outer,
    viewport: status === "measured" ? candidates[0].bounds : null, candidates, visited, complete: !!complete,
    source: "win32_render_widget_client", coordinate_space: "windows_desktop_pixels", read_only: true };
}

/** Measure only descendants of an explicit task-owned browser window, with no capture/input/activation. */
export async function nativeBrowserViewport(interop, target) {
  validateTarget(target);
  const script = String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';
Add-Type 'using System;using System.Collections.Generic;using System.ComponentModel;using System.Runtime.InteropServices;using System.Text;
public class NativeBrowserViewport {
[StructLayout(LayoutKind.Sequential)] public struct RECT {public int left,top,right,bottom;}
[StructLayout(LayoutKind.Sequential)] public struct POINT {public int x,y;}
[DllImport("user32.dll",SetLastError=true)] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
[DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
[DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
[DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flag);
[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
[DllImport("user32.dll",SetLastError=true)] static extern bool GetWindowRect(IntPtr window,out RECT rect);
[DllImport("user32.dll",SetLastError=true)] static extern bool GetClientRect(IntPtr window,out RECT rect);
[DllImport("user32.dll",SetLastError=true)] static extern bool ClientToScreen(IntPtr window,ref POINT point);
[DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder name,int capacity);
delegate bool Callback(IntPtr window,IntPtr state);
[DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr root,Callback callback,IntPtr state);
static bool Same(RECT a,RECT b){return a.left==b.left&&a.top==b.top&&a.right==b.right&&a.bottom==b.bottom;}
public static long[][] Read(long handle,long expectedPid){
if(!SetProcessDpiAwarenessContext(new IntPtr(-4)))throw new Win32Exception(Marshal.GetLastWin32Error());
IntPtr root=new IntPtr(handle);uint owner;GetWindowThreadProcessId(root,out owner);
if(!IsWindow(root)||owner!=expectedPid)throw new InvalidOperationException("Exact owned root unavailable");
RECT before;if(!GetWindowRect(root,out before))throw new Win32Exception(Marshal.GetLastWin32Error());
long visited=0;bool complete=true;var rows=new List<long[]>();rows.Add(new long[10]);
Callback callback=delegate(IntPtr child,IntPtr unused){
visited++;if(visited>1024){complete=false;return false;}
if(GetAncestor(child,2)!=root){complete=false;return false;}if(!IsWindowVisible(child))return true;
var name=new StringBuilder(128);int length=GetClassName(child,name,128);
if(length<=0){rows.Add(new long[]{child.ToInt64(),0,0,0,0,0});return true;}
if(name.ToString()!="Chrome_RenderWidgetHostHWND")return true;
RECT rect;POINT origin=new POINT();bool measured=GetClientRect(child,out rect)&&rect.right>rect.left&&rect.bottom>rect.top;
if(measured){origin.x=rect.left;origin.y=rect.top;measured=ClientToScreen(child,ref origin);}
rows.Add(measured?new long[]{child.ToInt64(),1,origin.x,origin.y,(long)origin.x+rect.right-rect.left,(long)origin.y+rect.bottom-rect.top}:new long[]{child.ToInt64(),0,0,0,0,0});return true;};
EnumChildWindows(root,callback,IntPtr.Zero);
RECT after;uint afterOwner;GetWindowThreadProcessId(root,out afterOwner);
if(!IsWindow(root)||afterOwner!=owner||!GetWindowRect(root,out after)||!Same(before,after))throw new InvalidOperationException("Exact owned root changed during measurement");
rows[0]=new long[]{handle,owner,1,IsIconic(root)?1:0,before.left,before.top,before.right,before.bottom,visited,complete?1:0};return rows.ToArray();
}}';$rows=[NativeBrowserViewport]::Read(${target.window_id},${target.pid});ConvertTo-Json -InputObject $rows -Compress -Depth 4`;
  try {
    const { stdout } = await promisify(execFile)("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { timeout: 10000, maxBuffer: 128000, env: { ...process.env, WSL_INTEROP: interop ?? process.env.WSL_INTEROP } });
    return parseNativeBrowserViewport(stdout, target);
  } catch (error) {
    return { status: "unavailable", measured_ms: Date.now(), target: { ...target }, viewport: null,
      read_only: true, reason: String(error).slice(0, 4000) };
  }
}
