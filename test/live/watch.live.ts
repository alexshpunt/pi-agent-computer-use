import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterAll, expect, test } from "vitest";
import { requireComputerAddress } from "../../src/computer-resources.ts";
import { dragPlan, windowCommand } from "../../src/computer-tools.ts";
import { presentComputerResult } from "../../src/provider.ts";
import type { ComputerResult } from "../../src/session.ts";
import { connectLive, openWindow, WINDOWS_POWERSHELL_PATH } from "./remote.ts";

// LPT-930: watch a panorama-like viewport of a native window on the configured machine while dragging it.
const live = await connectLive();
afterAll(async () => { await live.close(); });
const report: string[] = [];
const out = ".tmp/lpt930";
afterAll(async () => { await mkdir(out, { recursive: true }); await writeFile(`${out}/report.txt`, report.join("\n\n")); });
const image = (result: ComputerResult) => Buffer.from((result.content.find(block => block.type === "image") as { data: string }).data, "base64");

/** A form with a 600x300 view of a wide strip of numbered colour bands that follows the pointer while the left button is held. */
function panoramaForm(title: string, maximized = false): string[] {
  const script = `Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$f = New-Object Windows.Forms.Form; $f.Text = '${title}'; $f.Width = 660; $f.Height = 380
$v = New-Object Windows.Forms.Panel; $v.Left = 10; $v.Top = 10; $v.Width = 600; $v.Height = 300; $v.BackColor = 'Black'
$bmp = New-Object Drawing.Bitmap 2400, 300; $g = [Drawing.Graphics]::FromImage($bmp)
$colors = @('Red', 'Orange', 'Gold', 'Green', 'Teal', 'Blue', 'Indigo', 'Purple')
$font = New-Object Drawing.Font 'Arial', 48
for ($i = 0; $i -lt 16; $i++) {
  $g.FillRectangle((New-Object Drawing.SolidBrush ([Drawing.Color]::FromName($colors[$i % 8]))), $i * 150, 0, 150, 300)
  $g.DrawString("$i", $font, [Drawing.Brushes]::White, $i * 150 + 40, 110)
}
$p = New-Object Windows.Forms.PictureBox; $p.Image = $bmp; $p.Width = 2400; $p.Height = 300; $p.Left = 0; $p.AccessibleName = 'Pano'
$p.Add_MouseDown({ $script:mx = [Windows.Forms.Control]::MousePosition.X; $script:left = $p.Left })
$p.Add_MouseMove({ if ([Windows.Forms.Control]::MouseButtons -eq 'Left') { $p.Left = [Math]::Min(0, [Math]::Max(-1800, $script:left + [Windows.Forms.Control]::MousePosition.X - $script:mx)) } })
$v.Controls.Add($p); $f.Controls.Add($v); ${maximized ? "$f.WindowState = 'Maximized'; " : ""}[void]$f.ShowDialog()`;
  return ["-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

test("a watch of a viewport sees the panorama move during a drag and stops with the motion on its sheet", async () => {
  await rm(`${out}/live-watch`, { recursive: true, force: true });
  const title = `pi-watch-${Date.now()}`;
  const window = await openWindow(live, live.machine, WINDOWS_POWERSHELL_PATH, panoramaForm(title), title);
  try {
    // Windows Terminal on this machine can take the foreground after the form appears; a real drag needs the form in front.
    for (let attempt = 0; attempt < 10; attempt++) {
      await live.resources.manageWindow(requireComputerAddress(window), live.cwd, windowCommand({ window, action: "focus" }));
      await new Promise(resolve => setTimeout(resolve, 500));
      const state = (await live.read(window, ["state"])).details.state as { foreground_at_target?: boolean } | undefined;
      if (state?.foreground_at_target) break;
    }
    const overview = await live.read(window, ["full"]);
    const pano = overview.details.ui!.elements.find(e => e.name === "Pano")!;
    // The visible part of the strip: its element is wider than the view, so take the view's 600x300 from its left edge.
    const box = pano.bounds.window_image!;
    const scale = (overview.details.state as { screenshot_width: number; screenshot_original_width: number });
    const k = scale.screenshot_width / scale.screenshot_original_width;
    const rect = { x: box.x, y: box.y, width: Math.round(600 * k), height: box.height };
    const view = requireComputerAddress(`${window}/pano`);
    const made = await live.resources.view(view, live.cwd, rect);
    expect(made.details.status, presentComputerResult(made)).toBe("observed");

    let started = performance.now();
    const watch = await live.resources.watch(view, live.cwd, { fps: 15 });
    report.push(`watch start ${Math.round(performance.now() - started)} ms\n${presentComputerResult(watch)}`);
    expect(watch.details.status, presentComputerResult(watch)).toBe("observed");
    const sequence = requireComputerAddress(`computer:sequence/${watch.details.watch!.sequence_id}`);

    // Drag the strip left by about 300 px of the window over 1.5 s.
    const from = { x: rect.x + Math.round(rect.width * 0.8), y: rect.y + Math.round(rect.height / 2) };
    const to = { x: from.x - Math.round(300 * k), y: from.y };
    const dragged = await live.resources.input(requireComputerAddress(window), live.cwd, dragPlan({ window, from, to, duration_ms: 1500 }));
    report.push(`drag\n${presentComputerResult(dragged)}`);
    expect(dragged.details.status, presentComputerResult(dragged)).toBe("delivered");
    const span = dragged.details.watch_spans![0];
    expect(span.frames!.to - span.frames!.from).toBeGreaterThanOrEqual(8);

    // The newest frame reads while the watch runs.
    const latest = await live.resources.read(sequence, live.cwd, ["frames:last"]);
    expect(latest!.details.status).toBe("observed");

    started = performance.now();
    const stopped = await live.resources.stopWatch(sequence, live.cwd, { to: `${out}/live-watch`, video: true });
    report.push(`watch stop ${Math.round(performance.now() - started)} ms\n${presentComputerResult(stopped)}\n${(stopped.content[0] as { text: string }).text.split("\n{")[0]}`);
    expect(stopped.details.status, presentComputerResult(stopped)).toBe("observed");
    await writeFile(`${out}/sheet.png`, image(stopped));
    const json = JSON.parse(await readFile(`${out}/live-watch/watch.json`, "utf8"));
    const moving = json.frames.filter((frame: { actions: string[]; changed_share: number }) => frame.actions.includes("drag") && frame.changed_share > 0.05);
    expect(moving.length).toBeGreaterThanOrEqual(5);

    // A watch stops by itself at its time limit.
    const short = await live.resources.watch(requireComputerAddress(window), live.cwd, { fps: 5, timeout_ms: 2000 });
    await new Promise(resolve => setTimeout(resolve, 3000));
    const ended = await live.resources.stopWatch(requireComputerAddress(`computer:sequence/${short.details.watch!.sequence_id}`), live.cwd, {});
    report.push(`timed out\n${(ended.content[0] as { text: string }).text.split("\n{")[0]}`);
    expect(ended.details.sequence!.stop_reason).toBe("completed");
  } finally {
    await live.resources.delete(window, live.cwd).catch(() => undefined);
  }
}, 180_000);

// LPT-950: a viewport of a maximized window: the driver encodes only the viewport, and a second capture overlaps a slow
// one, so the watch keeps at least 12 of 15 FPS during a drag. Before, every frame was the whole window: 5 FPS at 4K.
test("a watch of a viewport in a maximized window keeps its frame rate during a drag", async () => {
  const title = `pi-watch-max-${Date.now()}`;
  const window = await openWindow(live, live.machine, WINDOWS_POWERSHELL_PATH, panoramaForm(title, true), `regex:^${title}$`);
  try {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await live.resources.manageWindow(requireComputerAddress(window), live.cwd, windowCommand({ window, action: "focus" }));
    const overview = await live.read(window, ["full"]);
    const box = overview.details.ui!.elements.find(e => e.name === "Pano")!.bounds.window_image!;
    const state = overview.details.state as { screenshot_width: number; screenshot_original_width: number };
    const k = state.screenshot_width / state.screenshot_original_width;
    const rect = { x: box.x, y: box.y, width: Math.round(600 * k), height: box.height };
    const view = requireComputerAddress(`${window}/pano`);
    expect((await live.resources.view(view, live.cwd, rect)).details.status).toBe("observed");
    const watch = await live.resources.watch(view, live.cwd, { fps: 15 });
    expect(watch.details.status, presentComputerResult(watch)).toBe("observed");
    const from = { x: rect.x + Math.round(rect.width * 0.8), y: rect.y + Math.round(rect.height / 2) };
    const dragged = await live.resources.input(requireComputerAddress(window), live.cwd, dragPlan({ window, from, to: { x: from.x - Math.round(300 * k), y: from.y }, duration_ms: 2000 }));
    expect(dragged.details.status, presentComputerResult(dragged)).toBe("delivered");
    const stopped = await live.resources.stopWatch(requireComputerAddress(`computer:sequence/${watch.details.watch!.sequence_id}`), live.cwd, {});
    const sequence = stopped.details.sequence!;
    report.push(`maximized window\n${(stopped.content[0] as { text: string }).text.split("\n")[0]}\ncapture latency ${JSON.stringify(sequence.frames.map(f => Math.round(f.capture_latency_ms)))}`);
    expect(sequence.actual_fps).toBeGreaterThanOrEqual(12);
    expect(sequence.frames[0].source.image.crop?.coordinate_space).toBe("window_physical_pixels");
  } finally {
    const { pid } = (await live.read(window, ["state"])).details.target as { pid: number };
    await live.kill(pid);
  }
}, 180_000);
