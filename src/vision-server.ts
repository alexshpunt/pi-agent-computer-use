import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { VisionTrace } from "./vision-trace.ts";
import { visionPanel, visionScript, visionStyle } from "./vision-panel.ts";

/** A loopback-only, read-only server with an unguessable session route. */
export interface VisionServer { url: string; close(): Promise<void> }

/** Start explicitly from a session/command, never from an extension factory. */
export async function startVisionServer(trace: VisionTrace): Promise<VisionServer> {
  const token = randomBytes(24).toString("hex");
  let origin = "";
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) {
      response.writeHead(403).end("Foreign host or origin."); return;
    }
    if (!["GET", "HEAD"].includes(request.method ?? "")) { response.writeHead(405).end("Read-only viewer."); return; }
    const url = new URL(request.url ?? "/", origin);
    const base = `/${token}/`;
    if (!url.pathname.startsWith(base)) { response.writeHead(404).end("Not found."); return; }
    const route = url.pathname.slice(base.length);
    let body: string | Buffer | undefined;
    let mime = "text/plain; charset=utf-8";
    if (route === "") { body = visionPanel; mime = "text/html; charset=utf-8"; }
    else if (route === "panel.js") { body = visionScript; mime = "text/javascript; charset=utf-8"; }
    else if (route === "style.css") { body = visionStyle; mime = "text/css; charset=utf-8"; }
    else if (route === "state") { body = JSON.stringify(trace.snapshot()); mime = "application/json"; }
    else if (/^images\/[a-f0-9]{64}$/.test(route)) {
      const hash = route.slice(7); body = trace.asset(hash); mime = trace.assetMime(hash) ?? mime;
    }
    if (body === undefined) { response.writeHead(404).end("Not retained in this session."); return; }
    response.setHeader("Content-Type", mime);
    response.end(request.method === "HEAD" ? undefined : body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("No loopback server address."); }
  origin = `http://127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  return { url: `${origin}/${token}/`, close: () => closing ??= new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }) };
}
