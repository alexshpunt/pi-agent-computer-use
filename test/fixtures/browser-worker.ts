import { appendFile } from "node:fs/promises";
import { serveBrowserWorker } from "../../src/browser-protocol.ts";
import type { BrowserBackend, BrowserSnapshot } from "../../src/browser-session.ts";
const log = process.argv[2];
const record = (event: string, details: Record<string, unknown> = {}) => appendFile(log, JSON.stringify({ event, ...details }) + "\n");
const pages = new Map<string, string>();
let inputs = 0;
const backend: BrowserBackend = {
  async open(url) { await record("open"); const id = String(pages.size); pages.set(id, url); return id; },
  async list() { return [...pages].map(([id, url]) => ({ id, url, title: "Synthetic browser fixture" })); },
  async observe(id): Promise<BrowserSnapshot> {
    await record("observe");
    return { url: pages.get(id)!, title: "Synthetic browser fixture", text: "Selections: " + inputs,
      elements: ["one", "two", "three", "four", "fail"].map(name => ({ id: id + ":" + name, role: "button", name })),
      png: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII=" };
  },
  async capture(_id, region) {
    await record("capture", { region });
    return { png: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII=", screenshot: { width: 1, height: 1 }, documentChanged: false };
  },
  async act(id, action) {
    inputs++; await record("input", { id, target: action.element_id });
    if (String(action.element_id).endsWith(":fail")) throw new Error("Connection lost after input");
  },
  async closeTab(id) { pages.delete(id); },
  async close() { pages.clear(); await record("close"); },
};
process.stdin.on("end", () => { void record("stdin-eof"); });
serveBrowserWorker(backend);
