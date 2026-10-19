import { afterAll, expect, test } from "vitest";
import { mkdir, readFile } from "node:fs/promises";
import sharp from "sharp";
import { addresses, connectLive, text } from "./remote.ts";
import { machineConfig } from "../../src/machine.ts";
import { sshRunner, WINDOWS_POWERSHELL } from "../../src/runner.ts";
import type { ComputerResult } from "../../src/session.ts";

// Owned files, process health and OCR on the remote machine, through the same provider the extension uses.
// Uses only a new Paint window, a disposable WinForms fixture and files in the session's own folder.
const live = await connectLive();
const runner = sshRunner((await machineConfig(process.cwd(), process.env.LIVE_MACHINE ?? "zinpc")).ssh);
const opened: number[] = [];
afterAll(async () => { for (const pid of opened) await live.kill(pid); await live.close(); });

const paint = async () => {
  const result = await live.insert(live.machine, { action: "open", app: "Paint" });
  expect(result.details.status, text(result)).toBe("observed");
  opened.push(result.details.target!.pid);
  return `computer:window/${result.details.window_ref}`;
};
const observation = (result: ComputerResult, query = "") => `computer:observation/${result.details.observation_id}${query}`;
const delivered = async (path: string, command: unknown) => {
  const result = await live.insert(path, command);
  if (result.details.status !== "delivered") console.log("NOT DELIVERED", text(result), JSON.stringify({ ...result.details, source_identity: undefined }).slice(0, 2500));
  expect(result.details.status, text(result)).toBe("delivered");
};
const size = (result: ComputerResult) => (result.details.agent_image as { output: { width: number; height: number } }).output;

test("window state reports a hung app and a working app's memory", async () => {
  const fixture = runner.spawn(WINDOWS_POWERSHELL, ["-NoProfile", "-Command",
    "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object Windows.Forms.Form; $f.Text = 'pi-hang-fixture'; $f.Show(); [Windows.Forms.Application]::DoEvents(); $end = [DateTime]::Now.AddSeconds(40); while ([DateTime]::Now -lt $end) {}"]);
  try {
    await new Promise(resolve => setTimeout(resolve, 8000)); // Windows marks a window hung after 5 s without messages.
    const [hung] = addresses(await live.search(live.machine, "pi-hang-fixture") as ComputerResult, "window");
    expect(hung).toBeTruthy();
    const state = await live.read(hung, ["state"]);
    console.log(text(state));
    expect(state.details.process).toMatchObject({ responding: false });
    opened.push(state.details.process!.pid);
    const working = await live.read(await paint(), ["state"]);
    expect(working.details.process).toMatchObject({ responding: true, name: "mspaint" });
    expect(working.details.process!.memory_mb).toBeGreaterThan(10);
  } finally { fixture.kill(); }
});

test("OCR finds text typed into a Paint canvas within a few pixels of the drawn words", async () => {
  const window = await paint();
  const full = await live.read(window, ['capture:{"granularity":"full"}']);
  const button = (full.details.ui!.elements as { hint: string; role: string; name: string }[]).find(e => e.role === "Button" && e.name === "Text")!;
  await delivered(observation(full, `?hint=${encodeURIComponent(button.hint)}&delivery=foreground`), { action: "click" });
  const small = await live.read(window, ['capture:{"granularity":"image"}']);
  const { width, height } = size(small);
  const at = { x: Math.round(width * 0.3), y: Math.round(height * 0.45) };
  await delivered(observation(small, "?delivery=foreground"), { action: "sequence", sequence: [
    { action: "click", ...at }, { action: "type_text", text: "Hello Agent 42", wait_ms: 300 },
    { action: "click", x: Math.round(width * 0.8), y: Math.round(height * 0.85), wait_ms: 300 }] });
  await new Promise(resolve => setTimeout(resolve, 500));
  const read = await live.read(window, ['capture:{"granularity":"image","maxLongEdge":3840}', "ocr"]);
  console.log(text(read).split("\n").filter(line => line.includes("OCR") || line.startsWith("- ")).join("\n"));
  const line = read.details.text_lines!.find(l => /Hello\s*Agent\s*42/i.test(l.text))!;
  expect(line).toBeTruthy();
  // Truth: the bounding box of dark pixels near the click in the same image.
  const big = size(read), scale = big.width / width;
  const image = read.content.find(block => block.type === "image")!;
  const { data, info } = await sharp(Buffer.from(image.data, "base64")).greyscale().raw().toBuffer({ resolveWithObject: true });
  const area = { left: Math.round(at.x * scale) - 20, top: Math.round(at.y * scale) - 20, right: Math.round(at.x * scale) + line.width + 80, bottom: Math.round(at.y * scale) + line.height * 3 };
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = area.top; y < area.bottom; y++) for (let x = area.left; x < area.right; x++)
    if (data[y * info.width + x] < 100) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  console.log("ink", { x0, y0, x1, y1 }, "ocr", { x: line.x, y: line.y, right: line.x + line.width, bottom: line.y + line.height });
  for (const [ocr, ink] of [[line.x, x0], [line.y, y0], [line.x + line.width, x1 + 1], [line.y + line.height, y1 + 1]]) expect(Math.abs(ocr - ink)).toBeLessThanOrEqual(6);
});

test("a file put in the session folder is opened, edited and saved in Paint, fetched back, and removed on close", async () => {
  await mkdir(".tmp/m7", { recursive: true });
  const original = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#ffffff" } })
    .composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect x="40" y="40" width="120" height="80" fill="#2050c0"/></svg>') }]).png().toBuffer();
  await sharp(original).toFile(".tmp/m7/in.png");
  const put = await live.insert(live.machine, { action: "put", from: ".tmp/m7/in.png" });
  const path = put.details.state!.path as string;
  expect(path).toMatch(/pi-computer-use\\.+\\in\.png$/);
  const folder = path.slice(0, path.lastIndexOf("\\"));

  const window = await paint();
  await delivered(observation(await live.read(window, ["image"]), "?delivery=foreground"), { action: "hotkey", keys: ["ctrl", "o"] });
  await new Promise(resolve => setTimeout(resolve, 1500));
  const paintPid = opened.at(-1);
  const rows = ((await live.search(live.machine, "Open") as ComputerResult).details.state?.windows ?? []) as { pid: number; title: string; window_ref?: string }[];
  const dialog = rows.find(row => row.pid === paintPid && row.title === "Open")?.window_ref;
  expect(dialog).toBeTruthy();
  await delivered(observation(await live.read(`computer:window/${dialog}`, ["image"]), "?delivery=foreground"), { action: "sequence", sequence: [
    { action: "type_text", text: path }, { action: "key", key: "return", wait_ms: 300 }] });
  await new Promise(resolve => setTimeout(resolve, 2000));
  const full = await live.read(window, ['capture:{"granularity":"full"}']);
  expect(text(full) + JSON.stringify(full.details.ui?.elements.map(e => e.name))).toMatch(/in(\.png)? - Paint/);
  const pencil = (full.details.ui!.elements as { hint: string; role: string; name: string }[]).find(e => e.role === "Button" && e.name === "Pencil")!;
  await delivered(observation(full, `?hint=${encodeURIComponent(pencil.hint)}&delivery=foreground`), { action: "click" });
  // The 400x300 picture sits in the middle of the canvas area at 100% zoom; draw a short line across its centre.
  const view = await live.read(window, ["image"]);
  const { width, height } = size(view);
  await delivered(observation(view, "?delivery=foreground"), { action: "sequence", sequence: [
    { action: "drag", from_x: Math.round(width / 2) - 40, from_y: Math.round(height * 0.55), to_x: Math.round(width / 2) + 40, to_y: Math.round(height * 0.55), duration_ms: 400 },
    { action: "hotkey", keys: ["ctrl", "s"], wait_ms: 300 }] });
  await new Promise(resolve => setTimeout(resolve, 2000));

  const got = await live.insert(live.machine, { action: "get", name: "in.png", to: ".tmp/m7/out.png" });
  expect(got.details.status, text(got)).toBe("delivered");
  // Compare decoded pixels: saving alone may re-encode the PNG without changing the picture.
  const pixels = async (png: Buffer) => (await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true }));
  const before = await pixels(original), after = await pixels(await readFile(".tmp/m7/out.png"));
  expect([after.info.width, after.info.height]).toEqual([400, 300]);
  let changed = 0;
  for (let i = 0; i < before.data.length; i += 3) if (Math.abs(before.data[i] - after.data[i]) + Math.abs(before.data[i + 1] - after.data[i + 1]) + Math.abs(before.data[i + 2] - after.data[i + 2]) > 60) changed++;
  console.log("changed pixels", changed);
  expect(changed).toBeGreaterThan(50);

  for (const pid of opened.splice(0)) await live.kill(pid);
  await live.close();
  const wsl = (await runner.run("wslpath", ["-u", folder])).trim();
  expect(await runner.run("bash", ["-c", `test -e '${wsl}' && echo present || echo gone`])).toContain("gone");
});
