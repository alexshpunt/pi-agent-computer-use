import { expect, test } from "vitest";
import { BrowserRefusal, BrowserSession, type BrowserAction, type BrowserBackend, type BrowserSnapshot } from "../src/browser-session.ts";

class Backend implements BrowserBackend {
  pages = new Map<string, string>();
  calls: string[] = [];
  failed = false;
  async open(url: string) { const id = "native-" + this.pages.size; this.pages.set(id, url); return id; }
  async list() { return [...this.pages].map(([id, url]) => ({ id, url, title: "Fixture" })); }
  async observe(id: string): Promise<BrowserSnapshot> {
    return { url: this.pages.get(id)!, title: "Fixture", text: "Message", elements: [{ id: "input-1", role: "textbox", name: "Message" }],
      screenshot: { width: 800, height: 600 }, png: "fixture-png" };
  }
  async act(id: string, action: Record<string, unknown>) {
    this.calls.push(id + ":" + action.action);
    if (this.failed) throw new Error("connection lost after dispatch");
    if (action.action === "navigate") this.pages.set(id, String(action.url));
  }
  async closeTab(id: string) { this.pages.delete(id); }
  async close() { this.pages.clear(); }
}
const element = (result: Awaited<ReturnType<BrowserSession["open"]>>) =>
  (result.details.elements as { hint: string }[])[0].hint;

test("opening focuses the page with original PNG; explicit observe after input retires hints", async () => {
  const backend = new Backend(); const session = new BrowserSession(backend);
  const opened = await session.open("https://example.test");
  expect(opened.details).toMatchObject({ status: "observed", tab: 1 });
  expect(opened.content).toContainEqual({ type: "image", data: "fixture-png", mimeType: "image/png" });
  const changed = await session.act({ fill: element(opened), text: "new value", observe: true });
  expect(changed.details.status).toBe("observed");
  expect(element(changed)).not.toBe(element(opened));
  expect((await session.act({ click: element(opened) })).details.status).toBe("refused");
  expect(backend.calls).toEqual(["native-0:fill"]);
});

test("a closed focused tab loses input even if the backend later reuses its ID", async () => {
  const backend = new Backend(); const session = new BrowserSession(backend);
  const first = await session.open("https://example.test");
  await session.act({ close_tab: true });
  const next = await session.open("https://example.test");
  expect(element(next)).not.toBe(element(first));
  expect((await session.act({ fill: element(first), text: "blocked" })).details.status).toBe("refused");
  backend.pages.clear();
  expect((await session.act({ fill: element(next), text: "blocked" })).details.status).toBe("refused");
  expect(backend.calls).toEqual([]);
});

test("invalid navigation and pre-dispatch cancellation do not write; unknown input is never replayed", async () => {
  const backend = new Backend(); const session = new BrowserSession(backend);
  expect((await session.open("file:///C:/real-document")).details.status).toBe("refused");
  expect(backend.pages.size).toBe(0);
  const first = await session.open("https://example.test");
  const request = { fill: element(first), text: "once" };
  expect((await session.act({ navigate: "https://user:pass@example.test" })).details.status).toBe("refused");
  expect((await session.act(request, AbortSignal.abort())).details.status).toBe("refused");
  backend.failed = true;
  expect((await session.act(request)).details.status).toBe("unknown");
  expect((await session.act(request)).details.status).toBe("refused");
  expect(backend.calls).toEqual(["native-0:fill"]);
});

test("coordinate clicks need a complete bounded point and a new image after any input", async () => {
  const backend = new Backend(); const session = new BrowserSession(backend);
  const opened = await session.open("https://example.test");
  for (const click of [{ x: 800, y: 10 }, { x: 10, y: 600 }, { x: -1, y: 10 }, { x: NaN, y: 10 }, { x: 10 }, { x: 10, y: 20, extra: true }])
    expect((await session.act({ click } as BrowserAction)).details.status).toBe("refused");
  expect((await session.act({ click: element(opened), fill: element(opened), text: "mixed" })).details.status).toBe("refused");
  expect(backend.calls).toEqual([]);
  expect((await session.act({ click: { x: 120, y: 140 } })).details.status).toBe("acted");
  expect((await session.act({ click: { x: 120, y: 140 } })).details.status).toBe("refused");
  expect(backend.calls).toEqual(["native-0:click"]);
});

test("open capture retries once, never duplicates navigation, and keeps known focus after capture failure", async () => {
  const backend = new Backend(); const session = new BrowserSession(backend);
  const original = backend.observe.bind(backend); let reads = 0;
  backend.observe = async id => { if (++reads === 1) throw new BrowserRefusal("Page navigated during observation"); return original(id); };
  expect((await session.open("https://example.test")).details.status).toBe("observed");
  expect(reads).toBe(2); expect(backend.pages.size).toBe(1);
  backend.observe = async () => { throw new BrowserRefusal("Page keeps changing"); };
  const unknown = await session.open("https://example.test/two");
  expect(unknown.details).toMatchObject({ status: "unknown", tab: 2 });
  backend.observe = original;
  expect((await session.observe()).details.status).toBe("observed");
  expect(backend.pages.size).toBe(2);
});

test("optional wait plus explicit capture sees delayed change; invalid waits refuse before input", async () => {
  const backend = new Backend(); const session = new BrowserSession(backend); let settled = false;
  const original = backend.observe.bind(backend);
  backend.observe = async id => ({ ...await original(id), text: settled ? "Ready" : "Loading" });
  backend.act = async () => { backend.calls.push("click"); setTimeout(() => { settled = true; }, 5); };
  const opened = await session.open("https://example.test");
  const request = { click: element(opened) };
  for (const wait_ms of [-1, 5001, NaN, 1.5]) expect((await session.act({ ...request, wait_ms })).details.status).toBe("refused");
  expect(backend.calls).toEqual([]);
  const result = await session.act({ ...request, wait_ms: 20, observe: true });
  expect(result.details.text).toBe("Ready"); expect(backend.calls).toEqual(["click"]);
});

test("failed capture after completed input is unknown, not a pre-input refusal", async () => {
  const backend = new Backend(); const session = new BrowserSession(backend);
  const opened = await session.open("https://example.test");
  backend.observe = async () => { throw new BrowserRefusal("Page closed while observing"); };
  const result = await session.act({ fill: element(opened), text: "written", observe: true });
  expect(result.details.status).toBe("unknown");
  expect(backend.calls).toEqual(["native-0:fill"]);
});

test("navigation and scrolling require observation before further hints", async () => {
  const backend = new Backend(); const session = new BrowserSession(backend);
  const opened = await session.open("https://example.test");
  expect((await session.act({ scroll: 100 })).details).toMatchObject({ status: "acted", needs_observe: true });
  expect((await session.act({ click: element(opened) })).details.status).toBe("refused");
  await session.observe();
  expect((await session.act({ navigate: "https://example.test/next" })).details.status).toBe("acted");
  expect((await session.act({ click: element(opened) })).details.status).toBe("refused");
  expect((await session.observe()).details.url).toBe("https://example.test/next");
});
