import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ComputerMode } from "./session.ts";
import { HumanStop } from "./human-stop.ts";

/**
 * Register a user command, not a model tool. Restore user policy on reload; never start a native runtime here.
 * The human's stop (Escape pressed three times) shows as STOPPED until the human selects a mode again.
 */
export function registerComputerMode(pi: ExtensionAPI, clearFrame: () => Promise<void> = async () => {}, canEnterSafe: () => boolean = () => true,
  humanStop = new HumanStop()): () => ComputerMode {
  let mode: ComputerMode = "yolo";
  let ui: ExtensionContext["ui"] | undefined;
  const show = (ctx?: ExtensionContext) => {
    if (ctx) ui = ctx.hasUI ? ctx.ui : undefined;
    ui?.setStatus("computer-use", humanStop.stopped ? "Computer: STOPPED" : `Computer: ${mode.toUpperCase()}`);
  };
  humanStop.onStop(() => {
    show();
    ui?.notify("Computer use stopped: Escape was pressed three times. Agent input on your desktop is off; /computer-mode safe or /computer-mode yolo turns it on again.", "warning");
    // Steer a running turn, or wait for the next one: the agent must not keep planning desktop input.
    pi.sendMessage({ customType: "computer-use-stop", display: true,
      content: "The human pressed Escape three times and stopped computer use on their desktop. Every computer action on it is refused until they turn it on again with /computer-mode. Do not retry or work around it; tell the human what you were doing and wait." },
    { deliverAs: "steer" });
  });
  const restore = async (ctx: ExtensionContext) => {
    mode = "yolo";
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "computer-use-mode") continue;
      const data = entry.data as { mode?: unknown } | undefined;
      if (data?.mode === "safe" || data?.mode === "yolo") mode = data.mode;
    }
    if (mode === "safe" && !canEnterSafe()) {
      mode = "yolo";
      ctx.ui.notify("Safe mode cannot be restored while a YOLO agent browser is open or starting. Close it first, then select /computer-mode safe.", "warning");
    }
    await clearFrame();
    show(ctx);
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.registerCommand("computer-mode", {
    description: "Show or select computer UI access: safe (session-opened windows) or yolo (desktop-wide). Selecting a mode also turns computer use on again after Escape stopped it. Not an OS sandbox.",
    getArgumentCompletions: prefix => ["safe", "yolo"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const selected = args.trim().toLowerCase();
      if (selected && selected !== "safe" && selected !== "yolo") {
        ctx.ui.notify("Usage: /computer-mode safe|yolo. Without arguments, show the current mode.", "warning");
        return;
      }
      if (selected === "safe" && selected !== mode && !canEnterSafe()) {
        ctx.ui.notify("Wait for pending input to finish and close any YOLO agent browser before selecting Safe; its local debugging port stays accessible until it closes. If cleanup was unconfirmed, verify it is closed and restart Pi.", "warning");
        return;
      }
      if ((selected === "safe" || selected === "yolo") && selected !== mode) {
        // Persist only the user's choice, not window ownership or model-supplied data.
        pi.appendEntry("computer-use-mode", { mode: selected });
        mode = selected;
        await clearFrame();
      }
      const resumed = selected !== "" && humanStop.stopped;
      if (resumed) {
        humanStop.resume();
        pi.sendMessage({ customType: "computer-use-stop", display: true, content: "The human turned computer use on their desktop on again." }, { deliverAs: "nextTurn" });
      }
      show(ctx);
      if (humanStop.stopped) {
        ctx.ui.notify(`Computer mode: STOPPED by Escape (${mode.toUpperCase()} when on). /computer-mode safe or /computer-mode yolo turns it on again.`, "warning");
        return;
      }
      ctx.ui.notify(`Computer mode: ${mode.toUpperCase()}${resumed ? ", on again" : ""}. ${mode === "safe" ? "Only session-opened windows are allowed." : "Desktop-wide UI access is allowed."} Not an OS sandbox.`, "info");
    },
  });
  return () => mode;
}
