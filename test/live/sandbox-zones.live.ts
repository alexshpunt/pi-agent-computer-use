import { afterAll, expect, test } from "vitest";
import { computerSource } from "../../src/computer-address.ts";
import { requireComputerAddress } from "../../src/computer-resources.ts";
import { clickPlan } from "../../src/computer-tools.ts";
import { presentComputerResult } from "../../src/provider.ts";
import { connectLive, openWindow, text, WINDOWS_POWERSHELL_PATH } from "./remote.ts";

// LPT-1820: each agent in the shared Windows Sandbox works in its own zone of the guest screen. Four agents join one by
// one; their forms, an unowned popup, a message box, a native menu and a maximized form stay in their zones as the zones
// are laid out again; input outside a zone is refused; a fifth agent gets the machine's main desktop.
// Run on the sandbox's machine with LIVE_MACHINE=local. The guest scripts are copied in when the sandbox starts: stop a
// running shared sandbox first (wsb stop, or wait 10 minutes after its last agent).
const agents = await Promise.all(Array.from({ length: 5 }, () => connectLive()));
afterAll(async () => { await Promise.all(agents.map(agent => agent.close())); });
const run = Date.now();

interface Rect { x: number; y: number; width: number; height: number }
interface GuestWindow extends Rect { pid: number; className: string; title: string; zoomed: boolean }

/**
 * A DPI-unaware WinForms window that opens where Windows centres it, across zones: Popup shows an unowned form centred on
 * the screen, Box a message box, Max maximizes it, and Edit is a native menu. minWidth makes it wider than a quarter.
 */
function form(title: string, minWidth = 0): string[] {
  const script = `Add-Type -AssemblyName System.Windows.Forms
$f = New-Object Windows.Forms.Form; $f.Text = '${title}'; $f.Width = ${Math.max(420, minWidth)}; $f.Height = 330; $f.StartPosition = 'CenterScreen'
${minWidth ? `$f.MinimumSize = New-Object Drawing.Size(${minWidth}, 300)` : ""}
$state = @{ count = 0 }
$l = New-Object Windows.Forms.Label; $l.Left = 10; $l.Top = 230; $l.Width = 380; $l.Text = 'count:0'
$add = { param($text, $left, $top, $action) $b = New-Object Windows.Forms.Button; $b.Text = $text; $b.Left = $left; $b.Top = $top; $b.Width = 180; $b.Height = 60; $b.Add_Click($action); $f.Controls.Add($b) }
& $add 'Count' 10 20 { $state.count++; $l.Text = "count:$($state.count)" }
& $add 'Popup' 200 20 { $p = New-Object Windows.Forms.Form; $p.Text = '${title}-popup'; $p.StartPosition = 'CenterScreen'; $p.Width = 300; $p.Height = 200; $p.Show() }
& $add 'Max' 10 100 { $f.WindowState = 'Maximized' }
& $add 'Box' 200 100 { [void][Windows.Forms.MessageBox]::Show('box', '${title}-box') }
$menu = New-Object Windows.Forms.MainMenu; $edit = $menu.MenuItems.Add('&Edit'); [void]$edit.MenuItems.Add('&Mark', { })
$f.Menu = $menu; $f.Controls.Add($l); [void]$f.ShowDialog()`;
  return ["-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

/** The guest's visible top-level windows with their visible frames in physical pixels, read inside the guest. */
async function guestWindows(sandboxId: string): Promise<GuestWindow[]> {
  const probe = `Add-Type @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class PiZoneProbe {
  [StructLayout(LayoutKind.Sequential)] struct R { public int L, T, Rt, B; }
  delegate bool E(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(E e, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out R r, int s);
  public static List<string> Run() {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    List<string> list = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      R r; DwmGetWindowAttribute(h, 9, out r, 16);
      StringBuilder t = new StringBuilder(256), c = new StringBuilder(64); GetWindowText(h, t, 256); GetClassName(h, c, 64);
      uint p; GetWindowThreadProcessId(h, out p);
      list.Add(p + "\\t" + c + "\\t" + t.ToString().Replace("\\t", " ") + "\\t" + r.L + "\\t" + r.T + "\\t" + (r.Rt - r.L) + "\\t" + (r.B - r.T) + "\\t" + (IsZoomed(h) ? 1 : 0));
      return true; }, IntPtr.Zero);
    return list;
  }
}
'@
[PiZoneProbe]::Run() | Set-Content -Encoding UTF8 C:\\pi\\out\\zones-probe-${run}.txt`;
  const out = "(Join-Path $env:LOCALAPPDATA 'PiComputerUse\\sandboxes\\shared\\out')";
  const lines = await agents[0].powershell(`$out = ${out}
[IO.File]::WriteAllText((Join-Path $out 'zones-probe-${run}.ps1'), [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(probe).toString("base64")}')))
& (Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps\\wsb.exe') exec --id ${sandboxId} --run-as ExistingLogin -c 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\pi\\out\\zones-probe-${run}.ps1' *> $null
Get-Content -LiteralPath (Join-Path $out 'zones-probe-${run}.txt') -Encoding UTF8
Remove-Item -LiteralPath (Join-Path $out 'zones-probe-${run}.ps1'), (Join-Path $out 'zones-probe-${run}.txt') -ErrorAction SilentlyContinue`);
  return lines.split(/\r?\n/).filter(line => line.includes("\t")).map(line => {
    const [pid, className, title, x, y, width, height, zoomed] = line.replace(/^\uFEFF/, "").split("\t");
    return { pid: Number(pid), className, title, x: Number(x), y: Number(y), width: Number(width), height: Number(height), zoomed: zoomed === "1" };
  });
}

/** The zones of `count` agents, as the guest lays them out: whole, halves, quarters. */
function tiles(screen: Rect, count: number): Rect[] {
  const midX = screen.x + Math.floor(screen.width / 2), midY = screen.y + Math.floor(screen.height / 2);
  const r = (left: number, top: number, right: number, bottom: number) => ({ x: left, y: top, width: right - left, height: bottom - top });
  const right = screen.x + screen.width, bottom = screen.y + screen.height;
  if (count === 1) return [screen];
  if (count === 2) return [r(screen.x, screen.y, midX, bottom), r(midX, screen.y, right, bottom)];
  return [r(screen.x, screen.y, midX, midY), r(midX, screen.y, right, midY), r(screen.x, midY, midX, bottom), r(midX, midY, right, bottom)];
}
/** Inside the zone, give or take the 2 px the guest allows a DPI-unaware window that sizes in steps of its scale. */
const inside = (w: Rect, z: Rect) => w.x >= z.x - 2 && w.y >= z.y - 2 && w.x + w.width <= z.x + z.width + 2 && w.y + w.height <= z.y + z.height + 2;
const show = (w: GuestWindow) => `${w.className} '${w.title}' ${w.x},${w.y} ${w.width}x${w.height}${w.zoomed ? " zoomed" : ""}`;
const zoneOf = (result: { content: { type: string; text?: string }[] }) => {
  const match = /Screen zone: .*?, (\d+)x(\d+) at (-?\d+),(-?\d+) of (\d+)x(\d+)/.exec(text(result as never));
  if (!match) throw new Error(`No zone in: ${text(result as never)}`);
  const [width, height, x, y, screenWidth, screenHeight] = match.slice(1).map(Number);
  return { zone: { x, y, width, height }, screen: { x: 0, y: 0, width: screenWidth, height: screenHeight } };
};

/** Wait until every window of the process that shows `title` satisfies `check`; the hook moves windows within milliseconds. */
async function settle(sandboxId: string, title: string, check: (window: GuestWindow) => boolean, what: string): Promise<GuestWindow[]> {
  let last: GuestWindow[] = [];
  for (let i = 0; i < 10; i++) {
    const all = await guestWindows(sandboxId);
    const pid = all.find(window => window.title === title)?.pid;
    last = all.filter(window => window.pid === pid);
    if (pid && last.every(check)) return last;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${what}: ${last.map(show).join("; ") || `no ${title} window`}`);
}

test("each agent works in its own zone of the shared sandbox screen", async () => {
  const [a0, a1, a2, a3, a4] = agents;
  const open = async (live: (typeof agents)[number]) => {
    const result = await live.insert(live.machine, { action: "open_sandbox" });
    expect(result.details.status, text(result)).toBe("delivered");
    return result;
  };
  const sandboxOf = (result: Awaited<ReturnType<typeof open>>) => computerSource("sandbox", result.details.sandbox_ref!);
  const click = async (live: (typeof agents)[number], window: string, name: string) => {
    const view = await live.read(window, ["full"]);
    const element = (view.details.ui as { elements: { name?: string; role: string; bounds: { window_image?: Rect } }[] }).elements
      .find(e => e.name === name && (e.role === "Button" || e.role === "MenuItem"));
    if (!element?.bounds.window_image) throw new Error(`No ${name}: ${presentComputerResult(view)}`);
    const box = element.bounds.window_image;
    return live.resources.input(requireComputerAddress(window), live.cwd, clickPlan({ window, x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }));
  };

  // One agent: the whole screen, as large as the host's work area allows.
  const first = await open(a0);
  const id = /Sandbox id: (\S+)/.exec(text(first))![1];
  const { zone: whole, screen } = zoneOf(first);
  expect(whole).toEqual(screen);
  const host = (await a0.powershell("Add-Type -AssemblyName System.Windows.Forms; $w = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea; \"$($w.Width) $($w.Height)\"")).trim().split(" ").map(Number);
  console.log(`host work area ${host.join("x")}, guest work area ${screen.width}x${screen.height}`);
  expect(screen.width).toBeGreaterThanOrEqual(host[0] * 0.9);
  const t0 = `pz-0-${run}`;
  const f0 = await openWindow(a0, sandboxOf(first), WINDOWS_POWERSHELL_PATH, form(t0), t0);
  await settle(id, t0, w => inside(w, whole), "agent 0 in the whole screen");

  // Two agents: halves. Agent 0's form moves into the left half.
  const second = await open(a1);
  const halves = tiles(screen, 2);
  expect(zoneOf(second).zone).toEqual(halves[1]);
  expect(text(second)).toContain("the right half");
  await settle(id, t0, w => inside(w, halves[0]), "agent 0 moved into the left half");
  const t1 = `pz-1-${run}`;
  const f1 = await openWindow(a1, sandboxOf(second), WINDOWS_POWERSHELL_PATH, form(t1), t1);
  await settle(id, t1, w => inside(w, halves[1]), "agent 1's centred form in the right half");
  // An unowned form centred on the screen, and the native menu.
  expect((await click(a1, f1, "Popup")).details.status).toBe("delivered");
  await settle(id, t1, w => inside(w, halves[1]), "agent 1's popup in the right half");
  expect((await click(a1, f1, "Edit")).details.input_held).toBe("menu");
  const menus = await settle(id, t1, w => inside(w, halves[1]), "agent 1's menu in the right half");
  expect(menus.some(w => w.className === "#32768"), menus.map(show).join("; ")).toBe(true);
  const opened = await a1.read(f1, ["image"]);
  expect((await a1.insert(`computer:observation/${opened.details.observation_id}?delivery=foreground`, { action: "key", key: "Escape" })).details.status).toBe("delivered");
  // Maximize fills the zone instead of the screen.
  expect((await click(a1, f1, "Max")).details.status).toBe("delivered");
  await settle(id, t1, w => w.title !== t1 || (!w.zoomed && Math.abs(w.width - halves[1].width) <= 2 && Math.abs(w.height - halves[1].height) <= 2), "agent 1's maximized form fills the right half");
  expect((await click(a1, f1, "Box")).details.status).toBe("delivered");
  const boxed = await settle(id, t1, w => inside(w, halves[1]), "agent 1's message box in the right half");
  expect(boxed.map(w => w.title)).toContain(`${t1}-box`);

  // Agent 0 learns its new zone at its next action: here a Read, which says so.
  const relaid = await a0.read(f0, ["image"]);
  expect(text(relaid)).toContain("the left half");
  expect((await click(a0, f0, "Count")).details.status).toBe("delivered");
  const before = await a0.read(f0, ["image"]);

  // Four agents: quarters. Agent 3's form is wider than a quarter.
  const third = await open(a2), fourth = await open(a3);
  const quarters = tiles(screen, 4);
  expect(zoneOf(third).zone).toEqual(tiles(screen, 3)[2]);
  expect(zoneOf(fourth).zone).toEqual(quarters[3]);
  const t2 = `pz-2-${run}`, t3 = `pz-3-${run}`;
  await openWindow(a2, sandboxOf(third), WINDOWS_POWERSHELL_PATH, form(t2), t2);
  // Its minimum width in logical pixels exceeds the quarter's physical width at any scale of 100 % or more.
  const f3 = await openWindow(a3, sandboxOf(fourth), WINDOWS_POWERSHELL_PATH, form(t3, quarters[3].width + 50), t3);
  await settle(id, t0, w => inside(w, quarters[0]), "agent 0 in the top-left quarter");
  // Input on an observation from before the zones changed sends nothing and names the new zone.
  const stale = await a0.insert(`computer:observation/${before.details.observation_id}`, { action: "click", x: 20, y: 20 });
  expect(stale.details.status, text(stale)).toBe("refused");
  expect(text(stale)).toContain("the top-left quarter");
  // The form that was maximized fills its new zone.
  await settle(id, t1, w => inside(w, quarters[1]) && (w.title !== t1 || Math.abs(w.width - quarters[1].width) <= 2), "agent 1 in the top-right quarter");
  await settle(id, t2, w => inside(w, quarters[2]), "agent 2 in the bottom-left quarter");
  const wide = (await settle(id, t3, w => w.title !== t3 || (w.x === quarters[3].x && w.y >= quarters[3].y), "agent 3's wide form at the left of its quarter")).find(w => w.title === t3)!;
  expect(wide.width).toBeGreaterThan(quarters[3].width);

  // A click on the part of the wide form that sticks out of agent 3's zone is refused.
  const view = await a3.read(f3, ["image"]);
  const width = (view.details.state as { screenshot_width: number }).screenshot_width;
  const outside = await a3.resources.input(requireComputerAddress(f3), a3.cwd, clickPlan({ window: f3, x: width - 10, y: 100 }));
  expect(outside.details.status, text(outside)).toBe("refused");
  expect(text(outside)).toContain("outside this session's zone");

  // A fifth agent gets the machine's main desktop.
  const fifth = await a4.insert(a4.machine, { action: "open_sandbox" });
  expect(fifth.details.status, text(fifth)).toBe("delivered");
  expect(fifth.details.sandbox_ref).toBeUndefined();
  expect(text(fifth)).toMatch(/^Sandbox full: [\s\S]*main desktop instead: computer:machine\//);

  // Agent 2 leaves: agent 3 takes the bottom-left quarter, agent 0 keeps the top-left one.
  expect((await a2.insert(sandboxOf(third), { action: "close" })).details.status).toBe("closed");
  await settle(id, t3, w => w.title !== t3 || (w.x === quarters[2].x && w.y >= quarters[2].y), "agent 3 moved to the bottom-left quarter");
  expect((await click(a0, f0, "Count")).details.status).toBe("delivered");
}, 600_000);
