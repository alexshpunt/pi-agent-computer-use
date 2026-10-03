import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VisionTrace } from "./vision-trace.ts";
import { VisionImages } from "./vision-images.ts";
import { startVisionServer, type VisionServer } from "./vision-server.ts";

/** Live debug state for trusted host integrations and verification, never model control. */
export interface VisionDebug { trace: VisionTrace; url(): string | undefined; close(): Promise<void> }

/** Mirror existing Pi hooks and expose session image settings. No provider override or new agent tool. */
export function registerVisionDebug(pi: ExtensionAPI, images = new VisionImages()): VisionDebug {
  const trace = new VisionTrace("unstarted");
  let server: VisionServer | undefined;
  let loading: Promise<VisionServer> | undefined;
  let sessionId: string | undefined;
  let enabled = false;
  let imageSession: string | undefined;
  const close = async () => {
    enabled = false;
    if (loading) await loading.catch(() => undefined);
    await server?.close(); server = undefined; sessionId = undefined;
    trace.reset("closed");
  };
  const start = async (ctx: ExtensionContext) => {
    const id = ctx.sessionManager.getSessionId();
    if (imageSession !== id) { images.reset(); imageSession = id; }
    if (id !== sessionId) { await close(); sessionId = id; trace.reset(id); }
    if (!server) {
      loading ??= startVisionServer(trace, images);
      try { server = await loading; } finally { loading = undefined; }
    }
    enabled = true;
    pi.appendEntry("vision-debug-viewer", { url: server.url, sessionId: id, boundary: "application; final delivery unconfirmed" });
    ctx.ui.setStatus("vision-debug", "vision debug · application boundary");
    ctx.ui.notify(`Vision debug: ${server.url}\nApplication boundary only; final delivery is unconfirmed.`, "info");
  };
  pi.on("session_start", async (_event, ctx) => { await start(ctx); });
  pi.on("session_shutdown", async (_event, ctx) => {
    await close(); ctx.ui.setStatus("vision-debug", undefined);
  });
  const tracked = (name: string) => /^(browser_|computer_)/.test(name);
  pi.on("tool_call", (event) => {
    if (enabled && tracked(event.toolName)) trace.startAction(event.toolCallId, event.toolName, event.input, event.parentToolCallId);
  });
  pi.on("tool_result", (event) => {
    if (enabled && tracked(event.toolName)) trace.finishAction(event.toolCallId, event.content, event.details, event.isError);
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled) return;
    const model = ctx.model;
    trace.observePayload(event.payload, { provider: model?.provider ?? "unknown", api: model?.api ?? "unknown", model: model?.id ?? "unknown" });
    // Observation-only: returning data here would replace the provider payload.
  });
  pi.on("after_provider_response", (event) => { if (enabled) trace.response(event.status); });
  pi.registerCommand("computer-debug", {
    description: "Show, start or stop the session's vision debug viewer and image controls",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (value === "off") { await close(); ctx.ui.setStatus("vision-debug", undefined); ctx.ui.notify("Vision debug stopped; retained pixels cleared.", "info"); }
      else if (value === "on") await start(ctx);
      else if (!value || value === "status") ctx.ui.notify(server ? `Vision debug: ${server.url}\nFinal delivery is unconfirmed.` : "Vision debug is off. Use /computer-debug on.", "info");
      else ctx.ui.notify("Usage: /computer-debug [on|off|status]", "warning");
    },
  });
  return { trace, url: () => server?.url, close };
}
