import { appendFile, readFile } from "node:fs/promises";
import { serveBrowserWorker } from "../../src/browser-protocol.ts";

const [source, log] = process.argv.slice(2);
const png = (await readFile(source)).toString("base64");
const pages = new Set<string>();
const record = (event: string, data: unknown = {}) => appendFile(log, JSON.stringify({ event, data }) + "\n");
serveBrowserWorker({
  async open() { pages.add("owned"); await record("open"); return "owned"; },
  async list() { await record("list"); return [...pages].map(id => ({ id, url: "https://example.test", title: "Crop fixture" })); },
  async observe() { await record("capture"); return { url: "https://example.test", title: "Crop fixture", text: "Synthetic", elements: [], png, screenshot: { width: 1200, height: 600 } }; },
  async capture() { await record("capture"); return { png, screenshot: { width: 1200, height: 600 }, documentChanged: false }; },
  async act(_id, action) { await record("input", action); },
  async closeTab(id) { pages.delete(id); await record("close-tab"); },
  async close() { pages.clear(); await record("close"); },
});
