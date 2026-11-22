import { writeFile } from "node:fs/promises";
import { afterAll, expect, test } from "vitest";
import { computerSource } from "../../src/computer-address.ts";
import { WINDOWS_POWERSHELL } from "../../src/runner.ts";
import { at, connectLive, openWindow, text, WINDOWS_POWERSHELL_PATH } from "./remote.ts";

// LPT-1700, LPT-1702: the session tile host on the desktop layer. Isolated sessions with animated windows start the
// host on their machine; the check reads where its window sits among Progman's children, its cost, that every window
// gets a live tile on its layer, and that the host leaves when the last session closes. TILES_SESSIONS and
// TILES_WINDOWS (per session) set the load, TILES_LARGE=1 makes every window large (1000x700) instead of a mix of
// sizes, TILES_SECONDS sets the cost window, TILES_HOLD keeps the sessions open that many seconds for a look at the
// desktop, TILES_REPORT names a file for the JSON report, and TILES_SHOT a Windows folder for a screenshot of the
// desktop per layer.
const live = await connectLive();
const SESSIONS = Number(process.env.TILES_SESSIONS ?? 3), PER_SESSION = Number(process.env.TILES_WINDOWS ?? 2);
const SECONDS = Number(process.env.TILES_SECONDS ?? 20), HOLD = Number(process.env.TILES_HOLD ?? 0);
/** Window sizes that fit the sessions' 1024x768 desktops: apps, dialogs and tools. */
const SIZES = process.env.TILES_LARGE === "1" ? [[1000, 700]] : [[1000, 700], [480, 320], [800, 600], [640, 480], [900, 650], [400, 500], [720, 540]];
const opened: string[] = [], refs: string[] = [];
afterAll(async () => { for (const session of opened) await live.insert(session, { action: "close" }).catch(() => undefined); await live.close(); });

/** A window that repaints about 60 times a second: a counter and a sliding bar. */
const ticker = (title: string, [width, height]: number[]) => ["-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(`Add-Type -AssemblyName System.Windows.Forms
$f = New-Object Windows.Forms.Form; $f.Text = '${title}'; $f.Width = ${width}; $f.Height = ${height}
$l = New-Object Windows.Forms.Label; $l.Left = 10; $l.Top = 10; $l.Width = ${width - 40}; $l.Height = 60; $l.Font = New-Object Drawing.Font('Consolas', 28)
$p = New-Object Windows.Forms.Panel; $p.Top = 120; $p.Width = 60; $p.Height = 60; $p.BackColor = 'OrangeRed'
$f.Controls.AddRange(@($l, $p)); $w = [Diagnostics.Stopwatch]::StartNew()
$t = New-Object Windows.Forms.Timer; $t.Interval = 15
$t.Add_Tick({ $ms = $w.ElapsedMilliseconds; $l.Text = "$ms ms"; $p.Left = [int](($ms / 4) % ${width - 80}) })
$t.Start(); [void]$f.ShowDialog()`, "utf16le").toString("base64")];

const powershell = (script: string) => live.runner.run(WINDOWS_POWERSHELL, ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { input: "" });

/** Progman's children front to back, as "class|pid". */
async function desktopLayer(): Promise<{ className: string; pid: number }[]> {
  const out = await powershell(`Add-Type @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class PiTilesLive {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  public static string Children() {
    var list = new List<string>();
    for (var h = GetWindow(FindWindow("Progman", null), 5); h != IntPtr.Zero; h = GetWindow(h, 2)) {
      var s = new StringBuilder(256); GetClassName(h, s, 256); uint pid; GetWindowThreadProcessId(h, out pid); list.Add(s + "|" + pid);
    }
    return string.Join("\\n", list);
  }
}
'@
[PiTilesLive]::Children()`);
  return out.trim().split("\n").filter(Boolean).map(line => { const [className, pid] = line.trim().split("|"); return { className, pid: Number(pid) }; });
}

/** The tile host and its WebView2 processes: CPU seconds and working set. */
async function hostProcesses(): Promise<{ host?: { pid: number; session: number }; cpu: number; memoryMb: number; count: number }> {
  const out = await powershell(`$all = Get-CimInstance Win32_Process
$host_ = $all | Where-Object Name -eq 'pi-tile-host.exe' | Select-Object -First 1
if (-not $host_) { '{}'; return }
$ids = @($host_.ProcessId); do { $more = @($all | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId } | ForEach-Object ProcessId); $ids += $more } while ($more.Count)
$tree = @($all | Where-Object { $ids -contains $_.ProcessId })
@{ pid = $host_.ProcessId; session = $host_.SessionId; cpu = (($tree | Measure-Object -Sum KernelModeTime).Sum + ($tree | Measure-Object -Sum UserModeTime).Sum) / 1e7; memory = ($tree | Measure-Object -Sum WorkingSetSize).Sum / 1MB; count = $tree.Count } | ConvertTo-Json -Compress`);
  const parsed = JSON.parse(out.trim() || "{}");
  return parsed.pid ? { host: { pid: parsed.pid, session: parsed.session }, cpu: parsed.cpu, memoryMb: Math.round(parsed.memory), count: parsed.count } : { cpu: 0, memoryMb: 0, count: 0 };
}

const until = async <T>(check: () => Promise<T | undefined>, what: string, seconds = 120): Promise<T> => {
  for (let i = 0; i < seconds; i++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 1000)); }
  throw new Error(`Timed out waiting for ${what}.`);
};

test("isolated sessions show as live tiles on the desktop layer, and the host leaves with the last session", { timeout: 900_000 + HOLD * 1000 }, async () => {
  for (let s = 0; s < SESSIONS; s++) {
    const result = await live.insert(live.machine, { action: "open_session" });
    expect(result.details.status, text(result)).toBe("delivered");
    const session = computerSource("sandbox", result.details.sandbox_ref!);
    opened.push(session);
    refs.push(result.details.sandbox_ref!);
    for (let w = 0; w < PER_SESSION; w++) await openWindow(live, session, WINDOWS_POWERSHELL_PATH, ticker(`Ticker ${s}-${w}`, SIZES[(s * PER_SESSION + w) % SIZES.length]), `Ticker ${s}-${w}`);
  }
  const host = await until(async () => (await hostProcesses()).host, "the tile host", 300);
  // The session's description names its tiles once the host runs.
  await until(async () => /Live tiles on the human's desktop: shown/.test(live.resources.descriptor(at(opened[0]))) || undefined, "the session to report its tiles", 60);

  // The host's window sits in Progman right under the icon view.
  const layer = await desktopLayer();
  const icons = layer.findIndex(window => window.className === "SHELLDLL_DefView");
  expect(icons, JSON.stringify(layer)).toBeGreaterThanOrEqual(0);
  expect(layer[icons + 1], JSON.stringify(layer)).toEqual({ className: expect.stringMatching(/^WindowsForms10/), pid: host.pid });

  // Cost while the human's windows cover the desktop (the tiles pause), then with every window minimized, when all
  // tiles show and animate. The windows come back afterwards.
  const measure = async () => {
    const before = await hostProcesses();
    const started = performance.now();
    await new Promise(resolve => setTimeout(resolve, SECONDS * 1000));
    const after = await hostProcesses();
    return { cpuPercentOfCore: +(((after.cpu - before.cpu) / ((performance.now() - started) / 1000)) * 100).toFixed(1), memoryMb: after.memoryMb, processes: after.count };
  };
  // This host's part of the log.
  const hostLog = async () => {
    const lines = (await powershell(`Get-Content -LiteralPath "$env:LOCALAPPDATA\\PiComputerUse\\tile-host\\host.log"`)).split(/\r?\n/);
    const start = lines.findLastIndex(line => line.includes(`start pid ${host.pid},`));
    if (start < 0) throw new Error(`host.log has no start line for pid ${host.pid}`);
    return lines.slice(start);
  };
  // The layer hotkey as the human presses it: WM_HOTKEY with the next layer's id to the host's message window.
  const nextLayer = () => powershell(`Add-Type @'
using System; using System.Runtime.InteropServices;
public static class PiTilesKeys {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
'@
[void][PiTilesKeys]::PostMessage([PiTilesKeys]::FindWindow([NullString]::Value, 'Pi session tile host'), 0x312, [IntPtr]2, [IntPtr]::Zero)`);
  const screenshot = (name: string) => process.env.TILES_SHOT ? powershell(`Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' -Name Dpi -Namespace PiTiles
[void][PiTiles.Dpi]::SetProcessDPIAware()
$b = [Windows.Forms.Screen]::PrimaryScreen.Bounds; $bitmap = New-Object Drawing.Bitmap $b.Width, $b.Height
$g = [Drawing.Graphics]::FromImage($bitmap); $g.CopyFromScreen($b.Location, [Drawing.Point]::Empty, $b.Size)
New-Item -ItemType Directory -Force -Path '${process.env.TILES_SHOT}' | Out-Null
$bitmap.Save('${process.env.TILES_SHOT}\\${name}.png'); $g.Dispose(); $bitmap.Dispose()`) : Promise.resolve("");
  const covered = await measure();
  const desktopWasCovered = (await hostLog()).filter(line => /desktop (covered|visible)/.test(line)).at(-1)?.includes("covered") ?? false;
  await powershell("(New-Object -ComObject Shell.Application).MinimizeAll()");
  let shown, tiles: string[], layout: string | undefined, layers = 1;
  try {
    // Streams restart with keyframes when the tiles show again; measure once they run steadily.
    await new Promise(resolve => setTimeout(resolve, 15_000));
    shown = await measure();
    // The page logs each layout: how many tiles on how many layers, and each layer's smallest scale.
    layout = (await hostLog()).findLast(line => line.includes("page: layout: "));
    layers = Number(/in (\d+) layer/.exec(layout ?? "")?.[1] ?? 1);
    await screenshot(`${SESSIONS * PER_SESSION}-layer-1`);
    // Every further layer streams once the hotkey shows it.
    for (let next = 2; next <= layers; next++) {
      await nextLayer();
      await new Promise(resolve => setTimeout(resolve, 10_000));
      await screenshot(`${SESSIONS * PER_SESSION}-layer-${next}`);
    }
    if (layers > 1) await nextLayer();
    await new Promise(resolve => setTimeout(resolve, 1000));
    // The page reports each tile's first decoded frame to the host log.
    tiles = (await hostLog()).filter(line => line.includes("page: live ") && refs.some(ref => line.includes(ref)) && line.includes("Ticker"));
  } finally { await powershell("(New-Object -ComObject Shell.Application).UndoMinimizeALL()"); }
  const steps = (await hostLog()).filter(line => /page: layer \d+ of \d+/.test(line)).map(line => line.slice(line.indexOf("page: ") + 6));
  const report = { sessions: SESSIONS, windows: SESSIONS * PER_SESSION, host, layer, cost: { covered, desktopWasCovered, shown }, layout, steps, liveTiles: tiles.length };
  console.log(JSON.stringify(report));
  if (process.env.TILES_REPORT) await writeFile(process.env.TILES_REPORT, JSON.stringify(report, null, 1));
  if (HOLD) await new Promise(resolve => setTimeout(resolve, HOLD * 1000));
  // Every window is on a layer, every layer keeps its tiles readable, and the hotkey walks through all layers and back.
  expect(layout).toContain(`layout: ${SESSIONS * PER_SESSION} tiles in ${layers} layer`);
  for (const [, size, percent] of (layout ?? "").matchAll(/(\d+) at (\d+) %/g)) if (Number(size) > 1) expect(Number(percent)).toBeGreaterThanOrEqual(45);
  expect(steps).toEqual(layers > 1 ? [...Array.from({ length: layers - 1 }, (_, i) => `layer ${i + 2} of ${layers}`), `layer 1 of ${layers}`] : []);
  // Every animated window decoded into its tile; a covered desktop costs close to nothing.
  expect(new Set(tiles.map(line => line.slice(line.indexOf("page: live ")))).size).toBeGreaterThanOrEqual(SESSIONS * PER_SESSION);
  if (desktopWasCovered) expect(covered.cpuPercentOfCore).toBeLessThan(2);

  // The host leaves when no session is left, and takes its window with it.
  for (const session of opened.splice(0)) await live.insert(session, { action: "close" });
  await until(async () => !(await hostProcesses()).host || undefined, "the tile host to exit", 90);
  expect((await desktopLayer()).some(window => window.pid === host.pid)).toBe(false);
});
