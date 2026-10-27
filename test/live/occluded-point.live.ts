import { afterAll, expect, test } from "vitest";
import { requireComputerAddress } from "../../src/computer-resources.ts";
import { clickPlan, dragPlan, timelinePlan } from "../../src/computer-tools.ts";
import { presentComputerResult } from "../../src/provider.ts";
import { connectLive, openWindow, WINDOWS_POWERSHELL_PATH } from "./remote.ts";

// LPT-955: a real press goes to whatever window is on top at its point. A WinForms pad logs every press it gets. Its
// own dialog covers the pad's top-left part, and a topmost window of another process covers its bottom-right part.
// A press on either part is refused before anything is pressed and names the covering window; a press on the free
// part reaches the pad as before.
const live = await connectLive();
afterAll(async () => { await live.close(); });

// Both processes are DPI-unaware Windows PowerShell, so they place their windows in the same logical coordinates.
const place = `$a = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea; $x = $a.Left + [int]($a.Width / 2) - 210; $y = $a.Top + [int]($a.Height / 2) - 150`;
function script(body: string): string[] {
  return ["-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(`Add-Type -AssemblyName System.Windows.Forms\n${place}\n${body}`, "utf16le").toString("base64")];
}
function padForm(title: string): string[] {
  return script(`$f = New-Object Windows.Forms.Form; $f.Text = '${title}'; $f.StartPosition = 'Manual'; $f.Left = $x; $f.Top = $y; $f.Width = 420; $f.Height = 300
$p = New-Object Windows.Forms.Panel; $p.Left = 10; $p.Top = 10; $p.Width = 380; $p.Height = 160; $p.BackColor = 'LightSteelBlue'; $p.AccessibleName = 'Pad'
$l = New-Object Windows.Forms.Label; $l.Left = 10; $l.Top = 190; $l.Width = 380; $l.Text = 'log:'
$p.Add_MouseDown({ param($s, $e) $l.Text += ' ' + $e.Button.ToString().Substring(0, 1) + $e.Clicks })
$d = New-Object Windows.Forms.Form; $d.Text = '${title} dialog'; $d.StartPosition = 'Manual'; $d.Left = $x + 20; $d.Top = $y + 40; $d.Width = 150; $d.Height = 110
$d.ShowInTaskbar = $false; $d.MinimizeBox = $false; $d.MaximizeBox = $false
$f.Add_Shown({ $d.Show($f) })
$f.Controls.AddRange(@($p, $l)); [void]$f.ShowDialog()`);
}
function coverForm(title: string): string[] {
  return script(`$c = New-Object Windows.Forms.Form; $c.Text = '${title}'; $c.StartPosition = 'Manual'; $c.Left = $x + 260; $c.Top = $y + 110; $c.Width = 150; $c.Height = 100
$c.TopMost = $true; $c.ShowInTaskbar = $false; [void]$c.ShowDialog()`);
}

test("a press on a point that another window covers is refused and names that window", async () => {
  const title = `pi-occluded-${Date.now()}`;
  const window = await openWindow(live, live.machine, WINDOWS_POWERSHELL_PATH, padForm(title), `regex:^${title}$`);
  const cover = await openWindow(live, live.machine, WINDOWS_POWERSHELL_PATH, coverForm(`${title} cover`), `regex:^${title} cover$`);
  try {
    const full = await live.read(window, ["full"]);
    type Element = { role: string; name?: string; bounds: { window_image?: { x: number; y: number; width: number; height: number } } };
    const box = (full.details.ui as { elements: Element[] }).elements.find(item => item.name === "Pad")!.bounds.window_image!;
    // Points of the pad by its own layout: the dialog covers pad x 2..152, y 0..109; the cover pad x 242..392, y 69..169.
    const at = (x: number, y: number) => ({ x: Math.round(box.x + box.width * x / 380), y: Math.round(box.y + box.height * y / 160) });
    const free = at(200, 30), underDialog = at(60, 50), underCover = at(320, 130);
    const log = async () => /log:[^\n|]*/.exec(presentComputerResult(await live.read(window, ["ui"])))![0].trim();
    const act = async (plan: ReturnType<typeof clickPlan>) => {
      const result = await live.resources.input(requireComputerAddress(window), live.cwd, plan);
      const body = presentComputerResult(result);
      console.log(`${result.details.status}\n${body.split("\n").slice(0, 3).join("\n")}`);
      return { status: result.details.status, body };
    };

    expect((await act(clickPlan({ window, ...free }))).status).toBe("delivered");
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(await log()).toBe("log: L1");

    const dialog = await act(clickPlan({ window, ...underDialog }));
    expect(dialog.status).toBe("refused");
    expect(dialog.body).toContain(`Nothing was pressed: "${title} dialog" (computer:`);
    expect(dialog.body).toContain("a window this window owns, covers the point. It stays in front of this window even when this window is active.");

    const other = await act(clickPlan({ window, ...underCover }));
    expect(other.status).toBe("refused");
    expect(other.body).toContain(`Nothing was pressed: a window of another app, "${title} cover" (computer:`);

    const drag = await act(dragPlan({ window, from: underDialog, to: free }));
    expect(drag.status).toBe("refused");
    expect(drag.body).toContain(`"${title} dialog"`);

    const timeline = await act(timelinePlan({ window, events: [{ at_ms: 0, type: "move", ...underCover }, { at_ms: 50, type: "button_down" }, { at_ms: 100, type: "button_up" }] }));
    expect(timeline.status).toBe("refused");
    expect(timeline.body).toContain(`"${title} cover"`);

    // Only the first click reached the pad.
    expect(await log()).toBe("log: L1");
  } finally {
    // Force-close refuses windows the session found by title rather than opened; both processes are this check's own.
    for (const opened of [cover, window]) {
      const { pid } = (await live.read(opened, ["state"])).details.target as { pid: number };
      await live.kill(pid);
    }
  }
});
