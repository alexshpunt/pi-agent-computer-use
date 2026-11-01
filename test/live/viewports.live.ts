import { mkdir, writeFile } from "node:fs/promises";
import { afterAll, expect, test } from "vitest";
import { requireComputerAddress } from "../../src/computer-resources.ts";
import { clickPlan, waitCommand, windowCommand } from "../../src/computer-tools.ts";
import { presentComputerResult } from "../../src/provider.ts";
import type { ComputerResult } from "../../src/session.ts";
import { connectLive, nativeForm, openWindow, WINDOWS_POWERSHELL_PATH } from "./remote.ts";

// LPT-931: a named viewport of a native window on the configured machine: its image at the window's own resolution,
// clicks at points of that image, a change list of only its pixels, and a rectangle that follows the window.
const live = await connectLive();
afterAll(async () => { await live.close(); });
const report: string[] = [];
afterAll(async () => { await mkdir(".tmp/lpt931", { recursive: true }); await writeFile(".tmp/lpt931/report.txt", report.join("\n\n")); });
const image = (result: ComputerResult, index = 0) => Buffer.from((result.content.filter(block => block.type === "image")[index] as { data: string }).data, "base64");
const holds = async (window: string, name: string) => {
  const result = await live.insert(window, waitCommand({ window, timeout_ms: 3000, conditions: [{ target: `getByRole('button', { name: '${name}' })`, is: "exists" }] }));
  return (result.details.verification as { verdict?: string } | undefined)?.verdict;
};

test("a viewport shows its part of the window at full resolution, takes clicks in its pixels and follows the window", async () => {
  const title = `pi-viewport-${Date.now()}`;
  const window = await openWindow(live, live.machine, WINDOWS_POWERSHELL_PATH, nativeForm(title), title);
  try {
    // The agent's overview is smaller than the window, so its pixels and the window's differ.
    const overview = await live.read(window, ["full", 'capture:{"maxLongEdge":300}']);
    const button = overview.details.ui!.elements.find(e => /^Count 0/.test(e.name ?? ""))!;
    const box = button.bounds.window_image!;
    const pad = requireComputerAddress(`${window}/pad`);
    const requested = { x: 0, y: 0, width: box.x + box.width + 20, height: box.y + box.height + 20 };
    let started = performance.now();
    const made = await live.resources.view(pad, live.cwd, requested);
    report.push(`view ${Math.round(performance.now() - started)} ms\n${presentComputerResult(made)}`);
    expect(made.details.status, presentComputerResult(made)).toBe("observed");
    const viewport = made.details.viewport!;
    // Full resolution: more image pixels than the overview gave the same rectangle.
    const scale = viewport.rect.width / requested.width;
    expect(scale).toBeGreaterThan(1.2);
    expect(viewport.image).toEqual({ width: viewport.rect.width, height: viewport.rect.height });
    await mkdir(".tmp/lpt931", { recursive: true });
    await writeFile(".tmp/lpt931/pad.png", image(made));

    // The hidden console of the form's PowerShell opens through Windows Terminal, which can take the foreground a moment
    // after the form appears; the first real click needs the form in front, so focus it until it stays there.
    for (let attempt = 0; attempt < 10; attempt++) {
      await live.resources.manageWindow(requireComputerAddress(window), live.cwd, { action: "focus" });
      await new Promise(resolve => setTimeout(resolve, 500));
      const state = (await live.read(window, ["state"])).details.state as { foreground_at_target?: boolean } | undefined;
      if (state?.foreground_at_target) break;
    }
    // The button's centre in the viewport's own pixels.
    const local = { x: Math.round((box.x + box.width / 2) * scale), y: Math.round((box.y + box.height / 2) * scale) };
    started = performance.now();
    const first = await live.resources.input(pad, live.cwd, clickPlan({ window: pad.source, x: local.x, y: local.y }));
    report.push(`click in viewport ${Math.round(performance.now() - started)} ms\n${presentComputerResult(first)}`);
    expect(first.details.status, presentComputerResult(first)).toBe("delivered");
    expect(await holds(window, "Count 1")).toBe("satisfied");
    expect(first.details.viewport?.source).toBe(viewport.source);
    expect(first.details.successor?.diff?.pixels?.space).toBe("viewport");
    if (first.content.some(block => block.type === "image")) await writeFile(".tmp/lpt931/first-change.png", image(first));

    // Move the window: the viewport goes with it, so the same local point still hits the button.
    const moved = await live.resources.manageWindow(requireComputerAddress(window), live.cwd, windowCommand({ window, action: "move", x: 333, y: 222 }));
    report.push(`move\n${presentComputerResult(moved)}`);
    expect(moved.details.status, presentComputerResult(moved)).not.toBe("refused");
    const second = await live.resources.input(pad, live.cwd, clickPlan({ window: pad.source, x: local.x, y: local.y }));
    report.push(`click after move\n${presentComputerResult(second)}`);
    expect(await holds(window, "Count 2")).toBe("satisfied");

    // A Read of the viewport shows the new label; ocr finds it.
    const read = await live.read(pad.source, ["ocr"]);
    report.push(`read with ocr\n${presentComputerResult(read)}`);
    expect(JSON.stringify(read.details.text_lines)).toContain("Count 2");
    await writeFile(".tmp/lpt931/pad-after.png", image(read));

    // A point of the agent's overview keeps its meaning after input in the viewport.
    const centre = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    const third = await live.resources.input(requireComputerAddress(window), live.cwd, clickPlan({ window, x: centre.x, y: centre.y }));
    report.push(`window click\n${presentComputerResult(third)}`);
    expect(await holds(window, "Count 3")).toBe("satisfied");

    // A viewport Read only looks: a ref of the window's latest Read still acts.
    const fresh = await live.read(window, ["full"]);
    const hint = fresh.details.ui!.elements.find(e => /^Count 3/.test(e.name ?? ""))!.hint;
    await live.read(pad.source, []);
    const fourth = await live.resources.input(requireComputerAddress(window), live.cwd, clickPlan({ window, target: hint }));
    report.push(`ref click after a viewport Read\n${presentComputerResult(fourth)}`);
    expect(fourth.details.status, presentComputerResult(fourth)).toBe("delivered");
    expect(await holds(window, "Count 4")).toBe("satisfied");
  } finally {
    await live.resources.delete(window, live.cwd).catch(() => undefined);
  }
});
