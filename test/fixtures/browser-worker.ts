import { appendFile } from "node:fs/promises";
import { serveBrowserWorker } from "../../src/browser-protocol.ts";
import type { BrowserBackend, BrowserSnapshot } from "../../src/browser-session.ts";
const log = process.argv[2];
const record = (event: string) => appendFile(log, JSON.stringify({event}) + "\n");
const pages = new Map<string,string>();
const backend: BrowserBackend = {
  async open(url) { await record("open"); const id=String(pages.size); pages.set(id,url); return id; },
  async list() { return [...pages].map(([id,url])=>({id,url,title:"Synthetic browser fixture"})); },
  async observe(id): Promise<BrowserSnapshot> { return {url:pages.get(id)!,title:"Synthetic browser fixture",text:"Fixture page",
    elements:[{id:"input",role:"textbox",name:"Message"}],png:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII="}; },
  async act() { await record("input"); },
  async closeTab(id) { pages.delete(id); },
  async close() { pages.clear(); await record("close"); },
};
process.stdin.on("end",()=>{void record("stdin-eof");});
serveBrowserWorker(backend);
