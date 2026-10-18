import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { createViewportProofPage, validateViewportReport, assertViewportHistory } from "./fixtures/dom-viewport-proof-page.mjs";
import { closePixelProbeServer } from "./dom-native-pixel-contract.mjs";

/** Serve fixed marker geometry and retain independent bounded evidence; never launch, capture or operate a browser. */
export function createDomNativeDetailFixture(nonce, origin) {
  const url = new URL(origin);
  assert.equal(url.protocol, "http:"); assert.equal(url.hostname, "127.0.0.1");
  assert.ok(url.port && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash);
  assert.equal(origin, url.origin);
  const page = createViewportProofPage(nonce), reports = [];
  let rejected = 0, overflow = false, baseline;
  const status = () => ({ count: reports.length, rejected, capacity: 500, overflow, baseline_serial: baseline?.serial ?? null });
  return {
    status,
    reports: () => structuredClone(reports),
    /** Seal the existing setup-event prefix once; later events must not be erased or appended. */
    seal() {
      assert.ok(!baseline && reports.length > 0 && !overflow);
      baseline = structuredClone(assertViewportHistory(reports, nonce, `${origin}/`, rejected));
      return structuredClone(baseline);
    },
    async handle(request, response) {
      try {
        assert.equal(request.headers.host, url.host);
        assert.ok(!request.headers.origin || request.headers.origin === origin);
        if (request.method === "GET" && ["/", "/fixture.js", "/favicon.ico"].includes(request.url)) {
          const script = request.url === "/fixture.js";
          response.writeHead(request.url === "/favicon.ico" ? 204 : 200, {
            "Content-Type": script ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'",
          });
          response.end(request.url === "/favicon.ico" ? undefined : script ? page.script : page.html); return;
        }
        assert.equal(request.method, "POST"); assert.equal(request.url, "/witness");
        assert.equal(request.headers.origin, origin); assert.equal(request.headers["content-type"], "application/json");
        const decoder = new StringDecoder("utf8"); let text = "", bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length; assert.ok(bytes <= 16384);
          text += decoder.write(chunk);
        }
        text += decoder.end();
        if (reports.length >= 500) { overflow = true; throw Error("Witness capacity exhausted"); }
        const report = { ...validateViewportReport(JSON.parse(text), nonce, `${origin}/`), received_ms: Date.now() };
        assert.equal(report.serial, reports.length ? reports.at(-1).serial + 1 : 1);
        assertViewportHistory(reports.length ? [reports.at(-1), report] : [report], nonce, `${origin}/`, 0, baseline);
        reports.push(report); response.writeHead(204).end();
      } catch {
        rejected++; if (!response.headersSent) response.writeHead(400);
        response.end();
      }
    },
  };
}

async function main() {
  assert.deepEqual(process.argv.slice(2), ["--live-approved"]);
  const nonce = randomUUID(), directory = `.tmp/lpt-733/native-detail-${Date.now()}-${nonce}`;
  await mkdir(directory, { recursive: true });
  let fixture, stopping = false;
  const server = createServer((request, response) => {
    if (!fixture) return void response.writeHead(503).end();
    void fixture.handle(request, response).catch(error => response.destroy(error));
  });
  const input = createInterface({ input: process.stdin });
  const lines = input[Symbol.asyncIterator]();
  const stop = () => { stopping = true; input.close(); };
  const deadline = setTimeout(stop, 180000);
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  const save = () => writeFile(`${directory}/run.json`, JSON.stringify({ nonce, status: fixture?.status(), reports: fixture?.reports() }, null, 2) + "\n");
  try {
    await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); done(); }); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    fixture = createDomNativeDetailFixture(nonce, origin);
    if (stopping) throw Error("Fixture stopped during setup");
    console.log(JSON.stringify({ ready: true, directory, url: `${origin}/`, title: `Pi viewport proof ${nonce}`,
      commands: "state, seal or finish", page_scroll_ms: 60000, page_deadline_ms: 120000, server_deadline_ms: 180000 }));
    for await (const line of lines) {
      if (stopping || line.trim() === "finish") break;
      if (line.trim() === "seal") fixture.seal(); else assert.equal(line.trim(), "state");
      await save(); console.log(JSON.stringify({ directory, status: fixture.status(), latest: fixture.reports().at(-1) ?? null }));
    }
  } finally {
    stopping = true; clearTimeout(deadline); input.close();
    await closePixelProbeServer(server); await save();
    console.log(JSON.stringify({ directory, server_cleanup: "confirmed", browser_cleanup: "Close the owned ordinary computer session separately." }));
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
