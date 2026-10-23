import { afterAll, expect, test } from "vitest";
import { addresses, connectLive, text } from "./remote.ts";
import type { ComputerResult } from "../../src/session.ts";

// Driver tools exposed after the LPT-818 audit: menu invocation and force-closing session-owned windows.
// Uses only a disposable WinForms fixture and a new Paint window this check opens.
const live = await connectLive();
const title = `pi-menu-fixture-${Date.now()}`;
let fixturePid = 0;
afterAll(async () => { if (fixturePid) await live.kill(fixturePid); await live.close(); });

const fixture = async () => {
  live.powershell(`Add-Type -AssemblyName System.Windows.Forms; $f = New-Object Windows.Forms.Form; $f.Text = '${title}'; $f.Width = 500; $f.Height = 300;
    $m = New-Object Windows.Forms.MenuStrip; $file = New-Object Windows.Forms.ToolStripMenuItem('File'); $g = New-Object Windows.Forms.ToolStripMenuItem('Greet');
    $g.add_Click({ $f.Text = '${title} greeted' }); [void]$file.DropDownItems.Add($g); [void]$m.Items.Add($file); $f.MainMenuStrip = $m; $f.Controls.Add($m); [void]$f.ShowDialog()`).catch(() => undefined);
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const [window] = addresses(await live.search(live.windows, title) as ComputerResult, "window");
    if (window) return window;
  }
  throw new Error("The menu fixture did not appear.");
};

test("menu invokes an application menu item by its labels", async () => {
  const window = await fixture();
  const view = await live.read(window, ["full"]);
  fixturePid = view.details.target!.pid;
  const invoked = await live.insert(`computer:observation/${view.details.observation_id}`, { action: "menu", path: ["File", "Greet"] });
  expect(invoked.details.status, text(invoked)).toBe("delivered");
  await new Promise(resolve => setTimeout(resolve, 500));
  const [greeted] = addresses(await live.search(live.windows, `${title} greeted`) as ComputerResult, "window");
  expect(greeted).toBeTruthy();
  const missing = await live.insert(`computer:observation/${(await live.read(window, ["full"])).details.observation_id}`, { action: "menu", path: ["File", "No such item"] });
  expect(missing.details.status, text(missing)).not.toBe("delivered");
});

test("kill force-closes only a process whose windows this session opened", async () => {
  const [found] = addresses(await live.search(live.windows, title) as ComputerResult, "window");
  const foreign = await live.insert(found ?? await fixture(), { action: "kill" });
  expect(foreign.details.status, text(foreign)).toBe("refused");
  const opened = await live.insert(live.machine, { action: "open", app: "Paint" });
  expect(opened.details.status, text(opened)).toBe("observed");
  const pid = opened.details.target!.pid;
  const killed = await live.insert(`computer:window/${opened.details.window_ref}`, { action: "kill" });
  expect(killed.details.status, text(killed)).toBe("delivered");
  await new Promise(resolve => setTimeout(resolve, 1000));
  expect((await live.powershell(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`)).trim()).toBe("gone");
});
