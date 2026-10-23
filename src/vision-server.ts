import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { VisionTrace } from "./vision-trace.ts";
import { CuaImageSettings } from "./cua-image-settings.ts";
import { visionPanel, visionScript, visionStyle } from "./vision-panel.ts";

/** A private loopback viewer with bounded native capture settings. */
export interface VisionServer { url: string; close(): Promise<void> }

/** Start from a session/command. Settings affect following captures, not historical frames. */
export async function startVisionServer(trace: VisionTrace, images: CuaImageSettings = new CuaImageSettings()): Promise<VisionServer> {
  const token = randomBytes(24).toString("hex");
  let origin = "";
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) {
      response.writeHead(403).end("Foreign host or origin."); return;
    }
    const url = new URL(request.url ?? "/", origin);
    const base = `/${token}/`;
    if (!url.pathname.startsWith(base)) { response.writeHead(404).end("Not found."); return; }
    const route = url.pathname.slice(base.length);
    if (route === "trial" || route.startsWith("trial/") || route === "trial.js" || route === "trial.css") {
      response.writeHead(410).end("The old resampling trial is retired on the native CUA route. Native overview uses Lanczos3; detail uses fresh padded zoom."); return;
    }
    if (request.method === "POST" && ["settings", "hints", "guides"].includes(route)) {
      const limit = 1024;
      if (request.headers.origin !== origin || request.headers["content-type"] !== "application/json") {
        response.writeHead(403).end("Settings require same-origin JSON."); request.resume(); return;
      }
      try {
        if (Number(request.headers["content-length"]) > limit) { response.writeHead(413).end("Settings body exceeds limit."); request.resume(); return; }
        const chunks: Buffer[] = []; let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > limit) { response.writeHead(413).end("Settings body exceeds limit."); request.resume(); return; }
          chunks.push(Buffer.from(chunk));
        }
        const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (route === "hints" && (!input || typeof input !== "object" || Array.isArray(input) ||
          Object.keys(input).join(",") !== "enabled" || typeof (input as { enabled?: unknown }).enabled !== "boolean")) throw Error("Expected only boolean enabled.");
        const applied = route === "hints" ? images.setHints((input as { enabled: boolean }).enabled) : route === "guides" ? images.setGuides(input) : images.update(input);
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(applied));
      } catch (error) { response.writeHead(400).end(error instanceof Error ? error.message : String(error)); }
      return;
    }
    if (!["GET", "HEAD"].includes(request.method ?? "")) { response.writeHead(405).end("Only settings can be written."); return; }
    let body: string | Buffer | undefined;
    let mime = "text/plain; charset=utf-8";
    if (route === "") { body = visionPanel; mime = "text/html; charset=utf-8"; }
    else if (route === "panel.js") { body = visionScript; mime = "text/javascript; charset=utf-8"; }
    else if (route === "style.css") { body = visionStyle; mime = "text/css; charset=utf-8"; }
    else if (route === "state") { body = JSON.stringify({ ...trace.snapshot(), imageSettings: images.settings() }); mime = "application/json"; }
    else if (/^images\/[a-f0-9]{64}$/.test(route)) {
      const hash = route.slice(7); body = trace.asset(hash); mime = trace.assetMime(hash) ?? "image/png";
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
