import { expect, test } from "vitest";
import { BrowserRefusal, BrowserSession, type BrowserBackend, type BrowserSnapshot } from "../src/browser-session.ts";

class Backend implements BrowserBackend {
  pages = new Map<string, string>();
  calls: string[] = [];
  failed = false;
  async open(url: string) { const id = "native-" + this.pages.size; this.pages.set(id, url); return id; }
  async list() { return [...this.pages].map(([id, url]) => ({ id, url, title: "Fixture" })); }
  async observe(id: string): Promise<BrowserSnapshot> {
    return { url: this.pages.get(id)!, title: "Fixture", text: "Message", elements: [{ id: "input-1", role: "textbox", name: "Message" }],
      png: "fixture-png" };
  }
  async act(id: string, action: Record<string, unknown>) {
    this.calls.push(id + ":" + action.action);
    if (this.failed) throw new Error("connection lost after dispatch");
    if (action.action === "navigate") this.pages.set(id, String(action.url));
  }
  async closeTab(id: string) { this.pages.delete(id); }
  async close() { this.pages.clear(); }
}
const field = (result: Awaited<ReturnType<BrowserSession["open"]>>, key: string) => String(result.details[key]);
const element = (result: Awaited<ReturnType<BrowserSession["open"]>>) =>
  (result.details.elements as { element_ref: string }[])[0].element_ref;

test("opening returns a scoped page, observation and original PNG; an action returns fresh state", async () => {
  const backend = new Backend(); const session = new BrowserSession(backend);
  const opened = await session.open("https://example.test");
  expect(opened.details.status).toBe("observed");
  expect(opened.content).toContainEqual({ type: "image", data: "fixture-png", mimeType: "image/png" });
  const changed = await session.act({ page_ref: field(opened, "page_ref"), observation_id: field(opened, "observation_id"),
    action: "fill", element_ref: element(opened), text: "new value" });
  expect(changed.details.status).toBe("observed");
  expect(changed.details.observation_id).not.toBe(opened.details.observation_id);
  expect(backend.calls).toEqual(["native-0:fill"]);
});

test("foreign pages and stale or cross-page observations refuse before input", async () => {
  const backend = new Backend(); const session = new BrowserSession(backend);
  const first = await session.open("https://example.test/one");
  const second = await session.open("https://example.test/two");
  const request = { page_ref: field(first, "page_ref"), observation_id: field(first, "observation_id"), action: "fill" as const,
    element_ref: element(first), text: "blocked" };
  expect((await session.act({ ...request, page_ref: "foreign" })).details.status).toBe("refused");
  expect((await session.act({ ...request, page_ref: field(second, "page_ref") })).details.status).toBe("refused");
  await session.observe(field(first, "page_ref"));
  expect((await session.act(request)).details.status).toBe("refused");
  expect(backend.calls).toEqual([]);
});

test("closed tabs and an old session cannot receive input, even if the backend reuses a native ID", async () => {
  const backend = new Backend(); const session = new BrowserSession(backend);
  const first = await session.open("https://example.test");
  await session.close();
  const next = await session.open("https://example.test");
  expect(next.details.page_ref).not.toBe(first.details.page_ref);
  expect((await session.observe(field(first, "page_ref"))).details.status).toBe("refused");
  backend.pages.clear();
  expect((await session.act({ page_ref: field(next, "page_ref"), observation_id: field(next, "observation_id"),
    action: "fill", element_ref: element(next), text: "blocked" })).details.status).toBe("refused");
  expect(backend.calls).toEqual([]);
});

test("invalid navigation and pre-dispatch cancellation do not write; unknown input is never replayed", async () => {
  const backend = new Backend(); const session = new BrowserSession(backend);
  expect((await session.open("file:///C:/real-document")).details.status).toBe("refused");
  expect(backend.pages.size).toBe(0);
  const first = await session.open("https://example.test");
  const request = { page_ref: field(first, "page_ref"), observation_id: field(first, "observation_id"), action: "fill" as const,
    element_ref: element(first), text: "once" };
  expect((await session.act(request, AbortSignal.abort())).details.status).toBe("refused");
  backend.failed = true;
  expect((await session.act(request)).details.status).toBe("unknown");
  expect((await session.act(request)).details.status).toBe("refused");
  expect(backend.calls).toEqual(["native-0:fill"]);
});

test("screenshot clicks need a complete in-bounds point, not an element, and cannot replay", async () => {
  const backend = new Backend(); const session = new BrowserSession(backend);
  const original = backend.observe.bind(backend);
  backend.observe = async id => ({ ...await original(id), screenshot: { width: 800, height: 600 } });
  const opened = await session.open("https://example.test");
  const request = { page_ref: field(opened, "page_ref"), observation_id: field(opened, "observation_id"), action: "click" as const };
  for (const point of [{ x: 800, y: 10 }, { x: 10, y: 600 }, { x: -1, y: 10 }, { x: NaN, y: 10 },
    { x: 10 }, { x: 10, y: 20, element_ref: element(opened) }]) {
    expect((await session.act({ ...request, ...point })).details.status).toBe("refused");
  }
  expect(backend.calls).toEqual([]);
  expect(opened.details.screenshot).toEqual({ width: 800, height: 600 });
  const changed = await session.act({ ...request, x: 120, y: 140 });
  expect(changed.details.status).toBe("observed");
  expect((await session.act({ ...request, x: 120, y: 140 })).details.status).toBe("refused");
  expect(backend.calls).toEqual(["native-0:click"]);
});

test("open retries a failed capture once without opening another tab, then preserves a known ref on failure", async () => {
  const backend = new Backend(); const session = new BrowserSession(backend);
  const original = backend.observe.bind(backend);
  let reads = 0;
  backend.observe = async id => {
    if (++reads === 1) throw new BrowserRefusal("Page navigated during observation");
    return original(id);
  };
  const opened = await session.open("https://example.test");
  expect(opened.details.status).toBe("observed");
  expect(reads).toBe(2); expect(backend.pages.size).toBe(1);
  backend.observe = async () => { throw new BrowserRefusal("Page keeps changing"); };
  const unknown = await session.open("https://example.test/two");
  expect(unknown.details.status).toBe("unknown");
  expect(unknown.details.page_ref).toEqual(expect.any(String));
  expect(unknown.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(String(unknown.details.page_ref)) });
  backend.observe = original;
  expect((await session.observe(field(unknown, "page_ref"))).details.status).toBe("observed");
  expect(backend.pages.size).toBe(2);
});

test("optional wait captures a delayed change once; invalid waits refuse before input", async () => {
  const backend = new Backend(); const session = new BrowserSession(backend);
  let settled = false;
  const original = backend.observe.bind(backend);
  backend.observe = async id => ({ ...await original(id), text: settled ? "Ready" : "Loading" });
  backend.act = async () => { backend.calls.push("click"); setTimeout(() => { settled = true; }, 5); };
  const opened = await session.open("https://example.test");
  const request = { page_ref: field(opened, "page_ref"), observation_id: field(opened, "observation_id"),
    action: "click" as const, element_ref: element(opened) };
  for (const wait_ms of [-1, 5001, NaN, 1.5])
    expect((await session.act({ ...request, wait_ms })).details.status).toBe("refused");
  expect(backend.calls).toEqual([]);
  const result = await session.act({ ...request, wait_ms: 20 });
  expect(result.details.text).toBe("Ready"); expect(backend.calls).toEqual(["click"]);
  expect((await session.act({ ...request, wait_ms: 20 })).details.status).toBe("refused");
});

test("failure to observe after completed input is unknown, not a pre-input refusal", async () => {
  const backend = new Backend(); const session = new BrowserSession(backend);
  const opened = await session.open("https://example.test");
  backend.observe = async () => { throw new BrowserRefusal("Page closed while observing"); };
  const result = await session.act({ page_ref: field(opened, "page_ref"), observation_id: field(opened, "observation_id"),
    action: "fill", element_ref: element(opened), text: "written" });
  expect(result.details.status).toBe("unknown");
  expect(backend.calls).toEqual(["native-0:fill"]);
});