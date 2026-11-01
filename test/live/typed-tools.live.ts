import { afterAll, expect, test } from "vitest";
import { requireComputerAddress } from "../../src/computer-resources.ts";
import { openCommand, windowCommand } from "../../src/computer-tools.ts";
import { deleteComputer } from "../../src/provider.ts";
import { connectLive, nativeForm, openWindow, WINDOWS_POWERSHELL_PATH } from "./remote.ts";

// LPT-934: computer_window and Delete on a real window of the configured machine.
const live = await connectLive();
afterAll(() => live.close());
const manage = (window: string, fields: Record<string, unknown>) =>
  live.resources.manageWindow(live.resources.address(window), live.cwd, windowCommand({ window, action: "restore", ...fields } as Parameters<typeof windowCommand>[0]));
const remove = (source: string) => deleteComputer(live.resources, source, { path: source }, live.cwd);
const gone = async (title: string) => {
  for (let i = 0; i < 20; i++) {
    if (!((await live.search(live.windows, title)).details.state?.windows as unknown[] | undefined)?.length) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
};

test("computer_window moves, resizes, minimizes and restores a window by its address, and Delete closes it", async () => {
  expect(openCommand(requireComputerAddress(live.machine), { at: live.machine, app: "Notepad" })).toEqual({ action: "open", app: "Notepad" });
  const title = `pi-typed-${Date.now()}`;
  const window = await openWindow(live, live.machine, WINDOWS_POWERSHELL_PATH, nativeForm(title), title);
  for (const fields of [{ action: "move", x: 200, y: 150 }, { action: "resize", width: 600, height: 450 }, { action: "minimize" }, { action: "restore" }]) {
    const started = Date.now();
    const result = await manage(window, fields);
    console.log(`${fields.action}: ${result.details.status} in ${Date.now() - started} ms`);
    expect(result.details.status, JSON.stringify(result.content)).toBe("delivered");
  }
  const state = await live.read(window, ["state"]);
  const bounds = (state.details.state?.state as { bounds: { x: number; y: number; width: number; height: number } }).bounds;
  expect(Math.abs(bounds.x - 200)).toBeLessThan(20);
  expect(Math.abs(bounds.width - 600)).toBeLessThan(20);
  const started = Date.now();
  const closed = await remove(window);
  console.log(`delete: ${closed.script.outcome} in ${Date.now() - started} ms: ${closed.summary}`);
  expect(closed.data).toMatchObject({ ok: true, status: "closed", machine: process.env.LIVE_MACHINE ?? "lab" });
  expect(await gone(title)).toBe(true);
});

test("Delete reports a window that refuses to close and leaves it open", async () => {
  const title = `pi-stubborn-${Date.now()}`;
  const args = nativeForm(title);
  const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le").replace("[void]$f.ShowDialog()", "$f.Add_FormClosing({ $_.Cancel = $true }); [void]$f.ShowDialog()");
  const window = await openWindow(live, live.machine, WINDOWS_POWERSHELL_PATH, [...args.slice(0, -1), Buffer.from(script, "utf16le").toString("base64")], title);
  const target = (await live.read(window, ["state"])).details.target as { pid: number };
  try {
    const kept = await remove(window);
    console.log(`stubborn delete: ${kept.script.outcome}: ${kept.summary}`);
    expect(kept.data).toMatchObject({ ok: true, status: "delivered" });
    expect(kept.summary).toContain("still open after 5 s");
    expect(await gone(title)).toBe(false);
    const forced = await remove(`${window}?force=true`);
    console.log(`force: ${forced.script.outcome}: ${forced.summary}`);
  } finally { await live.kill(target.pid); }
});
