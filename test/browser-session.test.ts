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

test("failure to observe after completed input is unknown, not a pre-input refusal", async () => {
  const backend = new Backend(); const session = new BrowserSession(backend);
  const opened = await session.open("https://example.test");
  backend.observe = async () => { throw new BrowserRefusal("Page closed while observing"); };
  const result = await session.act({ page_ref: field(opened, "page_ref"), observation_id: field(opened, "observation_id"),
    action: "fill", element_ref: element(opened), text: "written" });
  expect(result.details.status).toBe("unknown");
  expect(backend.calls).toEqual(["native-0:fill"]);
});