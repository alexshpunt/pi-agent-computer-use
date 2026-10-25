import sharp from "sharp";
import { expect, test, vi } from "vitest";
import { computerSource } from "../src/computer-address.ts";
import { ComputerResources, requireComputerAddress } from "../src/computer-resources.ts";
import { presentComputerResult } from "../src/provider.ts";
import { ComputerSession, type ComputerResult, type Content, type Driver } from "../src/session.ts";

const cwd = "/synthetic-action-changes";
const address = requireComputerAddress;

// LPT-914: every action reports what changed in the window, like Playwright MCP's incremental snapshots.
// LPT-915: and how the window's pixels changed, with before/after crops of the changed area.
async function fixture() {
  let count = 0, serial = 0;
  const dots: { x: number; y: number }[] = [];
  // The window paints one bar per count under the button and a dot wherever a pixel click lands on the canvas.
  const frame = async () => {
    const shapes = [...Array.from({ length: count }, (_, i) => `<rect x="${20 + i * 12}" y="40" width="10" height="10" fill="#000"/>`),
      ...dots.map(dot => `<rect x="${dot.x - 3}" y="${dot.y - 3}" width="6" height="6" fill="#c00"/>`)];
    const png = await sharp({ create: { width: 500, height: 320, channels: 3, background: "#fff" } })
      .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="500" height="320">${shapes.join("")}</svg>`) }]).png().toBuffer();
    return { type: "image" as const, mimeType: "image/png", data: png.toString("base64") };
  };
  const element = (index: number, role: string, label: string) => ({ element_token: `s${serial}:${index}`, role, label, enabled: true, actions: role === "Button" ? ["invoke"] : [],
    frame: { x: 100 + index * 50, y: 100, w: 40, h: 20 }, screenshot_frame: { x: 20 + index * 50, y: 10, w: 40, h: 20 } });
  const driver: Driver = {
    identity: vi.fn(async () => "life"), close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async (name, args) => {
      const input = args as { element_token?: string; x?: number; y?: number; include_screenshot?: boolean };
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid: 42, window_id: 91 }] } };
      if (name === "get_window_state") {
        serial++;
        const pixels = input.include_screenshot !== false;
        return { content: pixels ? [await frame()] : [], structuredContent: { pid: 42, window_id: 91, snapshot_id: `s${serial}`, window_bounds: { x: 80, y: 90, width: 500, height: 320 },
          ...(pixels ? { capture_id: `c${serial}`, screenshot_width: 500, screenshot_height: 320 } : {}),
          elements_complete: true, elements: [element(0, "Button", `Count ${count}`), element(1, "Text", "Status")] } };
      }
      // Clicking the button counts; clicking the status label does nothing; a pixel click paints a dot there.
      if (name === "click") {
        if (input.element_token?.endsWith(":0")) count++;
        if (input.x !== undefined && input.y !== undefined && input.y > 100) dots.push({ x: input.x, y: input.y });
        return { content: [], structuredContent: { effect: "confirmed" } };
      }
      throw Error(`Unexpected native call ${name}`);
    }),
  };
  const session = new ComputerSession(driver, () => "yolo");
  const resources = new ComputerResources(async () => session, async () => session.close());
  const ref = ((await session.windows()).details.state!.windows as { window_ref: string }[])[0].window_ref;
  const window = computerSource("window", ref);
  const read = async (views = ["ui"]) => {
    const view = (await resources.read(address(window), cwd, views))!;
    const observation = computerSource("observation", view.details.observation_id!);
    return { view, observation: address(observation), at: (index: number) => address(`${observation}?hint=${encodeURIComponent(view.details.ui!.elements[index].hint)}`) };
  };
  const walks = () => vi.mocked(driver.call).mock.calls.filter(([name]) => name === "get_window_state").length;
  return { resources, window, read, walks };
}
const images = (result: ComputerResult) => result.content.filter((block): block is Extract<Content, { type: "image" }> => block.type === "image");

test("an action on an observation with pixels reports the changed area with before and after crops", async () => {
  const f = await fixture(), { at } = await f.read(["full"]);
  const result = await f.resources.perform(at(0), cwd, JSON.stringify({ action: "click" }), "insert");
  expect(result.details.successor?.diff?.pixels).toMatchObject({ box: { x: 20, y: 40, width: 10, height: 10 }, regions: 1, crops: [{ x: 8, y: 28, width: 34, height: 34 }] });
  expect(presentComputerResult(result)).toMatch(/~ \d+:a Button "Count 0" → "Count 1"\nPixels changed in 1 area \(overview pixels; 0\.06% of the window\):\n  x=20 y=40 w=10 h=10; images 1 and 2 show x=8 y=28 w=34 h=34 before and after\n/);
  const [before, after] = images(result);
  expect((await sharp(Buffer.from(before.data, "base64")).stats()).channels[0].min).toBe(255);
  expect((await sharp(Buffer.from(after.data, "base64")).stats()).channels[0].min).toBe(0);
});

test("pixel input on a canvas reports only its pixel change, and empty space reports nothing", async () => {
  const f = await fixture(), { observation } = await f.read(["full"]);
  const stroke = await f.resources.perform(observation, cwd, JSON.stringify({ action: "click", x: 300, y: 200 }), "insert");
  expect(stroke.details.successor?.diff).toMatchObject({ counts: { changed: 0, added: 0, removed: 0 }, pixels: { box: { x: 297, y: 197, width: 6, height: 6 } } });
  expect(images(stroke)).toHaveLength(2);
  const next = address(computerSource("observation", stroke.details.successor!.observation_id!));
  const empty = await f.resources.perform(next, cwd, JSON.stringify({ action: "click", x: 300, y: 60 }), "insert");
  expect(presentComputerResult(empty)).toMatch(/Nothing changed in the UI or the window's pixels within \d+ ms after the action\./);
  expect(images(empty)).toHaveLength(0);
});

test("an action on a UI-only observation says that pixels were not compared, and its successor has them", async () => {
  const f = await fixture(), { at } = await f.read();
  const first = await f.resources.perform(at(0), cwd, JSON.stringify({ action: "click" }), "insert");
  expect(presentComputerResult(first)).toMatch(/Pixels were not compared: the input observation had no pixels\./);
  const view = (await f.resources.read(address(computerSource("observation", first.details.successor!.observation_id!)), cwd, []))!;
  const hint = view.details.ui!.elements[0].hint;
  const second = await f.resources.perform(address(`${computerSource("observation", first.details.successor!.observation_id!)}?hint=${hint}`), cwd, JSON.stringify({ action: "click" }), "insert");
  expect(second.details.successor?.diff?.pixels?.box).toEqual({ x: 32, y: 40, width: 10, height: 10 });
});

test("a changes Read compares the window's pixels with its previous observation", async () => {
  const f = await fixture(), { observation } = await f.read(["full"]);
  await f.resources.perform(observation, cwd, JSON.stringify({ action: "click", x: 300, y: 200, successor: false }), "insert");
  const changes = (await f.resources.read(address(f.window), cwd, ["changes"]))!;
  expect(changes.details.changes?.diff?.pixels?.box).toEqual({ x: 297, y: 197, width: 6, height: 6 });
  expect(presentComputerResult(changes)).toMatch(/Pixels changed in 1 area .*\n  x=297 y=197 w=6 h=6;/);
  // Only the two crops, not the full overview.
  expect(images(changes)).toHaveLength(2);
});

test("an action reports what it changed by default, and its successor is the current observation", async () => {
  const f = await fixture(), { at } = await f.read();
  const result = await f.resources.perform(at(0), cwd, JSON.stringify({ action: "click" }), "insert");
  const shown = presentComputerResult(result);
  expect(shown).toMatch(/Changes: 1 changed, 0 added, 0 removed\n~ \d+:a Button "Count 0" → "Count 1"/);
  expect(f.resources.grantsAuthority(address(computerSource("observation", result.details.successor!.observation_id!)))).toBe(true);
});

test("an action that changes nothing says so after looking again for a moment", async () => {
  const f = await fixture(), { at } = await f.read();
  const result = await f.resources.perform(at(1), cwd, JSON.stringify({ action: "click" }), "insert");
  expect(result.details.successor?.diff?.waited_ms).toBeGreaterThanOrEqual(300);
  expect(presentComputerResult(result)).toMatch(/Nothing changed in the UI within \d+ ms after the action\. Check that the target was right/);
});

test("successor false turns the change list off for one call", async () => {
  const f = await fixture(), { at } = await f.read();
  const before = f.walks();
  const result = await f.resources.perform(at(0), cwd, JSON.stringify({ action: "click", successor: false }), "insert");
  expect(result.details.status).toBe("delivered");
  expect(result.details.successor).toBeUndefined();
  expect(f.walks()).toBe(before);
});

test("a locator action on the window address compares with the walk that resolved its target", async () => {
  const f = await fixture();
  const result = await f.resources.perform(address(f.window), cwd, JSON.stringify({ action: "click", target: "getByRole('button', { name: /Count/ })" }), "insert");
  expect(result.details.successor?.diff?.changed).toEqual([expect.stringMatching(/Button "Count 0" → "Count 1"$/)]);
});

test("each batch step says what it changed, and the batch reports the change from its start", async () => {
  const f = await fixture(), { view } = await f.read();
  const result = await f.resources.perform(address(computerSource("observation", view.details.observation_id!)), cwd, JSON.stringify({ action: "batch", steps: [
    { action: "click", target: "getByRole('button', { name: /Count/ })" },
    { action: "click", target: "getByText('Status')" },
    { action: "click", target: "getByRole('button', { name: /Count/ })" },
  ] }), "insert");
  expect(result.details.batch?.steps.map(step => step.changes)).toEqual([{ changed: 1, added: 0, removed: 0 }, { changed: 0, added: 0, removed: 0 }, undefined]);
  expect(presentComputerResult(result)).toMatch(/Step 0: click → delivered; 1 changed, 0 added, 0 removed\nStep 1: click → delivered; nothing changed\n/);
  expect(result.details.successor?.diff?.changed).toEqual([expect.stringMatching(/Button "Count 0" → "Count 2"$/)]);
});
