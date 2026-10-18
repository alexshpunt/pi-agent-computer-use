// Windows Node worker: one visible Playwright browser with a disposable profile. EOF closes it and deletes the profile.
import readline from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type FrameLocator, type Locator, type Page } from "playwright-core";
import type { WebAction, WebLaunchOptions, WebSnapshotOptions, WebTarget } from "./web-browser.ts";

let context: BrowserContext | undefined;
let profile: string | undefined;
let page: Page | undefined;

/** The newest open page is the one the browser window shows after popups and closes. */
function track(next: Page): void {
  page = next;
  next.on("close", () => { if (page === next) page = context?.pages().at(-1); });
}
function current(): Page {
  if (!page || page.isClosed()) throw new Error("The owned browser has no open page.");
  return page;
}
function locate(target: WebTarget): Locator {
  const view = current();
  if (target.ref) return view.getByRef(target.ref);
  let root: Page | FrameLocator = view;
  for (const frame of target.frames ?? []) root = root.frameLocator(frame);
  const exact = target.exact;
  const parts: Locator[] = [];
  if (target.role) parts.push(root.getByRole(target.role as Parameters<Page["getByRole"]>[0], target.name === undefined ? {} : { name: target.name, exact }));
  if (target.label !== undefined) parts.push(root.getByLabel(target.label, { exact }));
  if (target.text !== undefined) parts.push(root.getByText(target.text, { exact }));
  if (target.placeholder !== undefined) parts.push(root.getByPlaceholder(target.placeholder, { exact }));
  if (target.test_id !== undefined) parts.push(root.getByTestId(target.test_id));
  if (target.css !== undefined) parts.push(root.locator(target.css));
  return parts.reduce((all, part) => all.and(part));
}
async function describe() {
  const view = current();
  return { url: view.url(), title: await view.title() };
}

async function open({ browser, url }: WebLaunchOptions) {
  if (context) throw new Error("This worker already owns a browser.");
  profile = await mkdtemp(path.join(tmpdir(), "pi-browser-"));
  // Playwright's default flags trade browser security for test determinism; keep only what an owned pipe/profile needs.
  context = await chromium.launchPersistentContext(profile, {
    channel: browser, headless: false, chromiumSandbox: true, viewport: null, ignoreDefaultArgs: true,
    args: ["--user-data-dir=" + profile, "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check",
      "--disable-sync", "--window-size=1100,800", "about:blank"],
  });
  context.on("page", track);
  track(context.pages()[0] ?? await context.newPage());
  const owner = context.browser();
  if (!owner) throw new Error("Playwright did not expose the launched browser.");
  const cdp = await owner.newBrowserCDPSession();
  const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
  await cdp.detach();
  if (url) await current().goto(url, { waitUntil: "domcontentloaded" });
  return { pid: processInfo.find(item => item.type === "browser")?.id, version: owner.version(), ...await describe() };
}

async function snapshot({ target, boxes, depth }: WebSnapshotOptions) {
  const options = { mode: "ai" as const, boxes, depth, timeout: 10_000 };
  const text = target ? await locate(target).ariaSnapshot(options) : await current().ariaSnapshot(options);
  return { ...await describe(), snapshot: text };
}

async function act(action: WebAction) {
  const view = current();
  const timeout = action.timeout_ms ?? (action.action === "navigate" ? 30_000 : 5_000);
  const target = action.target && locate(action.target);
  switch (action.action) {
    case "click": await target!.click({ button: action.button, clickCount: action.click_count, timeout }); break;
    case "hover": await target!.hover({ timeout }); break;
    case "fill": await target!.fill(action.text!, { timeout }); break;
    case "type": await target!.pressSequentially(action.text!, { timeout }); break;
    case "press": await (target ? target.press(action.key!, { timeout }) : view.keyboard.press(action.key!)); break;
    case "check": await target!.check({ timeout }); break;
    case "uncheck": await target!.uncheck({ timeout }); break;
    case "select": await target!.selectOption(action.values!, { timeout }); break;
    case "focus": await target!.focus({ timeout }); break;
    case "scroll":
      if (target) await target.hover({ timeout });
      await view.mouse.wheel(action.delta_x ?? 0, action.delta_y ?? 0);
      break;
    case "wait": await target!.waitFor({ state: action.state, timeout }); break;
    case "navigate": await view.goto(action.url!, { waitUntil: "domcontentloaded", timeout }); break;
  }
  return snapshot({});
}

async function screenshot({ target, highlight }: { target?: WebTarget; highlight?: boolean }) {
  const view = current();
  let box;
  let png: Buffer;
  if (target && !highlight) png = await locate(target).screenshot({ timeout: 10_000 });
  else if (target) {
    // Playwright's mask overlays the element in the screenshot only; the page itself is not modified.
    const element = locate(target);
    box = await element.boundingBox({ timeout: 10_000 });
    if (!box) throw new Error("The element is not visible, so it cannot be highlighted.");
    png = await view.screenshot({ timeout: 10_000, mask: [element], maskColor: "rgba(255, 0, 96, 0.35)" });
  } else png = await view.screenshot({ timeout: 10_000 });
  return { ...await describe(), png: png.toString("base64"), ...(box ? { box } : {}) };
}

async function close() {
  const owned = context, directory = profile;
  context = undefined; page = undefined; profile = undefined;
  await owned?.close();
  if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  return {};
}

const operations: Record<string, (args: never) => Promise<unknown>> = { open, snapshot, act, screenshot, close };
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", line => {
  void (async () => {
    let id: unknown;
    try {
      const request = JSON.parse(line) as { id: unknown; op: string; args: never };
      id = request.id;
      const operation = Object.hasOwn(operations, request.op) ? operations[request.op] : undefined;
      if (!operation) throw new Error(`Unknown browser operation: ${request.op}`);
      process.stdout.write(JSON.stringify({ id, value: await operation(request.args) }) + "\n");
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      process.stdout.write(JSON.stringify({ id, error: { name: failure.name, message: failure.message } }) + "\n");
    }
  })();
});
input.on("close", () => {
  close().catch(error => {
    process.stderr.write(`Owned browser cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
});
