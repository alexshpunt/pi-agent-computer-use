import { appendFile, readFile } from "node:fs/promises";
import { serveBrowserWorker } from "../../src/browser-protocol.ts";

const [sourcePath, log] = process.argv.slice(2);
const png = (await readFile(sourcePath)).toString("base64");
const pages = new Set<string>();
const backend = {
  async open() { pages.add("owned"); return "owned"; },
  async list() { return [...pages].map(id => ({ id, url: "https://example.test", title: "Size fixture" })); },
  async observe() { return { url: "https://example.test", title: "Size fixture", text: "Synthetic pixels", png,
    elements: [], screenshot: { width: 1200, height: 600 } }; },
  async capture() { return { png, screenshot: { width: 1200, height: 600 }, documentChanged: false }; },
  async act(_id: string, action: Record<string, unknown>) { await appendFile(log, JSON.stringify(action) + "\n"); },
  async closeTab(id: string) { pages.delete(id); },
  async close() { pages.clear(); },
};
serveBrowserWorker(backend);
