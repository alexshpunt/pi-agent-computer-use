import { expect, test } from "vitest";
import { BrowserRefusal, BrowserSession, type BrowserBackend, type BrowserSnapshot } from "../src/browser-session.ts";

class FocusBackend implements BrowserBackend {
  pages = new Map<string, string>();
  reads = 0;
  inputs: { id: string; target: unknown }[] = [];
  failure?: Error;
  async open(url: string) { const id = "page-" + this.pages.size; this.pages.set(id, url); return id; }
  async list() { return [...this.pages].map(([id, url]) => ({ id, url, title: id })); }
  async observe(id: string): Promise<BrowserSnapshot> {
    this.reads++;
    return { url: this.pages.get(id)!, title: id, text: "Selections: " + this.inputs.length,
      elements: ["one", "two", "three", "four"].map(name => ({ id: id + ":" + name, role: "button", name })),
      screenshot: { width: 800, height: 600 }, png: "fixture-png" };
  }
  async capture(id: string) {
    const view = await this.observe(id);
    return { png: view.png, screenshot: view.screenshot!, documentChanged: false };
  }
  async act(id: string, action: Record<string, unknown>) {
    if (this.failure) throw this.failure;
    this.inputs.push({ id, target: action.element_id });
  }
  async closeTab(id: string) { this.pages.delete(id); }
  async close() { this.pages.clear(); }
}
const hints = (result: Awaited<ReturnType<BrowserSession["open"]>>) =>
  (result.details.elements as { hint: string }[]).map(item => item.hint);

test("one focus accepts four short clicks without intermediate capture, then one explicit observe", async () => {
  const backend = new FocusBackend(); const session = new BrowserSession(backend);
  await session.open("https://example.test");
  const focused = await session.focus(1);
  const targets = hints(focused);
  expect(targets).toHaveLength(4);
  expect(new Set(targets).size).toBe(4);
  expect(targets.every(hint => /^[a-z]+$/.test(hint) && hint.length <= 3)).toBe(true);
  const initialReads = backend.reads;
  for (const hint of targets) {
    const result = await session.act({ click: hint });
    expect(result.details.status).toBe("acted");
    expect(result.content.some(block => block.type === "image")).toBe(false);
  }
  expect(backend.reads).toBe(initialReads);
  expect(backend.inputs).toEqual(["one", "two", "three", "four"].map(name => ({ id: "page-0", target: "page-0:" + name })));
  const final = await session.observe();
  expect(final.details.text).toBe("Selections: 4");
  expect(backend.reads).toBe(initialReads + 1);
  expect(final.content).toContainEqual({ type: "image", data: "fixture-png", mimeType: "image/png" });
});

test("focus changes and close-reopen never redirect an old hint to another target", async () => {
  const backend = new FocusBackend(); const session = new BrowserSession(backend);
  expect((await session.act({ click: "a" })).details.status).toBe("refused");
  await session.open("https://example.test/one");
  const first = await session.focus(1);
  const old = hints(first)[0];
  await session.open("https://example.test/two");
  const second = await session.focus(2);
  expect(hints(second)).not.toContain(old);
  expect((await session.act({ click: old })).details.status).toBe("refused");
  await session.close();
  expect((await session.observe()).details.status).toBe("refused");
  await session.open("https://example.test/new-session");
  const reopened = await session.focus(1);
  expect(hints(reopened)).not.toContain(old);
  expect((await session.act({ click: old })).details.status).toBe("refused");
  expect(backend.inputs).toEqual([]);
});

test("unknown focused input requires a fresh observation and is never replayed", async () => {
  const backend = new FocusBackend(); const session = new BrowserSession(backend);
  await session.open("https://example.test");
  const focused = await session.focus(1);
  backend.failure = new Error("Connection lost after dispatch");
  expect((await session.act({ click: hints(focused)[0] })).details.status).toBe("unknown");
  backend.failure = undefined;
  expect((await session.act({ click: hints(focused)[0] })).details.status).toBe("refused");
  await session.observe();
  backend.failure = new BrowserRefusal("Observed target was removed");
  const state = await session.observe();
  expect((await session.act({ click: hints(state)[0] })).details.status).toBe("refused");
  expect(backend.inputs).toEqual([]);
});
