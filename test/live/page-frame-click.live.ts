import sharp from "sharp";
import { afterAll, expect, test } from "vitest";
import { clickPlan, windowCommand } from "../../src/computer-tools.ts";
import { computerAction, presentComputerResult, readComputer } from "../../src/provider.ts";
import { connectLive } from "./remote.ts";

const live = await connectLive();
const { resources, cwd } = live;

// Draw the target rather than making it a DOM element. Only the delivered PNG gives the test its click point.
const html = `<!doctype html><title>Page frame click fixture</title>
<style>
  body { margin: 0; min-height: 200vh; background: #132030 }
  canvas { display: block; width: 100%; height: 100vh }
  button { position: fixed; top: 12px; left: 12px; width: 108px; height: 32px }
</style>
<canvas id="pad"></canvas><button id="control">Ordinary button</button>
<script>
  const pad = document.querySelector('#pad');
  const control = document.querySelector('#control');
  const events = [];
  let hits = 0;
  let buttons = 0;
  let marker;
  function paint() {
    pad.width = pad.clientWidth;
    pad.height = pad.clientHeight;
    marker = { x: Math.floor(pad.width * .74), y: Math.floor(pad.height * .69) };
    const ctx = pad.getContext('2d');
    ctx.fillStyle = 'rgb(249, 20, 175)';
    ctx.fillRect(marker.x - 16, marker.y - 10, 32, 20);
  }
  paint();
  addEventListener('resize', paint);
  for (const type of ['pointerdown', 'click']) {
    document.addEventListener(type, e => events.push({ type, target: e.target.id, x: e.clientX, y: e.clientY, trusted: e.isTrusted }));
  }
  pad.addEventListener('click', e => {
    if (Math.abs(e.pageX - marker.x) < 16 && Math.abs(e.pageY - marker.y) < 10) hits++;
  });
  control.addEventListener('click', () => buttons++);
  window.probe = () => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scroll: scrollY,
    marker: { x: marker.x - scrollX, y: marker.y - scrollY }, hits, buttons, events });
  if (location.pathname === '/') {
    // Scroll on a signal from the fixture server, without a Pi input/action that might invalidate the frame on its own.
    fetch('/next-scroll').then(response => response.text()).then(command => {
      if (command !== 'scroll') return;
      scrollTo(0, 127);
      requestAnimationFrame(() => fetch('/scrolled', { method: 'POST' }));
    });
  }
</script>`;

const child = live.runner.spawn("node", ["--input-type=module", "-e", `
  import { createServer } from 'node:http';
  let page, test, scrolled = false;
  const server = createServer((req, res) => {
    if (req.url === '/next-scroll' && !scrolled) {
      if (test) res.end('scroll');
      else page = res;
      return;
    }
    if (req.url === '/scroll' && req.method === 'POST' && !scrolled) {
      test = res;
      page?.end('scroll');
      return;
    }
    if (req.url === '/scrolled' && req.method === 'POST') {
      scrolled = true;
      test?.end('done');
      res.end();
      return;
    }
    if (req.url === '/next-scroll') { res.end('ignore'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(${JSON.stringify(html)});
  });
  server.listen(0, '127.0.0.1', () => console.log('FRAME_FIXTURE http://127.0.0.1:' + server.address().port));
  process.stdin.on('end', () => { server.close(); server.closeAllConnections(); });
  process.stdin.resume();
`]);
afterAll(async () => {
  try { await live.close(); }
  finally { child.stdin.end(); child.kill(); }
});
const base = await new Promise<string>((resolve, reject) => {
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    const url = /^FRAME_FIXTURE (\S+)\r?\n/m.exec(stdout)?.[1];
    if (url) resolve(url);
  });
  child.once("error", reject);
  child.once("exit", code => reject(new Error(`Page frame fixture exited with code ${code}.`)));
});

type Point = { x: number; y: number };
type Frame = { id: string; width: number; height: number };
type Probe = { width: number; height: number; dpr: number; scroll: number; marker: Point; hits: number; buttons: number;
  events: (Point & { type: string; target: string; trusted: boolean })[] };

async function open(url: string) {
  const opened = await live.insert(live.machine, { action: "open_browser", browser: "chrome", url });
  expect(opened.details.status, presentComputerResult(opened)).toBe("observed");
  expect(opened.details.window_ref).toBeTruthy();
  return `computer:window/${opened.details.window_ref}`;
}

async function browser(window: string, command: Record<string, unknown>) {
  const result = await resources.browserAction(resources.address(window), cwd, command);
  expect(result.details.status, presentComputerResult(result)).toBe("delivered");
  expect(result.details.dom?.evaluation?.error).toBeUndefined();
  return result.details.dom!;
}

async function probe(window: string): Promise<Probe> {
  const evaluated = await browser(window, { action: "evaluate", expression: "window.probe()" });
  return JSON.parse(evaluated.evaluation!.value!);
}

async function capture(window: string): Promise<{ frame: Frame; marker: Point }> {
  const read = await readComputer(resources, window, cwd, { views: ["page-image"] }, false);
  expect(read.details.computer?.status, JSON.stringify(read.content.filter(block => block.type === "text"))).toBe("observed");
  const frame = read.details.computer?.page_frame;
  expect(frame).toMatchObject({ id: expect.any(String), width: expect.any(Number), height: expect.any(Number) });
  const text = read.content.find(block => block.type === "text")?.text;
  expect(text).toContain(frame!.id);
  const images = read.content.filter(block => block.type === "image");
  expect(images).toHaveLength(1);
  expect(images[0].mimeType).toBe("image/png");
  const png = sharp(Buffer.from(images[0].data, "base64"));
  expect(await png.metadata()).toMatchObject({ format: "png", width: frame!.width, height: frame!.height });
  expect(Math.max(frame!.width, frame!.height)).toBeLessThanOrEqual(1280);
  const { data, info } = await png.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width, right = -1, top = info.height, bottom = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const offset = (y * info.width + x) * info.channels;
    if (data[offset] < 230 || data[offset + 1] > 40 || data[offset + 2] < 150) continue;
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  expect(right - left, "The painted marker must appear in the returned PNG").toBeGreaterThan(3);
  expect(bottom - top).toBeGreaterThan(3);
  return { frame: frame!, marker: { x: Math.floor((left + right) / 2), y: Math.floor((top + bottom) / 2) } };
}

async function click(window: string, params: Omit<Parameters<typeof clickPlan>[0], "window">) {
  const receipt = await computerAction(resources, window, "click", () => resources.address(window),
    address => resources.input(address, cwd, clickPlan({ window, ...params })));
  return receipt.script;
}

async function refused(window: string, id: string, point: Point, scenario: string) {
  const result = await click(window, { ...point, space: `frame:${id}` });
  expect(result, `${scenario}: ${result.text}`).toMatchObject({ outcome: "refused", effect: "not-applied" });
}

async function place(window: string, params: Omit<Parameters<typeof windowCommand>[0], "window">) {
  const result = await resources.manageWindow(resources.address(window), cwd, windowCommand({ window, ...params }));
  expect(result.details.status, presentComputerResult(result)).toBe("delivered");
}

// LPT-1872: run with LIVE_REQUIRE_4K=1 on a 4K display with fractional Windows DPI scaling.
test("the sent page image grounds a browser click and stale or unrelated frames never dispatch", async () => {
  const window = await open(`${base}/`);
  await place(window, { action: "maximize" });
  const original = await probe(window);
  console.log(`Browser viewport: ${original.width}x${original.height} CSS pixels at DPR ${original.dpr}.`);
  if (process.env.LIVE_REQUIRE_4K === "1") {
    expect(Number.isInteger(original.dpr), "Use fractional Windows display scaling for this run").toBe(false);
    expect(original.width * original.dpr, "Maximized browser must span the 4K display").toBeGreaterThan(3800);
  }

  const { frame, marker } = await capture(window);
  if (Math.max(original.width, original.height) * original.dpr > 1280)
    expect(Math.max(frame.width, frame.height)).toBe(1280);
  await refused(window, frame.id, { x: frame.width, y: marker.y }, "right edge outside the frame");
  await refused(window, "missing-frame-id", marker, "unknown frame id");
  const clicked = await click(window, { ...marker, space: `frame:${frame.id}` });
  expect(clicked, clicked.text).toMatchObject({ outcome: "delivered", effect: "applied" });
  await refused(window, frame.id, marker, "frame already used for a click");
  const observed = await probe(window);
  expect(observed.hits).toBe(1);
  expect(observed.events.map(({ type, target, trusted }) => ({ type, target, trusted }))).toEqual([
    { type: "pointerdown", target: "pad", trusted: true }, { type: "click", target: "pad", trusted: true },
  ]);
  expect(Math.abs(observed.events[1].x - original.marker.x)).toBeLessThanOrEqual(4);
  expect(Math.abs(observed.events[1].y - original.marker.y)).toBeLessThanOrEqual(4);

  const locate = await click(window, { target: "getByRole('button', { name: 'Ordinary button' })" });
  expect(locate, locate.text).toMatchObject({ outcome: "delivered", effect: "applied" });
  const css = await click(window, { x: 48, y: 26, space: "page" });
  expect(css, css.text).toMatchObject({ outcome: "delivered", effect: "applied" });
  const afterLegacy = await probe(window);
  expect(afterLegacy.buttons).toBe(2);
  expect(afterLegacy.events).toHaveLength(6);

  const older = await capture(window);
  const latest = await capture(window);
  expect(latest.frame.id).not.toBe(older.frame.id);
  await refused(window, older.frame.id, older.marker, "superseded frame");
  expect(await live.runner.run("curl", ["--fail", "--silent", "--show-error", "--max-time", "20", "-X", "POST", `${base}/scroll`])).toBe("done");
  await refused(window, latest.frame.id, latest.marker, "page scrolled independently of computer tools");
  const scrolled = await probe(window);
  // Chromium snaps scroll offsets to physical pixels, so 127 CSS px can become 127⅓ at DPR 1.5.
  expect(Math.abs(scrolled.scroll - 127)).toBeLessThanOrEqual(0.5 / scrolled.dpr + 0.0001);
  expect(scrolled.events).toEqual(afterLegacy.events);

  const afterScroll = await capture(window);
  const scrolledClick = await click(window, { ...afterScroll.marker, space: `frame:${afterScroll.frame.id}` });
  expect(scrolledClick, scrolledClick.text).toMatchObject({ outcome: "delivered", effect: "applied" });
  const afterScrolledClick = await probe(window);
  expect(afterScrolledClick.hits).toBe(2);
  const last = afterScrolledClick.events.at(-1)!;
  expect(last).toMatchObject({ type: "click", target: "pad", trusted: true });
  expect(Math.abs(last.y - scrolled.marker.y)).toBeLessThanOrEqual(4);

  const tab = (await live.read(window, ["dom"])).details.dom?.active;
  expect(tab).toBeTruthy();
  const beforeTab = await capture(window);
  await browser(window, { action: "new_tab", url: `${base}/other` });
  await refused(window, beforeTab.frame.id, beforeTab.marker, "different active tab");
  expect((await probe(window)).events).toEqual([]);
  await browser(window, { action: "switch_tab", tab });
  await refused(window, beforeTab.frame.id, beforeTab.marker, "returning to the original tab does not renew the frame");
  expect((await probe(window)).events).toEqual(afterScrolledClick.events);

  const beforeReload = await capture(window);
  await browser(window, { action: "reload" });
  await refused(window, beforeReload.frame.id, beforeReload.marker, "new document at the same URL");
  expect((await probe(window)).events).toEqual([]);

  // Use the second, non-maximized browser for native resize; the main browser stays on the 4K viewport.
  const other = await open(`${base}/other`);
  const otherOriginal = await probe(other);
  const beforeResize = await capture(other);
  await place(other, { action: "resize", width: 820, height: 620 });
  await refused(other, beforeResize.frame.id, beforeResize.marker, "browser resized");
  const resized = await probe(other);
  expect([resized.width, resized.height]).not.toEqual([otherOriginal.width, otherOriginal.height]);
  expect(resized.events).toEqual([]);
  const foreign = await capture(other);
  await refused(window, foreign.frame.id, foreign.marker, "frame from another browser window");
  const native = await live.read(window, ["full"]);
  expect(native.details.status, presentComputerResult(native)).toBe("observed");
  expect(native.details.page_frame).toBeUndefined();
  expect(native.details.observation_id).toBeTruthy();
  await refused(window, native.details.observation_id!, { x: 10, y: 10 }, "native overview observation id");
  expect((await probe(window)).events).toEqual([]);
});
