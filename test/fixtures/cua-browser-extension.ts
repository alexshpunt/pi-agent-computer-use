import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CuaBrowser } from "../../src/cua-browser.ts";
import { registerCuaBrowserTools } from "../../src/cua-browser-tools.ts";
import type { Driver, DriverResult } from "../../src/session.ts";

/** Real-Pi contract fixture: scripted native replies, never Windows UI input. */
export default function fixture(pi: ExtensionAPI): void {
  createCodemodeExtension({ mode: "on" })(pi);
  pi.on("session_start", () => { pi.appendEntry("browser-hint-offset", { offset: 26 }); });
  let snapshot = 0; let clicks = 0;
  const record = (name: string, args: unknown) => appendFile(path.join(process.cwd(), "cua-calls.jsonl"), JSON.stringify({ name, args }) + "\n");
  const driver: Driver = {
    async call(name, args): Promise<DriverResult> {
      await record(name, args);
      let state: Record<string, unknown> = {};
      const bounds = { x: 70, y: 60, width: 1332, height: 932 };
      if (name === "browser_prepare") state = { prepared: true, prepared_pid: 111, action: "launched_isolated_browser" };
      if (name === "bring_to_front") state = { landed_on_target: true, target_hwnd: "0x16", now_fg_hwnd: "0x16", previous_fg_hwnd: "0x99", raised: true, restored: false };
      if (name === "list_windows") state = { windows: [{ pid: 111, window_id: 22, bounds }] };
      if (name === "get_browser_state" && args.pid) state = { binding_quality: "exact", mutation_allowed: true, target_id: "fixture-target", tabs: [{ tab_id: "fixture-tab", active: true, title: "Fixture", url: "https://example.test/" }] };
      if (name === "get_browser_state" && args.target_id) {
        snapshot++;
        state = { snapshot: { id: `p${snapshot}` }, outline: `Selections: ${clicks}`, page: { title: "Fixture", url: "https://example.test/" },
          refs: ["One", "Two", "Three", "Four", "Fail", "Refuse"].map((name, index) => ({ ref: `p${snapshot}:${index}`, name, role: "button", actions: ["click", "pointer"] })) };
      }
      if (name === "browser_click") {
        if (String(args.ref).endsWith(":5")) return { content: [], isError: false, structuredContent: { effect: "refused", summary: "Native route unavailable" } };
        if (String(args.ref).endsWith(":4")) throw new Error("Response lost after input");
        clicks++;
      }
      if (name === "get_window_state") return { structuredContent: { capture_id: "fixture-capture", screenshot_width: 1, screenshot_height: 1, window_bounds: bounds },
        content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII=" }] };
      if (name === "zoom") return { structuredContent: { width: 152, height: 120 }, content: [{ type: "image", mimeType: "image/jpeg", data: (await readFile(new URL("./cua-zoom.jpg", import.meta.url))).toString("base64") }] };
      if (name === "end_session") state = { active: false };
      return { structuredContent: state, content: [] };
    },
    async identity() { return "fixture-window-lifetime"; },
    async close() { await record("transport_close", {}); },
  };
  registerCuaBrowserTools(pi, new CuaBrowser(async () => driver));
}
