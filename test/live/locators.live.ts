import { afterAll, expect, test } from "vitest";
import { connectLive, openWindow, serveFixture, text, WINDOWS_POWERSHELL_PATH } from "./remote.ts";
import { presentComputerResult } from "../../src/provider.ts";

// LPT-911: native windows take Playwright locators. Every step is one call on the window address, without a prior Read.
const live = await connectLive();
const fixture = await serveFixture(live.runner);
const title = `Locators ${Date.now()}`;
// Closing the session leaves app windows open; end the form this check started, found by its unique title.
afterAll(async () => {
  await live.powershell(`Get-Process powershell | Where-Object { $_.MainWindowTitle -eq '${title}' } | Stop-Process -Force`).catch(() => "");
  await live.close(); fixture.close();
});
const form = `Add-Type -AssemblyName System.Windows.Forms
$f = New-Object Windows.Forms.Form; $f.Text = '${title}'; $f.Width = 520; $f.Height = 420
$b = New-Object Windows.Forms.Button; $b.Text = 'Count 0'; $b.Left = 10; $b.Top = 10; $b.Width = 120; $script:n = 0
$b.Add_Click({ $script:n++; $b.Text = "Count $script:n" })
$d = New-Object Windows.Forms.Button; $d.Text = 'Later'; $d.Left = 140; $d.Top = 10; $d.Enabled = $false
$t = New-Object Windows.Forms.TextBox; $t.Left = 10; $t.Top = 50; $t.Width = 300; $t.AccessibleName = 'Name'
$c = New-Object Windows.Forms.CheckBox; $c.Text = 'Agree'; $c.Left = 10; $c.Top = 85
$l = New-Object Windows.Forms.ListBox; $l.Left = 10; $l.Top = 120; $l.Height = 70; [void]$l.Items.AddRange(@('alpha','beta','gamma')); $l.AccessibleName = 'Pick'
$tm = New-Object Windows.Forms.Timer; $tm.Interval = 1500; $tm.Add_Tick({ $d.Enabled = $true; $tm.Stop() })
$f.Add_Shown({ $tm.Start() })
$s = New-Object Windows.Forms.Label; $s.Left = 10; $s.Top = 200; $s.Width = 300; $s.Text = 'idle'
$b.Add_Click({ $s.Text = "clicked $script:n" })
$m = New-Object Windows.Forms.MenuStrip; $file = New-Object Windows.Forms.ToolStripMenuItem('File'); $reset = New-Object Windows.Forms.ToolStripMenuItem('Reset')
$reset.Add_Click({ $script:n = 0; $b.Text = 'Count 0'; $s.Text = 'reset' }); [void]$file.DropDownItems.Add($reset); [void]$m.Items.Add($file); $f.MainMenuStrip = $m
foreach ($x in @($b, $d, $t, $c, $l, $s)) { $x.Top += 30 }
$f.Controls.AddRange(@($b, $d, $t, $c, $l, $s, $m)); [void]$f.ShowDialog()`;

test("a WinForms window is driven by Playwright locators, one call per step", async () => {
  const window = await openWindow(live, live.machine, WINDOWS_POWERSHELL_PATH,
    ["-NoProfile", "-EncodedCommand", Buffer.from(form, "utf16le").toString("base64")], title);
  const timings: string[] = [];
  const step = async (command: Record<string, unknown>) => {
    const started = performance.now();
    const result = await live.insert(window, command);
    timings.push(`${command.action} ${Math.round(performance.now() - started)} ms`);
    return result;
  };
  const expectStatus = async (command: Record<string, unknown>, status: string, message?: RegExp) => {
    const result = await step(command);
    expect(result.details.status, presentComputerResult(result)).toBe(status);
    if (message) expect(presentComputerResult(result)).toMatch(message);
  };

  // Auto-wait: Later is disabled for 1.5 s; the click waits for it instead of failing.
  // Later has no click handler, so its change list says nothing changed (LPT-914).
  await expectStatus({ action: "click", target: `getByRole("button", { name: "Later" })`, timeout_ms: 5000 }, "delivered", /Nothing changed in the UI within \d+ ms after the action/);
  // Every action reports what it changed: the renamed button and the status text, without a Read.
  await expectStatus({ action: "click", target: `getByRole("button", { name: "Count 0" })` }, "delivered",
    /~ \S+ Button "Count 0" → "Count 1"[\s\S]*~ \S+ Text "idle" → "clicked 1"|~ \S+ Text "idle" → "clicked 1"[\s\S]*~ \S+ Button "Count 0" → "Count 1"/);
  await expectStatus({ action: "verify", conditions: [{ target: `getByRole("button", { name: "Count 1", exact: true })`, is: "exists" }] }, "observed");
  await expectStatus({ action: "fill", target: `getByLabel("Name")`, text: "Ada Lovelace" }, "delivered");
  await expectStatus({ action: "check", target: `getByRole("checkbox", { name: "Agree" })` }, "delivered");
  await expectStatus({ action: "check", target: `getByRole("checkbox", { name: "Agree" })` }, "delivered", /already checked; nothing was sent/);
  await expectStatus({ action: "select", target: `getByRole("listitem").filter({ hasText: "beta" })` }, "delivered");
  await expectStatus({ action: "verify", conditions: [
    { target: `getByRole("textbox", { name: "Name" })`, value: "Ada Lovelace" },
    { target: `getByRole("checkbox", { name: "Agree" })`, is: "checked" },
    { aria: `- textbox "Name": Ada Lovelace\n- checkbox "Agree" [checked]\n- list:\n  - listitem "beta" [selected]` },
  ] }, "observed", /Verification satisfied/);
  // The bundled runtime walks the whole structural tree: static text is there, and a complete walk proves counts and absence.
  await expectStatus({ action: "verify", conditions: [
    { target: `getByText("clicked 1")`, is: "visible" },
    { target: `getByRole("listitem")`, count: 3 },
    { target: `getByRole("button", { name: "Nope" })`, is: "absent" },
    { aria: `- list "Pick":\n  - listitem "alpha"\n  - listitem "beta" [selected]\n  - listitem "gamma"\n- text: clicked 1` },
  ] }, "observed", /Verification satisfied/);
  // A mismatch in a complete walk is proven, and the receipt shows the received tree.
  await expectStatus({ action: "verify", conditions: [{ aria: `- button "Nope"` }] }, "observed", /Verification unsatisfied[\s\S]*Received aria snapshot:[\s\S]*- text: clicked 1/);
  // A menu: open File, then pick Reset from its drop-down, both by locator.
  await expectStatus({ action: "click", target: `getByRole("menuitem", { name: "File" })` }, "delivered");
  await expectStatus({ action: "click", target: `getByRole("menuitem", { name: "Reset" })` }, "delivered");
  await expectStatus({ action: "wait_for", conditions: [{ target: `getByText("reset", { exact: true })`, is: "visible" }, { target: `getByRole("button", { name: "Count 0" })`, is: "exists" }], timeout_ms: 3000 }, "observed", /Verification satisfied/);
  // Strict mode refuses an ambiguous target and lists each match's locator; nothing is sent.
  await expectStatus({ action: "click", target: `getByRole("button")` }, "refused", /Strict mode: getByRole\("button"\) matches \d+ elements/);
  await expectStatus({ action: "click", target: `getByRole("button", { name: "Nope" })`, timeout_ms: 800 }, "refused", /Timed out after 800 ms/);
  await expectStatus({ action: "click", target: `locator("css=button")` }, "refused", /not available for native windows/);

  const aria = await live.read(window, ["aria"]);
  const shown = presentComputerResult(aria);
  console.log(shown, "\n", timings.join("\n"));
  expect(shown).toMatch(/- button "Count 0" \[ref=[^\]]+\]/);
  expect(shown).toMatch(/- menuitem "File" \[ref=[^\]]+\]/);
  expect(shown).toMatch(/- text: reset/);
  expect(shown).toMatch(/- checkbox "Agree" \[checked\] \[ref=/);
  expect(shown).toMatch(/- textbox "Name" \[ref=[^\]]+\]: Ada Lovelace/);
});

test("a browser page takes the same count and aria assertions", async () => {
  const opened = await live.insert(live.machine, { action: "open_browser", browser: "chrome", url: `${fixture.base}/tabs` });
  expect(opened.details.status, text(opened)).toBe("observed");
  const window = `computer:window/${opened.details.window_ref}`;
  const verified = await live.insert(window, { action: "verify", conditions: [
    { target: `getByRole("button")`, count: 6 },
    { aria: `- heading "Tabs and dialogs" [level=1]\n- button "Save context"` },
    { target: `getByRole("status")`, aria: `- status: idle` },
  ] });
  expect(verified.details.status, text(verified)).toBe("observed");
  expect(text(verified)).toMatch(/Verification satisfied/);
  const missed = await live.insert(window, { action: "verify", conditions: [{ aria: `- button "Nope"` }] });
  expect(presentComputerResult(missed)).toMatch(/Verification unsatisfied[\s\S]*Received aria snapshot:\n[\s\S]*- button "Save context"/);
});
