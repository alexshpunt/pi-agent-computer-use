import { afterAll, beforeAll, expect, test } from "vitest";
import sharp from "sharp";
import { requireComputerAddress } from "../../src/computer-resources.ts";
import { pressPlan, timelinePlan, windowCommand } from "../../src/computer-tools.ts";
import { connectLive, text, WINDOWS_POWERSHELL_PATH } from "./remote.ts";
import type { ComputerResult } from "../../src/session.ts";

// LPT-809, LPT-956: synthetic pen pressure reaches a pressure-aware app. GIMP (user install, GIMP_PATH on the machine)
// draws with its default Paintbrush, size 51 and "Pressure Size" dynamics. Paint 11 ignores synthetic pressure.
// GIMP runs one instance per profile: the check starts its own instance with a temporary profile, so a GIMP the person
// has open is never used or closed. GIMP 3.2 at 150% scaling opens its window far taller than the display while its
// docks show, which hides the canvas; the check hides the docks (Tab) and centres the image at 100%.
const live = await connectLive();
const gimp = process.env.GIMP_PATH ?? "C:\\Users\\user\\AppData\\Local\\Programs\\GIMP 3\\bin\\gimp-3.2.exe";
let own: { pid: number; folder: string } | undefined;
let window = "";
/** The canvas image's box in pixels of the window's overview. */
let canvas = { left: 0, top: 0, right: 0, bottom: 0 };
let overviewWidth = 0;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const windows = async (query: string) => ((await live.search(live.windows, query) as ComputerResult).details.state?.windows ?? []) as { window_ref?: string; pid: number; title: string }[];
const press = async (target: string, key: string) => {
  await live.read(target, []);
  const result = await live.resources.input(requireComputerAddress(target), live.cwd, pressPlan({ window: target, key }));
  expect(result.details.status, text(result)).toBe("delivered");
};

beforeAll(async () => {
  await sharp({ create: { width: 900, height: 700, channels: 3, background: "#ffffff" } }).png().toFile(".tmp/pen-canvas.png");
  const put = await live.insert(live.machine, { action: "put", from: ".tmp/pen-canvas.png" });
  const file = put.details.state!.path as string;
  const folder = file.replace(/\\[^\\]+$/, "");
  const before = new Set((await windows("GIMP")).map(row => row.pid));
  await live.insert(live.machine, { action: "open", path: WINDOWS_POWERSHELL_PATH, args: ["-NoProfile", "-WindowStyle", "Hidden", "-Command",
    `$env:GIMP3_DIRECTORY = '${folder}\\gimp-profile'; & '${gimp}' --new-instance --no-splash '${file}'`] });
  let main: { window_ref?: string; pid: number } | undefined;
  for (let attempt = 0; attempt < 60 && !main; attempt++) {
    await pause(1000);
    main = (await windows("regex:pen-canvas.*GIMP$")).find(row => row.window_ref && !before.has(row.pid));
  }
  expect(main, "GIMP did not open the canvas in its own instance").toBeTruthy();
  own = { pid: main!.pid, folder };
  window = `computer:window/${main!.window_ref}`;
  await pause(2000);
  const welcome = (await windows("regex:^Welcome to GIMP")).find(row => row.pid === own!.pid && row.window_ref);
  if (welcome) await press(`computer:window/${welcome.window_ref}`, "Escape");
  await live.resources.manageWindow(live.resources.address(window), live.cwd, windowCommand({ window, action: "maximize" }));
  await pause(1000);
  await press(window, "Tab");
  await pause(1000);
  // 1 shows the image at 100% around the old view; shift+J centres it.
  for (const key of ["1", "shift+j"]) {
    await press(window, key);
    await pause(800);
  }
  const view = await live.read(window, ["image"]);
  const png = Buffer.from((view.content.find(block => block.type === "image") as { data: string }).data, "base64");
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const white = (x: number, y: number) => data[y * info.width + x] > 250;
  const row = Math.round(info.height / 2), column = Math.round(info.width / 2);
  const xs = Array.from({ length: info.width }, (_, x) => x).filter(x => white(x, row));
  const ys = Array.from({ length: info.height }, (_, y) => y).filter(y => white(column, y));
  overviewWidth = info.width;
  canvas = { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
  expect(canvas.right - canvas.left, "the canvas is not visible in GIMP's window").toBeGreaterThan(100);
}, 180_000);

afterAll(async () => {
  if (own) {
    await live.kill(own.pid);
    await live.powershell(`Remove-Item -LiteralPath '${own.folder}' -Recurse -Force -ErrorAction SilentlyContinue`);
  }
  await live.close();
});

type Event = Record<string, unknown>;
/** One pen stroke along a row of the canvas: down, 20 moves `step` pixels apart and up. */
function stroke(start: number, x0: number, y: number, step: number, interval: number, pressure: (i: number) => number): Event[] {
  return [{ at_ms: start, type: "pen_down", x: x0, y, pressure: pressure(0) },
    ...Array.from({ length: 20 }, (_, i) => ({ at_ms: start + interval * (i + 1), type: "pen_move", x: x0 + step * (i + 1), y, pressure: pressure(i + 1) })),
    { at_ms: start + interval * 21, type: "pen_up", x: x0 + step * 20, y }];
}
async function draw(events: Event[]) {
  await live.read(window, []);
  const drawn = await live.resources.input(requireComputerAddress(window), live.cwd, timelinePlan({ window, events } as Parameters<typeof timelinePlan>[0]));
  expect(drawn.details.status, text(drawn)).toBe("delivered");
  await pause(800);
}
/** Dark pixels across a row at each fraction of a stroke, in pixels of a full-resolution capture. */
async function widths(x0: number, x1: number, y: number, fractions: number[]) {
  const view = await live.read(window, ["image", 'capture:{"maxLongEdge":3840}']);
  const png = Buffer.from((view.content.find(block => block.type === "image") as { data: string }).data, "base64");
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const scale = info.width / overviewWidth;
  return fractions.map(fraction => {
    const x = Math.round((x0 + (x1 - x0) * fraction) * scale);
    let dark = 0;
    for (let dy = -30 * scale; dy <= 30 * scale; dy++) if (data[Math.round(y * scale + dy) * info.width + x] < 200) dark++;
    return dark;
  });
}

test("a pen stroke with rising pressure gets thicker in GIMP", async () => {
  const x0 = canvas.left + 20, x1 = canvas.right - 20, rising = canvas.top + 40, flat = canvas.top + 80;
  const step = (x1 - x0) / 20;
  await draw([...stroke(0, x0, rising, step, 16, i => Math.round((0.05 + 0.95 * i / 20) * 100) / 100), ...stroke(500, x0, flat, step, 16, () => 0.5)]);
  const up = await widths(x0, x1, rising, [0.1, 0.3, 0.5, 0.7, 0.9]), level = await widths(x0, x1, flat, [0.1, 0.3, 0.5, 0.7, 0.9]);
  console.log("stroke widths (px)", { rising: up, constant: level });
  expect(up.every((value, i) => i === 0 || value >= up[i - 1])).toBe(true);
  expect(up.at(-1)! - up[0]).toBeGreaterThanOrEqual(24);
  expect(Math.max(...level) - Math.min(...level)).toBeLessThanOrEqual(3);
});

// LPT-956: a light stroke sent fast was reported to start with a blob of about half the brush size. It draws its
// requested width from its first dab, at 4 ms between events as at 12 ms.
test("a light pen stroke sent 4 ms apart keeps its width from its first dab", async () => {
  const x0 = canvas.left + 20, step = 6, y4 = canvas.top + 130, y12 = canvas.top + 160;
  await draw([...stroke(0, x0, y4, step, 4, () => 0.075), ...stroke(300, x0, y12, step, 12, () => 0.075)]);
  const fractions = [0.05, 0.15, 0.25, 0.35, 0.5, 0.75];
  const fast = await widths(x0, x0 + step * 20, y4, fractions), slow = await widths(x0, x0 + step * 20, y12, fractions);
  console.log("light stroke widths (px)", { fast, slow });
  const middle = fast[4];
  expect(middle).toBeGreaterThan(0);
  expect(Math.max(...fast)).toBeLessThanOrEqual(middle + 2);
  expect(Math.max(...fast)).toBeLessThanOrEqual(Math.max(...slow) + 2);
});
