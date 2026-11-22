// Screenshots of the real tile page (native/tile-host/page) with made-up sessions, for a look at the layout without a
// Windows machine: a fake host bridge (window.chrome.webview) reports the sessions and the work area, a fake WebSocket
// plays each session's hub with a window list and the agent's activity, and the canvases get painted stand-in
// window content instead of decoded frames.
//
//   npx tsx test/visual/tile-page-preview.ts [out-dir]
//
// Writes <out-dir>/<display>-<windows>[-layer-<n>].png (default .tmp/tile-preview) for a 2560x1440 display and a
// 1366x768 laptop, each with a 48 px taskbar, and 1, 6 and 14 windows. CHROME names the browser (default
// /usr/bin/google-chrome).
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { chromium } from "playwright-core";

const PAGE = new URL("../../native/tile-host/page/", import.meta.url);
const OUT = process.argv[2] ?? ".tmp/tile-preview";
const DISPLAYS = { desktop: { width: 2560, height: 1440 }, laptop: { width: 1366, height: 768 } };
const TASKBAR = 48;
/** The same mix of window sizes as the layout tests: dialogs, tools and nearly maximized apps. */
const SIZES = [[1024, 738], [480, 320], [800, 600], [640, 480], [1000, 700], [400, 500], [720, 540], [300, 200]];
const APPS = ["notepad.exe", "mspaint.exe", "explorer.exe", "msedge.exe", "WindowsTerminal.exe", "charmap.exe", "calc.exe", "regedit.exe"];
const TITLES = ["notes.txt - Notepad", "Untitled - Paint", "Downloads", "Pull request #236 - Edge", "PowerShell", "Character Map", "Calculator", "Registry Editor"];

const server = createServer(async (request, response) => {
  const name = new URL(request.url ?? "/", "http://x").pathname.slice(1) || "index.html";
  try {
    const body = await readFile(new URL(name, PAGE));
    response.writeHead(200, { "content-type": name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html" });
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome" });
await mkdir(OUT, { recursive: true });

/** Windows split over sessions as agents open them: up to four sessions, the first ones with one more window. */
function sessions(count: number) {
  const sessionCount = Math.min(4, Math.ceil(count / 4) + (count > 1 ? 1 : 0));
  return Array.from({ length: sessionCount }, (_, s) => ({
    session: `is-${(0x5beb8a0d + s * 7919).toString(16)}`, agentUser: `pi-agent-${s + 1}`, created: 1_000 + s,
    windows: Array.from({ length: count }, (_, i) => i).filter(i => i % sessionCount === s).map(i => ({
      id: `w${i}`, title: TITLES[i % TITLES.length], app: APPS[i % APPS.length], pid: 100 + i, state: "normal", kind: "standard", focused: false, onScreen: true, z: i,
      bounds: { x: 0, y: 0, width: SIZES[i % SIZES.length][0], height: SIZES[i % SIZES.length][1] } })),
  }));
}

try {
  for (const [display, size] of Object.entries(DISPLAYS)) for (const count of [1, 6, 14]) {
    const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
    const list = sessions(count);
    // A string, not a function: tsx would add helpers to a function's source that the page does not have.
    await page.addInitScript({ content: `(${String.raw`list => {
      const w = window;
      w.__posted = [];
      w.chrome = { webview: { postMessage: m => w.__posted.push(m), addEventListener: (_, f) => { w.__host = f; } } };
      const windows = new Map(list.map(s => [s.session, s.windows]));
      // A hub that says hello with the session's windows; the agent acts in its first window.
      w.WebSocket = class {
        static OPEN = 1;
        readyState = 1;
        constructor(url) {
          const session = new URL(url).pathname.slice(1);
          setTimeout(() => {
            const first = windows.get(session)[0];
            this.onmessage?.({ data: JSON.stringify({ type: "hello", windows: windows.get(session) }) });
            if (first) this.onmessage?.({ data: JSON.stringify({ type: "activity", window: first.id, action: "click", point: { x: first.bounds.width * 0.4, y: first.bounds.height * 0.5 } }) });
          }, 10);
        }
        send() {}
        close() {}
      };
    }`})(${JSON.stringify(list)});` });
    await page.goto(`${base}index.html`);
    await page.addStyleTag({ content: "html { background: radial-gradient(circle at 30% 20%, #3b5d7a, #182533 60%, #0d1218); }" });
    await page.evaluate(({ list, size, taskbar }) => {
      const host = (window as any).__host;
      host({ data: { type: "layout", mode: "desktop", workArea: { x: 0, y: 0, width: size.width, height: size.height - taskbar } } });
      host({ data: { type: "sessions", sessions: list.map(s => ({ session: s.session, url: `ws://127.0.0.1:1/${s.session}`, token: "t", agentUser: s.agentUser, created: s.created })),
        hotkeys: { overlay: "Ctrl+Alt+Space", nextLayer: "Ctrl+Alt+PageDown", previousLayer: "Ctrl+Alt+PageUp" } } });
    }, { list, size, taskbar: TASKBAR });
    const layers = await page.evaluate(async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      const line = (window as any).__posted.map((m: { message?: string }) => m.message ?? "").findLast((m: string) => m.startsWith("layout:"));
      return Number(/in (\d+) layer/.exec(line ?? "")?.[1] ?? 1);
    });
    for (let layer = 0; layer < layers; layer++) {
      if (layer) await page.evaluate(() => (window as any).__host({ data: { type: "layer", step: 1 } }));
      // Stand-in window content: a title bar, a body and the title, painted where decoded frames would go.
      await page.evaluate(async () => {
        await new Promise(resolve => setTimeout(resolve, 400));
        for (const tile of document.querySelectorAll<HTMLElement>(".tile:not([hidden])")) {
          const canvas = tile.querySelector("canvas")!, g = canvas.getContext("2d")!;
          const { width, height } = canvas;
          g.fillStyle = "#f3f3f3"; g.fillRect(0, 0, width, height);
          g.fillStyle = "#ffffff"; g.fillRect(0, 0, width, Math.max(12, height * 0.06));
          g.fillStyle = "#d0d4da"; for (let y = height * 0.12; y < height * 0.9; y += Math.max(8, height * 0.05)) g.fillRect(width * 0.05, y, width * (0.4 + ((y * 7) % 50) / 100), Math.max(2, height * 0.015));
          g.fillStyle = "#333"; g.font = `${Math.max(9, Math.round(height * 0.035))}px Segoe UI, sans-serif`;
          g.fillText(tile.querySelector(".title")!.textContent!, width * 0.03, Math.max(10, height * 0.045));
          tile.classList.add("live");
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      });
      const file = path.join(OUT, `${display}-${count}${layers > 1 ? `-layer-${layer + 1}` : ""}.png`);
      await page.screenshot({ path: file });
      console.log(file);
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
