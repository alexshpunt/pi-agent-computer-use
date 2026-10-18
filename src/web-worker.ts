// Windows Node worker: one visible Playwright browser with a disposable profile. EOF closes it and deletes the profile.
import readline from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Dialog, type FrameLocator, type Locator, type Page } from "playwright-core";
import type { WebAction, WebLaunchOptions, WebSnapshotOptions, WebTab, WebTarget } from "./web-browser.ts";

interface Tab { id: string; page: Page; title: string; load: WebTab["load"]; opener?: string; dialog?: Dialog; onDialog: Set<() => void> }

let context: BrowserContext | undefined;
let profile: string | undefined;
let serial = 0;
let creating = false;
const tabs: Tab[] = [];
/** The tab every page operation targets. Only open, new_tab and switch_tab change it; popups never take it implicitly. */
let active: Tab | undefined;
/** Tab and dialog events since the last snapshot, oldest first. */
let events: string[] = [];

function note(event: string): void {
  events.push(event);
  if (events.length > 50) events = ["(older events dropped)", ...events.slice(-49)];
}
const tabOf = (page: Page | null | undefined) => tabs.find(tab => tab.page === page);
const short = (text: string, max = 200) => text.length > max ? text.slice(0, max) + "…" : text;

function adopt(page: Page): Tab {
  // A fresh about:blank page has already loaded and fires no further load event.
  const tab: Tab = { id: `t${++serial}`, page, title: "", load: page.url() === "about:blank" ? "complete" : "loading", onDialog: new Set() };
  tabs.push(tab);
  page.on("domcontentloaded", () => { tab.load = "interactive"; });
  page.on("load", () => { tab.load = "complete"; page.title().then(title => { tab.title = title; }, () => undefined); });
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) tab.load = "loading"; });
  // A dialog listener stops Playwright's automatic dismissal: the dialog stays open until the agent decides.
  page.on("dialog", dialog => {
    tab.dialog = dialog;
    note(`${tab.id}: ${dialog.type()} dialog opened: "${short(dialog.message())}"`);
    for (const wake of tab.onDialog) wake();
  });
  page.on("close", () => {
    tabs.splice(tabs.indexOf(tab), 1);
    if (active === tab) active = undefined;
    note(`${tab.id}: tab closed${active ? "" : "; no tab is active, switch_tab to choose one"}`);
  });
  return tab;
}

function listTabs(): WebTab[] {
  return tabs.map(tab => ({ id: tab.id, url: tab.page.url(), title: tab.title, load: tab.load, active: tab === active,
    ...(tab.opener ? { opener: tab.opener } : {}), ...(tab.dialog ? { dialog: tab.dialog.type() } : {}) }));
}
function current(): Tab {
  if (!active) throw new Error("No tab is active. Insert {\"action\":\"switch_tab\",\"tab\":\"t1\"} with an id from the tab list; nothing was sent.");
  return active;
}
function idle(tab: Tab): Page {
  if (tab.dialog) throw new Error(`A ${tab.dialog.type()} dialog is open in ${tab.id}; handle it with {"action":"dialog","accept":true|false} first. Nothing was sent.`);
  return tab.page;
}
function byId(id: string): Tab {
  const tab = tabs.find(item => item.id === id);
  if (!tab) throw new Error(`No open tab ${id}. Nothing was sent.`);
  return tab;
}

/** Settle with the operation, or as soon as it opens a dialog in this tab; the page cannot answer until the dialog is handled. */
function untilDialog<T>(tab: Tab, operation: Promise<T>): Promise<T | "dialog"> {
  if (tab.dialog) { operation.catch(() => undefined); return Promise.resolve("dialog"); }
  let wake!: () => void;
  const opened = new Promise<"dialog">(resolve => { wake = () => resolve("dialog"); tab.onDialog.add(wake); });
  return Promise.race([operation, opened]).then(value => {
    if (value === "dialog") operation.catch(() => undefined);
    return value;
  }).finally(() => tab.onDialog.delete(wake));
}

function locate(page: Page, target: WebTarget): Locator {
  if (target.ref) return page.getByRef(target.ref);
  let root: Page | FrameLocator = page;
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

async function open({ browser, url }: WebLaunchOptions) {
  if (context) throw new Error("This worker already owns a browser.");
  profile = await mkdtemp(path.join(tmpdir(), "pi-browser-"));
  // Playwright's default flags trade browser security for test determinism; keep only what an owned pipe/profile needs.
  context = await chromium.launchPersistentContext(profile, {
    channel: browser, headless: false, chromiumSandbox: true, viewport: null, ignoreDefaultArgs: true,
    args: ["--user-data-dir=" + profile, "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check",
      "--disable-sync", "--window-size=1100,800", "about:blank"],
  });
  for (const page of context.pages()) adopt(page);
  context.on("page", page => {
    // new_tab adopts its own page and reports it as active.
    if (creating || tabOf(page)) return;
    const tab = adopt(page);
    page.opener().then(opener => {
      tab.opener = tabOf(opener)?.id;
      note(`${tab.id}: new tab opened${tab.opener ? ` by ${tab.opener}` : ""}; it is not active until switch_tab`);
    }, () => undefined);
  });
  active = tabs[0] ?? adopt(await context.newPage());
  const owner = context.browser();
  if (!owner) throw new Error("Playwright did not expose the launched browser.");
  const cdp = await owner.newBrowserCDPSession();
  const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
  await cdp.detach();
  if (url) await active.page.goto(url, { waitUntil: "domcontentloaded" });
  return { pid: processInfo.find(item => item.type === "browser")?.id, version: owner.version(), url: active.page.url(), title: await active.page.title() };
}

async function snapshot({ target, boxes, depth }: WebSnapshotOptions) {
  const base = () => ({ tabs: listTabs(), ...(active ? { active: active.id } : {}), events: events.splice(0) });
  if (!active) return { url: "", title: "", snapshot: "", ...base() };
  const tab = active, page = tab.page;
  const options = { mode: "ai" as const, boxes, depth, timeout: 10_000 };
  const text = await untilDialog(tab, target ? locate(page, target).ariaSnapshot(options) : page.ariaSnapshot(options));
  if (text !== "dialog") tab.title = await untilDialog(tab, page.title()).then(title => title === "dialog" ? tab.title : title);
  const dialog = tab.dialog && { type: tab.dialog.type(), message: short(tab.dialog.message(), 2000),
    ...(tab.dialog.type() === "prompt" ? { default_value: tab.dialog.defaultValue() } : {}) };
  return { url: page.url(), title: tab.title, snapshot: text === "dialog" ? "" : text, ...(dialog ? { dialog } : {}), ...base() };
}

async function act(action: WebAction) {
  const timeout = action.timeout_ms ?? (["navigate", "back", "forward", "reload", "new_tab", "wait_load"].includes(action.action) ? 30_000 : 5_000);
  switch (action.action) {
    case "new_tab": {
      creating = true;
      const page = await context!.newPage().finally(() => { creating = false; });
      active = adopt(page);
      note(`${active.id}: new tab opened and made active`);
      if (action.url) await page.goto(action.url, { waitUntil: "domcontentloaded", timeout });
      return snapshot({});
    }
    case "switch_tab": {
      const tab = byId(action.tab!);
      active = tab;
      await tab.page.bringToFront();
      return snapshot({});
    }
    case "close_tab": {
      const tab = action.tab ? byId(action.tab) : current();
      if (tabs.length === 1) throw new Error("This is the last tab; closing it would close the browser. Close the computer session instead. Nothing was sent.");
      await tab.page.close();
      return snapshot({});
    }
    case "dialog": {
      const tab = current(), dialog = tab.dialog;
      if (!dialog) throw new Error(`No dialog is open in ${tab.id}. Nothing was sent.`);
      tab.dialog = undefined;
      await (action.accept ? dialog.accept(action.text) : dialog.dismiss());
      note(`${tab.id}: ${dialog.type()} dialog ${action.accept ? "accepted" : "dismissed"}`);
      return snapshot({});
    }
  }
  const tab = current(), page = idle(tab);
  const target = action.target && locate(page, action.target);
  const run = async (): Promise<unknown> => {
    switch (action.action) {
      case "click": return target!.click({ button: action.button, clickCount: action.click_count, timeout });
      case "hover": return target!.hover({ timeout });
      case "fill": return target!.fill(action.text!, { timeout });
      case "type": return target!.pressSequentially(action.text!, { timeout });
      case "press": return target ? target.press(action.key!, { timeout }) : page.keyboard.press(action.key!);
      case "check": return target!.check({ timeout });
      case "uncheck": return target!.uncheck({ timeout });
      case "select": return target!.selectOption(action.values!, { timeout });
      case "focus": return target!.focus({ timeout });
      case "scroll":
        if (target) await target.hover({ timeout });
        return page.mouse.wheel(action.delta_x ?? 0, action.delta_y ?? 0);
      case "wait": return target!.waitFor({ state: action.state as "visible", timeout });
      case "wait_load": return page.waitForLoadState(action.state as "load", { timeout });
      case "navigate": return page.goto(action.url!, { waitUntil: "domcontentloaded", timeout });
      case "back": case "forward": {
        const response = await (action.action === "back" ? page.goBack({ waitUntil: "domcontentloaded", timeout }) : page.goForward({ waitUntil: "domcontentloaded", timeout }));
        if (response === null) note(`${tab.id}: ${action.action} made no new document request (no history entry or a same-document navigation)`);
        return response;
      }
      case "reload": return page.reload({ waitUntil: "domcontentloaded", timeout });
    }
  };
  if (await untilDialog(tab, run()) === "dialog") note(`${tab.id}: ${action.action} is waiting for the dialog; it may finish after the dialog is handled`);
  return snapshot({});
}

async function screenshot({ target, highlight }: { target?: WebTarget; highlight?: boolean }) {
  const tab = current(), page = idle(tab);
  let box;
  let png: Buffer;
  if (target && !highlight) png = await locate(page, target).screenshot({ timeout: 10_000 });
  else if (target) {
    // Playwright's mask overlays the element in the screenshot only; the page itself is not modified.
    const element = locate(page, target);
    box = await element.boundingBox({ timeout: 10_000 });
    if (!box) throw new Error("The element is not visible, so it cannot be highlighted.");
    png = await page.screenshot({ timeout: 10_000, mask: [element], maskColor: "rgba(255, 0, 96, 0.35)" });
  } else png = await page.screenshot({ timeout: 10_000 });
  return { url: page.url(), title: tab.title, png: png.toString("base64"), ...(box ? { box } : {}) };
}

async function close() {
  const owned = context, directory = profile;
  context = undefined; active = undefined; profile = undefined; tabs.length = 0;
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
