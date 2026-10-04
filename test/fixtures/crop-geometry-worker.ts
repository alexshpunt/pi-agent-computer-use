import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { PlaywrightBrowser } from "../../src/browser-playwright.ts";

// Opt-in native backend contract, never an agent-facing escape hatch.
const url = process.argv[2];
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error("Expected owned synthetic fixture URL");
const backend = new PlaywrightBrowser();
const records: unknown[] = [];
try {
  const id = await backend.open(url);
  const initial = await backend.observe(id); records.push({ event: "initial", css: initial.screenshot });
  const page = (backend as unknown as { entries: Map<string, { page: Page }> }).entries.get(id)!.page;
  await page.setViewportSize({ width: 800, height: 600 });
  await assert.rejects(backend.act(id, { action: "click", x: 150, y: 370 }), /changed.*observe again/);
  records.push({ event: "resize-refused" });
  const resized = await backend.observe(id); assert.deepEqual(resized.screenshot, { width: 800, height: 600 });
  await backend.act(id, { action: "click", x: 150, y: 370 });
  assert.match((await backend.observe(id)).text, /Clicks: 1/); records.push({ event: "fresh-resize-click" });
  await page.evaluate(() => window.scrollTo(0, 200));
  await assert.rejects(backend.act(id, { action: "click", x: 150, y: 370 }), /changed.*observe again/);
  records.push({ event: "external-scroll-refused" });
  await backend.observe(id);
  await page.goto(url + "/next");
  await assert.rejects(backend.act(id, { action: "click", x: 150, y: 170 }), /Document changed/);
  records.push({ event: "external-navigation-refused" });
  await backend.observe(id); await backend.closeTab(id);
  await assert.rejects(backend.capture(id), /gone/); records.push({ event: "closed-source-refused" });
} finally { await backend.close(); }
console.log(JSON.stringify({ success: true, records }));
