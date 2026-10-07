import { appendFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerComputerTools } from "../../src/index.ts";
import { ComputerSession, type Driver } from "../../src/session.ts";
import { ReactiveAnimationDriver, loadReactiveAnimationConfig } from "../../src/reactive-animation.ts";

/** Real Pi/schema/session fixture. Native animation and physical input need a separate Windows check. */
export default function reactiveAnimationFixture(pi: ExtensionAPI): void {
  createCodemodeExtension({ mode: "on" })(pi);
  let session: ComputerSession | undefined;
  registerComputerTools(pi, async cwd => {
    if (!session) {
      let glide = 240, count = 0;
      const png = (await sharp({ create: { width: 500, height: 350, channels: 3, background: "white" } }).png().toBuffer()).toString("base64");
      const base: Driver = {
        identity: async () => "PiComputerUse.0123456789abcdef0123456789abcdef:42:1", close: async () => {},
        async call(name, args) {
          await appendFile(path.join(cwd, "calls.jsonl"), JSON.stringify({ name, args, glide }) + "\n");
          if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid: 42, window_id: 100 }] } };
          if (name === "get_window_state") return { content: [{ type: "image", mimeType: "image/png", data: png }], structuredContent: {
            elements: [{ element_token: "counter", role: "Button", label: "Counter", frame: { x: 10, y: 10, width: 20, height: 20 } }],
            screenshot_width: 500, screenshot_height: 350, window_bounds: { x: 0, y: 0, width: 500, height: 350 },
          } };
          if (name === "get_agent_cursor_state") return { content: [], structuredContent: { motion: { glide_duration_ms: glide } } };
          if (name === "set_agent_cursor_motion") {
            glide = Number(args.glide_duration_ms);
            return { content: [], structuredContent: { motion: { glide_duration_ms: glide } } };
          }
          if (name === "click") return { content: [], structuredContent: { effect: "unverifiable", count: ++count } };
          throw Error("Unexpected fixture call");
        },
      };
      session = new ComputerSession(new ReactiveAnimationDriver(base, await loadReactiveAnimationConfig(cwd)));
    }
    return session;
  }, async () => session!.close());
  pi.on("session_shutdown", async () => { await session?.close(); });
}
