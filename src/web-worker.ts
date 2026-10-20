// Windows Node worker: one visible Playwright browser with a disposable profile, or the agent's persistent one.
// EOF closes it and deletes a disposable profile.
import readline from "node:readline";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Dialog, type Download, type FrameLocator, type Locator, type Page } from "playwright-core";
import type { WebAction, WebDownload, WebEvaluation, WebLaunchOptions, WebLogEntry, WebSnapshotOptions, WebTab, WebTarget } from "./web-browser.ts";
import type { ConditionResult, UiCondition } from "./ui-conditions.ts";

interface Tab { id: string; page: Page; title: string; load: WebTab["load"]; opener?: string; dialog?: Dialog; onDialog: Set<() => void> }
interface DownloadRecord { info: WebDownload; download: Download; done: Promise<void> }

let context: BrowserContext | undefined;
let profile: string | undefined;
let serial = 0;
let creating = false;
const tabs: Tab[] = [];
/** The tab every page operation targets. Only open, new_tab and switch_tab change it; popups never take it implicitly. */
let active: Tab | undefined;
/** Tab and dialog events since the last snapshot, oldest first. */
let events: string[] = [];
/** Downloads of this browser. Playwright keeps their files in its temporary directory and deletes them when the browser closes. */
const downloads: DownloadRecord[] = [];
/** Console, page-error and network log of every tab, oldest first; at most LOG_LIMIT entries are retained. */
const log: WebLogEntry[] = [];
const LOG_LIMIT = 200, LOG_SHOWN = 30;
let logSeq = 0;
/** Highest seq already shown in a snapshot. */
let logShown = 0;

function record(tab: Tab, entry: Omit<WebLogEntry, "seq" | "at" | "tab">): void {
  log.push({ seq: ++logSeq, at: new Date().toISOString(), tab: tab.id, ...entry, text: short(entry.text, 1000), ...(entry.url ? { url: short(entry.url, 500) } : {}) });
  if (log.length > LOG_LIMIT) log.shift();
}
/** Console logs, info and debug stay in the history; snapshots show what usually needs attention. */
const notable = (entry: WebLogEntry) => entry.kind !== "console" || entry.level === "error" || entry.level === "warning" || entry.level === "assert";

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
  page.on("download", download => track(tab, download));
  page.on("console", message => record(tab, { kind: "console", level: message.type(), text: message.text(), url: message.location().url || undefined }));
  page.on("pageerror", error => record(tab, { kind: "page_error", level: "error", text: error.stack ?? error.message }));
  page.on("requestfailed", request => record(tab, { kind: "request_failed", level: request.method(), text: request.failure()?.errorText ?? "failed", url: request.url() }));
  page.on("response", response => {
    if (response.status() >= 400) record(tab, { kind: "http_error", level: response.request().method(), text: `${response.status()} ${response.statusText()}`.trim(), url: response.url(), status: response.status() });
  });
  page.on("close", () => {
    tabs.splice(tabs.indexOf(tab), 1);
    if (active === tab) active = undefined;
    note(`${tab.id}: tab closed${active ? "" : "; no tab is active, switch_tab to choose one"}`);
  });
  return tab;
}

function track(tab: Tab, download: Download): void {
  const info: WebDownload = { id: `d${downloads.length + 1}`, tab: tab.id, url: download.url(), filename: download.suggestedFilename(), state: "in_progress" };
  note(`${info.id}: download of "${short(info.filename)}" started in ${tab.id}`);
  const done = download.path().then(async file => {
    info.state = "completed"; info.path = file; info.bytes = (await stat(file)).size;
    note(`${info.id}: download completed (${info.bytes} bytes)`);
  }, async () => {
    const failure = await download.failure().catch(() => null);
    info.state = failure === "canceled" ? "canceled" : "failed";
    if (failure && failure !== "canceled") info.error = short(failure);
    note(`${info.id}: download ${info.state}${info.error ? `: ${info.error}` : ""}`);
  });
  downloads.push({ info, download, done });
}
function downloadOf(id: string | undefined): DownloadRecord {
  const record = id ? downloads.find(item => item.info.id === id) : downloads.at(-1);
  if (!record) throw new Error(id ? `No download ${id}. Nothing was sent.` : "No download has started in this browser. Nothing was sent.");
  return record;
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

async function open({ browser, url, profile: kind }: WebLaunchOptions) {
  if (context) throw new Error("This worker already owns a browser.");
  // The agent's persistent profile lives in its own folder per browser and is kept on close; a disposable one is deleted.
  const directory = kind === "agent"
    ? path.join(process.env.LOCALAPPDATA ?? tmpdir(), "PiComputerUse", "browser-profiles", browser ?? "chrome")
    : profile = await mkdtemp(path.join(tmpdir(), "pi-browser-"));
  if (kind === "agent") await mkdir(directory, { recursive: true });
  // Playwright's default flags trade browser security for test determinism; keep only what an owned pipe/profile needs.
  context = await chromium.launchPersistentContext(directory, {
    channel: browser, headless: false, chromiumSandbox: true, viewport: null, ignoreDefaultArgs: true,
    args: ["--user-data-dir=" + directory, "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check",
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

function logSince() {
  const fresh = log.filter(entry => entry.seq > logShown && notable(entry));
  logShown = logSeq;
  return fresh.length ? { log: { entries: fresh.slice(0, LOG_SHOWN), omitted: Math.max(0, fresh.length - LOG_SHOWN) } } : {};
}

async function snapshot({ target, boxes, depth, log: wantLog }: WebSnapshotOptions, evaluation?: WebEvaluation) {
  const base = () => ({ tabs: listTabs(), ...(active ? { active: active.id } : {}), events: events.splice(0),
    ...(downloads.length ? { downloads: downloads.map(item => ({ ...item.info })) } : {}), ...logSince(),
    ...(wantLog ? { history: { entries: [...log], first_seq: log[0]?.seq ?? logSeq + 1, dropped: Math.max(0, logSeq - log.length) } } : {}),
    ...(evaluation ? { evaluation } : {}) });
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
  const timeout = action.timeout_ms ?? (["navigate", "back", "forward", "reload", "new_tab", "wait_load", "wait_download", "upload", "evaluate"].includes(action.action) ? 30_000 : 5_000);
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
    case "wait_download": {
      const record = downloadOf(action.download);
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<"late">(resolve => { timer = setTimeout(() => resolve("late"), timeout); });
      // Waiting has no side effect: an unfinished download is reported in the snapshot, not as an uncertain action.
      if (await Promise.race([record.done, late]) === "late") note(`${record.info.id}: still ${record.info.state} after ${timeout} ms`);
      clearTimeout(timer);
      return snapshot({});
    }
    case "cancel_download": {
      const record = downloadOf(action.download);
      if (record.info.state !== "in_progress") throw new Error(`Download ${record.info.id} is already ${record.info.state}. Nothing was sent.`);
      await record.download.cancel();
      await record.done;
      return snapshot({});
    }
    case "evaluate": {
      const tab = current(), page = idle(tab);
      // Resolve the element first: a missing or ambiguous target is a refusal, because no page code has run yet.
      const element = action.target ? await locate(page, action.target).elementHandle({ timeout: Math.min(timeout, 5_000) }).catch((error: Error) => {
        throw new Error(`The evaluate target did not resolve to one element; nothing ran. ${error.message}`);
      }) : undefined;
      // Evaluate the source in the page; if it yields a function, call it with the target element (or nothing).
      // Playwright serializes these callbacks by source text, so each must be self-contained.
      const run = element
        ? element.evaluate((el, source) => { const value = (0, eval)(source); return typeof value === "function" ? value(el) : value; }, action.expression!)
          .finally(() => element.dispose())
        : page.evaluate(source => { const value = (0, eval)(source); return typeof value === "function" ? value() : value; }, action.expression!);
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`evaluate did not finish within ${timeout} ms; it may still be running in the page.`), { name: "TimeoutError" })), timeout); });
      let evaluation: WebEvaluation;
      try {
        const settled = await untilDialog(tab, Promise.race([run, late]));
        if (settled === "dialog") evaluation = { error: "The code opened a dialog; it continues after the dialog is handled." };
        else {
          const json = JSON.stringify(settled) ?? "undefined";
          evaluation = json.length > 20_000 ? { value: json.slice(0, 20_000), truncated: true } : { value: json };
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        // Playwright locator timeouts and the overall time limit stay uncertain; an exception thrown by page code is its result.
        if (failure.name === "TimeoutError") throw failure;
        // Keep the page's own error line, without Playwright's call prefix and its internal stack frames.
        evaluation = { error: short(failure.message.split("\n")[0].replace(/^\w+\.evaluate: /, ""), 2000) };
      } finally { clearTimeout(timer); }
      return snapshot({}, evaluation);
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
      case "upload": {
        if (!action.chooser) return target!.setInputFiles(action.files!, { timeout });
        // Intercepting the chooser keeps the native file dialog closed; the page receives the files as if picked there.
        const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout }), target!.click({ timeout })]);
        return chooser.setFiles(action.files!, { timeout });
      }
    }
  };
  if (await untilDialog(tab, run()) === "dialog") note(`${tab.id}: ${action.action} is waiting for the dialog; it may finish after the dialog is handled`);
  return snapshot({});
}

/** Sample conditions once in the active tab. Reads only: no input, no waiting for actionability. */
async function check({ conditions }: { conditions: UiCondition[] }): Promise<ConditionResult[]> {
  const tab = current();
  if (tab.dialog) return conditions.map((_, index) => ({ index, verdict: "unknown" as const, reason: `A ${tab.dialog!.type()} dialog is open in ${tab.id}.` }));
  const page = tab.page;
  return Promise.all(conditions.map(async (condition, index): Promise<ConditionResult> => {
    try {
      if (!condition.target) {
        const observed = condition.title !== undefined ? await page.title() : page.url();
        const ok = condition.title !== undefined ? observed === condition.title : observed.includes(condition.url_contains!);
        return { index, verdict: ok ? "satisfied" : "unsatisfied", observed };
      }
      const locator = locate(page, condition.target as WebTarget);
      const count = await locator.count();
      if (condition.is === "absent") return { index, verdict: count === 0 ? "satisfied" : "unsatisfied", observed: `${count} match(es)` };
      if (condition.is === "hidden" && count === 0) return { index, verdict: "satisfied", observed: "no match" };
      if (count === 0) return { index, verdict: "unsatisfied", observed: "no match" };
      if (count > 1) return { index, verdict: "unknown", reason: `${count} elements match; narrow the target.` };
      const flag = async (read: () => Promise<boolean>, want: boolean): Promise<ConditionResult> => {
        const value = await read();
        return { index, verdict: value === want ? "satisfied" : "unsatisfied", observed: String(value) };
      };
      switch (condition.is) {
        case "exists": return { index, verdict: "satisfied", observed: "1 match" };
        case "visible": return flag(() => locator.isVisible(), true);
        case "hidden": return flag(() => locator.isVisible(), false);
        case "enabled": return flag(() => locator.isEnabled({ timeout: 1000 }), true);
        case "disabled": return flag(() => locator.isEnabled({ timeout: 1000 }), false);
        case "checked": return flag(() => locator.isChecked({ timeout: 1000 }), true);
        case "unchecked": return flag(() => locator.isChecked({ timeout: 1000 }), false);
        case "selected": return flag(() => locator.evaluate(el => (el as HTMLOptionElement).selected === true || el.getAttribute("aria-selected") === "true"), true);
        case "focused": return flag(() => locator.evaluate(el => el === el.ownerDocument.activeElement), true);
      }
      // Form fields compare their value; other elements their visible text.
      const observed = await locator.evaluate(el => "value" in el && typeof (el as HTMLInputElement).value === "string" && el.tagName !== "BUTTON"
        ? (el as HTMLInputElement).value : (el as HTMLElement).innerText ?? el.textContent ?? "");
      const ok = condition.value !== undefined ? observed.trim() === condition.value : observed.includes(condition.contains!);
      return { index, verdict: ok ? "satisfied" : "unsatisfied", observed: short(observed, 500) };
    } catch (error) {
      return { index, verdict: "unknown", reason: short(error instanceof Error ? error.message.split("\n")[0] : String(error), 300) };
    }
  }));
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
  context = undefined; active = undefined; profile = undefined; tabs.length = 0; downloads.length = 0; log.length = 0;
  await owned?.close();
  if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  return {};
}

const operations: Record<string, (args: never) => Promise<unknown>> = { open, snapshot, act, check, screenshot, close };
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
