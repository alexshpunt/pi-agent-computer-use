import { afterAll, expect, test } from "vitest";
import { connectLive, openWindow, serveFixture, text, WINDOWS_POWERSHELL_PATH } from "./remote.ts";
import { presentComputerResult } from "../../src/provider.ts";

// LPT-911: native windows take Playwright locators. Every step is one call on the window address, without a prior Read.
const live = await connectLive();
const fixture = await serveFixture(live.runner);
afterAll(async () => { await live.close(); fixture.close(); });

const title = `Locators ${Date.now()}`;
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
$f.Controls.AddRange(@($b, $d, $t, $c, $l)); [void]$f.ShowDialog()`;

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
  await expectStatus({ action: "click", target: `getByRole("button", { name: "Later" })`, timeout_ms: 5000 }, "delivered");
  await expectStatus({ action: "click", target: `getByRole("button", { name: "Count 0" })` }, "delivered");
  await expectStatus({ action: "verify", conditions: [{ target: `getByRole("button", { name: "Count 1", exact: true })`, is: "exists" }] }, "observed");
  await expectStatus({ action: "fill", target: `getByLabel("Name")`, text: "Ada Lovelace" }, "delivered");
  await expectStatus({ action: "check", target: `getByRole("checkbox", { name: "Agree" })` }, "delivered");
  await expectStatus({ action: "check", target: `getByRole("checkbox", { name: "Agree" })` }, "delivered", /already checked; nothing was sent/);
  await expectStatus({ action: "select", target: `getByRole("listitem").filter({ hasText: "beta" })` }, "delivered");
  await expectStatus({ action: "verify", conditions: [
    { target: `getByRole("textbox", { name: "Name" })`, value: "Ada Lovelace" },
    { target: `getByRole("checkbox", { name: "Agree" })`, is: "checked" },
    { aria: `- textbox "Name": Ada Lovelace\n- checkbox "Agree" [checked]\n- listitem "beta" [selected]` },
  ] }, "observed", /Verification satisfied/);
  // A count is proven only by a complete walk; a runtime that walks just actionable elements leaves it unknown.
  const counted = await step({ action: "verify", conditions: [{ target: `getByRole("listitem")`, count: 3 }] });
  const [count] = counted.details.verification!.conditions;
  expect(count.observed, presentComputerResult(counted)).toBe("3 match(es)");
  expect(counted.details.ui!.complete ? ["satisfied"] : ["unknown"]).toContain(count.verdict);
  // Strict mode refuses an ambiguous target and lists each match's locator; nothing is sent.
  await expectStatus({ action: "click", target: `getByRole("button")` }, "refused", /Strict mode: getByRole\("button"\) matches \d+ elements/);
  await expectStatus({ action: "click", target: `getByRole("button", { name: "Nope" })`, timeout_ms: 800 }, "refused", /Timed out after 800 ms/);
  await expectStatus({ action: "click", target: `locator("css=button")` }, "refused", /not available for native windows/);

  const aria = await live.read(window, ["aria"]);
  const shown = presentComputerResult(aria);
  console.log(shown, "\n", timings.join("\n"));
  expect(shown).toMatch(/- button "Count 1" \[ref=[^\]]+\]/);
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
