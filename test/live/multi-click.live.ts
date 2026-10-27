import { afterAll, expect, test } from "vitest";
import { requireComputerAddress } from "../../src/computer-resources.ts";
import { clickPlan } from "../../src/computer-tools.ts";
import { deleteComputer, presentComputerResult } from "../../src/provider.ts";
import { connectLive, openWindow, WINDOWS_POWERSHELL_PATH } from "./remote.ts";

// LPT-948: triple clicks and right or middle double clicks reach a native window as real clicks. A WinForms pad logs
// every press it gets as its button and Windows' click count, so a double click shows as "R1 R2": Windows made the
// second press a double click because it came within the system double-click time and distance. Windows counts no
// further, so a triple click is "L1 L2 L1"; apps that select a line on a triple click time the third press themselves.
const live = await connectLive();
afterAll(async () => { await live.close(); });

function padForm(title: string): string[] {
  const script = `Add-Type -AssemblyName System.Windows.Forms
$f = New-Object Windows.Forms.Form; $f.Text = '${title}'; $f.Width = 420; $f.Height = 300
# Open at the middle of the screen, away from the top-left corner where other windows of the desktop often sit and
# would cover the pad: a click on a covered point lands on the covering window.
$a = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea; $f.StartPosition = 'Manual'; $f.Left = $a.Left + $a.Width / 2; $f.Top = $a.Top + $a.Height / 2
$p = New-Object Windows.Forms.Panel; $p.Left = 10; $p.Top = 10; $p.Width = 380; $p.Height = 160; $p.BackColor = 'LightSteelBlue'; $p.AccessibleName = 'Pad'
$l = New-Object Windows.Forms.Label; $l.Left = 10; $l.Top = 190; $l.Width = 380; $l.Text = 'log:'
$p.Add_MouseDown({ param($s, $e) $l.Text += ' ' + $e.Button.ToString().Substring(0, 1) + $e.Clicks })
$f.Controls.AddRange(@($p, $l)); [void]$f.ShowDialog()`;
  return ["-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

test("a triple click and right or middle double and triple clicks arrive as one multi-click each", async () => {
  const title = `pi-multi-click-${Date.now()}`;
  const window = await openWindow(live, live.machine, WINDOWS_POWERSHELL_PATH, padForm(title), title);
  try {
    const full = await live.read(window, ["full"]);
    type Element = { hint: string; role: string; name?: string; bounds: { window_image?: { x: number; y: number; width: number; height: number } } };
    const elements = (full.details.ui as { elements: Element[] }).elements;
    const pad = elements.find(item => item.name === "Pad")!;
    const box = pad.bounds.window_image!;
    const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    const log = async () => /log:[^\n|]*/.exec(presentComputerResult(await live.read(window, ["ui"])))![0].trim();
    let expected = "log:";
    const click = async (plan: Parameters<typeof clickPlan>[0], presses: string) => {
      const result = await live.resources.input(requireComputerAddress(window), live.cwd, clickPlan(plan));
      const body = presentComputerResult(result);
      console.log(`${JSON.stringify({ ...plan, window: undefined })}: ${result.details.status}\n${body}`);
      expect(result.details.status, body).toBe("delivered");
      expected += ` ${presses}`;
      // The label repaints after the presses; give the form a moment before reading it.
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(await log()).toBe(expected);
    };
    await click({ window, ...point, count: 3 }, "L1 L2 L1");
    await click({ window, ...point, button: "right", count: 2 }, "R1 R2");
    await click({ window, ...point, button: "middle", count: 2 }, "M1 M2");
    await click({ window, ...point, button: "middle", count: 3 }, "M1 M2 M1");
    await click({ window, ...point, button: "right", count: 3 }, "R1 R2 R1");
    // A ref of the latest Read: no UI Automation pattern carries a multi-click, so it goes straight to the real pointer.
    const ref = /^([0-9a-z]+:[a-z]+) \| Pane \| Pad/m.exec(presentComputerResult(await live.read(window, ["ui"])))![1];
    await click({ window, target: ref, count: 3 }, "L1 L2 L1");
  } finally {
    await deleteComputer(live.resources, `${window}?force=true`, { path: `${window}?force=true` }, live.cwd);
  }
});
