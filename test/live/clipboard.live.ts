import { afterAll, expect, test } from "vitest";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";
import { addresses, connectLive, text } from "./remote.ts";
import { WINDOWS_POWERSHELL } from "../../src/runner.ts";
import type { ComputerResult } from "../../src/session.ts";

// Clipboard round trips on LIVE_MACHINE (lab, or local) through a disposable WinForms text box this check starts.
// Notepad is avoided: its first launch restores the user's previous Notepad session. The user's clipboard text is restored.
const live = await connectLive();
const title = `pi-clipboard-fixture-${Date.now()}`;
let previous: string | undefined, fixturePid = 0;
afterAll(async () => {
  if (previous !== undefined) await live.insert(live.machine, { action: "clipboard_write", text: previous });
  if (fixturePid) await live.kill(fixturePid);
  await live.close();
});

test("text written to the clipboard is pasted, and text copied in the app is read back", async () => {
  const before = await live.insert(live.machine, { action: "clipboard_read" });
  expect(before.details.status, text(before)).toBe("observed");
  previous = before.details.state?.text as string | undefined;

  live.powershell(`Add-Type -AssemblyName System.Windows.Forms; $f = New-Object Windows.Forms.Form; $f.Text = '${title}'; $f.Width = 600; $f.Height = 300;
    $t = New-Object Windows.Forms.TextBox; $t.Multiline = $true; $t.Dock = 'Fill'; $t.Font = New-Object Drawing.Font('Segoe UI', 14); $f.Controls.Add($t); [void]$f.ShowDialog()`).catch(() => undefined); // Ends when the check kills the fixture.
  let window: string | undefined;
  for (let i = 0; i < 20 && !window; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    [window] = addresses(await live.search(live.windows, title) as ComputerResult, "window");
  }
  expect(window).toBeTruthy();

  const marker = `pi clipboard ${Math.random().toString(36).slice(2, 8)}`;
  const wrote = await live.insert(live.machine, { action: "clipboard_write", text: marker });
  expect(wrote.details.status, text(wrote)).toBe("delivered");
  const view = await live.read(window!, ["image"]);
  fixturePid = view.details.target!.pid;
  const { width, height } = (view.details.agent_image as { output: { width: number; height: number } }).output;
  const typed = await live.insert(`computer:observation/${view.details.observation_id}?delivery=foreground`, { action: "sequence", sequence: [
    { action: "click", x: Math.round(width / 2), y: Math.round(height / 2) },
    { action: "hotkey", keys: ["ctrl", "v"] }, { action: "type_text", text: " + typed" },
    // A multiline WinForms text box ignores ctrl+a; select with ctrl+home and ctrl+shift+end.
    { action: "hotkey", keys: ["ctrl", "home"], wait_ms: 300 }, { action: "hotkey", keys: ["ctrl", "shift", "end"], wait_ms: 200 }, { action: "hotkey", keys: ["ctrl", "c"], wait_ms: 200 }] });
  expect(typed.details.status, text(typed)).toBe("delivered");
  await new Promise(resolve => setTimeout(resolve, 1000));
  const back = await live.insert(live.machine, { action: "clipboard_read" });
  expect(back.details.state?.text).toBe(`${marker} + typed`);
});

test("an image written to the clipboard is read back as the same picture", async () => {
  await mkdir(".tmp/m7", { recursive: true });
  await sharp({ create: { width: 64, height: 48, channels: 3, background: "#c03020" } }).png().toFile(".tmp/m7/clip.png");
  const wrote = await live.insert(live.machine, { action: "clipboard_write", image: ".tmp/m7/clip.png" });
  expect(wrote.details.status, text(wrote)).toBe("delivered");
  const read = await live.insert(live.machine, { action: "clipboard_read", image: true });
  const image = read.content.find(block => block.type === "image");
  expect(image, text(read)).toBeTruthy();
  const { data, info } = await sharp(Buffer.from((image as { data: string }).data, "base64")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  expect([info.width, info.height]).toEqual([64, 48]);
  expect([data[0], data[1], data[2]]).toEqual([0xc0, 0x30, 0x20]);
});
