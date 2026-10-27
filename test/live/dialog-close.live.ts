import { afterAll, expect, test } from "vitest";
import { requireComputerAddress } from "../../src/computer-resources.ts";
import { clickPlan, pressPlan } from "../../src/computer-tools.ts";
import { presentComputerResult } from "../../src/provider.ts";
import { addresses, connectLive, openWindow, WINDOWS_POWERSHELL_PATH } from "./remote.ts";

// LPT-954: OK in a dialog closes the dialog, and Windows hands the foreground to the app's main window. The click is
// delivered and its receipt names the main window as the one now in front; Escape on the dialog is delivered too.
const live = await connectLive();
afterAll(async () => { await live.close(); });

function mainForm(title: string): string[] {
  const script = `Add-Type -AssemblyName System.Windows.Forms
$a = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$f = New-Object Windows.Forms.Form; $f.Text = '${title}'; $f.StartPosition = 'Manual'; $f.Left = $a.Left + [int]($a.Width / 2) - 210; $f.Top = $a.Top + [int]($a.Height / 2) - 150; $f.Width = 420; $f.Height = 300
$o = New-Object Windows.Forms.Button; $o.Text = 'Open'; $o.Left = 10; $o.Top = 10; $o.Width = 120
$l = New-Object Windows.Forms.Label; $l.Left = 10; $l.Top = 60; $l.Width = 380; $l.Text = 'result:'
$o.Add_Click({
  $d = New-Object Windows.Forms.Form; $d.Text = '${title} dialog'; $d.StartPosition = 'CenterParent'; $d.Width = 260; $d.Height = 160
  $d.MinimizeBox = $false; $d.MaximizeBox = $false; $d.ShowInTaskbar = $false
  $ok = New-Object Windows.Forms.Button; $ok.Text = 'OK'; $ok.Left = 20; $ok.Top = 60; $ok.DialogResult = 'OK'
  $cancel = New-Object Windows.Forms.Button; $cancel.Text = 'Cancel'; $cancel.Left = 120; $cancel.Top = 60; $cancel.DialogResult = 'Cancel'
  $d.AcceptButton = $ok; $d.CancelButton = $cancel; $d.Controls.AddRange(@($ok, $cancel))
  $l.Text += ' ' + $d.ShowDialog($f)
})
$f.Controls.AddRange(@($o, $l)); [void]$f.ShowDialog()`;
  return ["-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

type Element = { role: string; name?: string; bounds: { window_image?: { x: number; y: number; width: number; height: number } } };
async function centre(window: string, name: string) {
  const full = await live.read(window, ["full"]);
  const box = (full.details.ui as { elements: Element[] }).elements.find(item => item.role === "Button" && item.name === name)!.bounds.window_image!;
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

test("a click on OK that closes a dialog is delivered and names the window now in front", async () => {
  const title = `pi-dialog-${Date.now()}`;
  const window = await openWindow(live, live.machine, WINDOWS_POWERSHELL_PATH, mainForm(title), `regex:^${title}$`);
  const act = async (path: string, plan: ReturnType<typeof clickPlan>) => {
    const result = await live.resources.input(requireComputerAddress(path), live.cwd, plan);
    const body = presentComputerResult(result);
    console.log(`${result.details.status}\n${body}`);
    return { status: result.details.status, body };
  };
  const dialog = async () => {
    for (let i = 0; i < 20; i++) {
      const found = addresses(await live.search(live.windows, `regex:^${title} dialog$`), "window")[0];
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error("The dialog did not open.");
  };
  const result = async () => /result:[^\n|]*/.exec(presentComputerResult(await live.read(window, ["ui"])))![0].trim();
  try {
    // Right after an app starts, Windows can still be handing the foreground back to the window that had it, and the
    // first click's dialog then loses the foreground to that window (an honest unknown). Let the start settle first.
    await new Promise(resolve => setTimeout(resolve, 1500));
    // The Open button shows a modal dialog from its click handler, so it gets the real pointer.
    expect((await act(window, clickPlan({ window, ...await centre(window, "Open") }))).status).toBe("delivered");
    const first = await dialog();
    const ok = await act(first, clickPlan({ window: first, ...await centre(first, "OK") }));
    expect(ok.status, ok.body).toBe("delivered");
    // The driver names the window in front when the dialog was already gone at its check after the click; otherwise
    // the change list finds the dialog gone and names the app's frontmost window.
    expect(ok.body).toMatch(new RegExp(`(The click closed this window; |the app's frontmost window is )"${title}" \\(computer:`));
    expect(await result()).toBe("result: OK");

    expect((await act(window, clickPlan({ window, ...await centre(window, "Open") }))).status).toBe("delivered");
    const second = await dialog();
    await live.read(second, []);
    expect((await act(second, pressPlan({ window: second, key: "Escape" }))).status).toBe("delivered");
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(await result()).toBe("result: OK Cancel");
  } finally {
    // Force-close refuses windows the session found by title rather than opened; the process is this check's own.
    const { pid } = (await live.read(window, ["state"])).details.target as { pid: number };
    await live.kill(pid);
  }
});
