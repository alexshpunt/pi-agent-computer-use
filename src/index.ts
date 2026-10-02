import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { McpDriver, type ComputerConfig } from "./driver.ts";
import { ComputerSession } from "./session.ts";

const targetSchema = Type.Object({
  pid: Type.Integer({ minimum: 1 }),
  window_id: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });

/** Standalone PoC tools. The final Pi Agent IDE provider API is deliberately not used. */
export default function computerUse(pi: ExtensionAPI): void {
  let session: ComputerSession | undefined;
  let loading: Promise<ComputerSession> | undefined;

  async function getSession(cwd: string): Promise<ComputerSession> {
    if (session) return session;
    if (loading) return loading;
    loading = (async () => {
      let config: ComputerConfig;
      try {
        config = JSON.parse(await readFile(path.join(cwd, ".pi", "computer-use.json"), "utf8")) as ComputerConfig;
      } catch {
        throw new Error("Computer use is not configured. Create .pi/computer-use.json with a Driver command and an authorized test-window target. See docs/standalone-poc.md.");
      }
      if (!config.command || typeof config.command !== "string"
        || !Number.isSafeInteger(config.target?.pid) || config.target.pid <= 0
        || !Number.isSafeInteger(config.target?.window_id) || config.target.window_id <= 0
        || (config.args && (!Array.isArray(config.args) || !config.args.every((arg) => typeof arg === "string")))
        || (config.interop !== undefined && typeof config.interop !== "string"))
        throw new Error("Invalid computer-use configuration. Use an exact PID/window ID and trusted executable path.");
      session = new ComputerSession(new McpDriver(config), config.target);
      return session;
    })();
    try { return await loading; }
    finally { loading = undefined; }
  }

  pi.registerTool({
    name: "computer_windows",
    label: "Computer windows",
    description: "Find the operator-authorized Windows test window through Cua Driver. Lists metadata, never other applications' contents. Returns exact pid/window_id; it does not launch or authorize an app.",
    parameters: Type.Object({}, { additionalProperties: false }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, _params, signal, _update, ctx) {
      return (await getSession(ctx.cwd)).windows(signal);
    },
  });

  pi.registerTool({
    name: "computer_observe",
    label: "Computer observe",
    description: "Read the authorized Windows window's accessibility tree and screenshot together. Returns observation_id and element_token references. Each read replaces prior references. Ground the next action in this observation; then read again. No IDE dependency.",
    parameters: Type.Object({
      target: targetSchema,
      query: Type.Optional(Type.String({ description: "Project the tree to matching labels/values and their ancestors." })),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      return (await getSession(ctx.cwd)).observe(params.target, signal, params.query);
    },
  });

  pi.registerTool({
    name: "computer_act",
    label: "Computer act",
    description: "Perform one grounded action on the authorized Windows test window. Requires its latest observation_id; every dispatched attempt consumes it, including a refusal. Use current element_token or screenshot x/y. type_text is input; set_value replaces an element value. select_all sends Ctrl+A. Try background first; foreground is explicit and only after an observed failure/refusal. Never retry an unknown outcome blindly. Read again to verify application state. No saving files or acting on existing documents.",
    parameters: Type.Object({
      target: targetSchema,
      observation_id: Type.String({ minLength: 1 }),
      action: Type.Union(["type_text", "set_value", "click", "select_all", "key"].map((value) => Type.Literal(value))),
      delivery_mode: Type.Optional(Type.Union([Type.Literal("background"), Type.Literal("foreground")])),
      element_token: Type.Optional(Type.String({ minLength: 1 })),
      x: Type.Optional(Type.Number({ minimum: 0 })),
      y: Type.Optional(Type.Number({ minimum: 0 })),
      text: Type.Optional(Type.String({ maxLength: 2000 })),
      key: Type.Optional(Type.Union(["backspace", "delete", "left", "right", "home", "end", "return", "escape", "tab"].map((value) => Type.Literal(value)))),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      return (await getSession(ctx.cwd)).act(params, signal);
    },
  });

  pi.registerTool({
    name: "computer_close",
    label: "Computer close",
    description: "Release the Driver runtime owned by this Pi session and invalidate observations. Does not close any application windows or save documents.",
    parameters: Type.Object({}, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute() {
      return session ? session.close() : {
        content: [{ type: "text" as const, text: "No owned Driver runtime is running." }],
        details: { status: "closed" },
      };
    },
  });

  pi.on("session_shutdown", async () => {
    if (loading) await loading.catch(() => undefined);
    await session?.close();
    session = undefined;
  });
}
