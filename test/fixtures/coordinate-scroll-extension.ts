import { addressPattern } from "./addresses.ts";
import { readFile } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadComputerConfig } from "../../src/config.ts";
import { McpDriver } from "../../src/driver.ts";
import { registerComputerProvider } from "../../src/provider.ts";
import { registerComputerTools } from "../../src/computer-tools.ts";
import { ComputerSession, type ComputerMode, type ComputerResult, type WindowTarget } from "../../src/session.ts";

interface Result { isError?: boolean; content: { type: string; text?: string; data?: string; mimeType?: string }[]; details?: unknown }
const textOf = (result: Result) => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
const assert = (condition: unknown, message: string): void => { if (!condition) throw Error(message); };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  if (key in value) return (value as Record<string, unknown>)[key];
  for (const child of Object.values(value)) { const found = field(child, key); if (found !== undefined) return found; }
  return undefined;
}
const reference = (result: Result, kind: "window" | "observation") => {
  const match = textOf(result).match(addressPattern(kind));
  if (!match) throw Error(`No ${kind} resource in actual IDE result: ${textOf(result)}`);
  return match[0];
};
const semantic = (result: Result) => record(field(result.details, "semanticAction"));

// Only native identity, capability and receipts are simulated; actual IDE/session admission runs in Pi.
let capability = true;
class FixtureDriver extends McpDriver {
  override get platform() { return "windows" as const; }
  override get coordinateScroll(): boolean { return capability; }
  override async identity(target: WindowTarget, _create: boolean, signal?: AbortSignal) {
    const result = await this.call("fixture_identity", target as unknown as Record<string, unknown>, signal);
    return result.structuredContent?.identity as string | undefined;
  }
}

/** Test-only proof drives actual ordinary resource tools against the synthetic native peer. */
export default async function fixture(pi: ExtensionAPI): Promise<void> {
  capability = true;
  let mode: ComputerMode = "yolo", session: ComputerSession | undefined, driver: FixtureDriver | undefined, log: string | undefined;
  const getSession = async (cwd: string): Promise<ComputerSession> => {
    if (!driver) {
      const config = await loadComputerConfig(cwd);
      log = config.args![1];
      driver = new FixtureDriver(config);
    }
    return session ??= new ComputerSession(driver, () => mode);
  };
  const close = async (): Promise<ComputerResult> => session ? session.close() : {
    content: [{ type: "text", text: "No synthetic runtime is running." }], details: { status: "closed", mode },
  };
  const provider = await registerComputerProvider(pi, getSession, close);
  registerComputerTools(pi, provider.resources);
  pi.registerTool({
    name: "verify_coordinate_scroll", label: "Verify coordinate scroll fixture",
    description: "Exercise ordinary IDE resource tools against synthetic MCP windows only; never operate a desktop.",
    parameters: Type.Object({ scenario: Type.Union([Type.Literal("receipts"), Type.Literal("authority")]) }),
    async execute(_id, { scenario }, signal, _update, ctx) {
      const call = async (name: string, args: Record<string, unknown>): Promise<Result> => {
        try {
          const outcome = await ctx.executeTool(name, args, { signal });
          return { ...outcome.result, isError: outcome.isError } as Result;
        } catch (error) { return { isError: true, content: [{ type: "text", text: String(error) }] }; }
      };
      const ok = async (name: string, args: Record<string, unknown>) => {
        const result = await call(name, args);
        assert(!result.isError, `${name} failed: ${textOf(result)}`);
        return result;
      };
      const denied = async (name: string, args: Record<string, unknown>) => {
        const result = await call(name, args);
        assert(result.isError, `${name} admitted a forbidden or uncertain request: ${textOf(result)}`);
        return result;
      };
      const journal = async () => (await readFile(log!, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const captures = async () => (await journal()).filter(row => row.name === "get_window_state");
      // Whether a call captured the window before its first native input. The action's successor captures it after the
      // input (LPT-914, LPT-915); a capture before it would silently refresh the input's authority.
      const capturedBeforeInput = async (from: number) => {
        const rows = (await journal()).slice(from), input = rows.findIndex(row => row.name === "scroll_at");
        return rows.slice(0, input < 0 ? rows.length : input).some(row => row.name === "get_window_state");
      };
      const control = async (operation: string) => {
        if (operation === "safe") mode = "safe";
        else if (operation === "capability_off") capability = false;
        else if (operation === "capability_on") capability = true;
        else await driver!.call("fixture_control", { operation }, signal);
      };
      const open = async () => reference(await ok("computer_open", { at: "computer:machine/local", app: "Notepad" }), "window");
      const observe = (window: string, granularity = "full") => ok("read", { path: window,
        views: [granularity, ...(granularity === "ui" ? [] : ['capture:{"hints":false}'])] });
      // A point scroll of computer_scroll: wheel notches at a point of the window's latest image.
      const scroll = async (window: string, extra: Record<string, unknown> = {}) => {
        const before = (await journal()).length;
        const result = await call("computer_scroll", { window, x: 100, y: 80, delta_y: 2, ...extra });
        assert(!await capturedBeforeInput(before), "computer_scroll silently refreshed native capture authority");
        return result;
      };
      const rejected = async (window: string, extra: Record<string, unknown> = {}) => {
        const result = await scroll(window, extra);
        assert(result.isError, `computer_scroll admitted a forbidden or uncertain request: ${textOf(result)}`);
        return result;
      };
      assert(!pi.getAllTools().some(tool => /^computer_(read|search|delete)$/.test(tool.name)), "Provider exposed duplicate ordinary computer tools");
      const first = await open(), second = await open();
      const listed = await ok("search", { path: "computer:machine/local/windows", query: "Owned fixture" });
      assert(textOf(listed).includes(first) && textOf(listed).includes(second), "Search lost exact opened resources");
      let view = await observe(first);
      const image = view.content.find(block => block.type === "image");
      assert(image?.mimeType === "image/png" && image.data, "Native overview image did not reach actual Pi");
      if (scenario === "receipts") {
        // A scroll at a point is real input: the wheel goes in the foreground at once.
        const delivered = await scroll(first, { delta_x: -2, delta_y: 3 }), receipt = semantic(delivered), state = record(receipt.state);
        assert(!delivered.isError && receipt.status === "delivered" && receipt.effect === "applied" && state.unit === "wheel_detents" &&
          JSON.stringify(state.delivered_axes) === '["y","x"]' && state.pointer_changed === null && record(receipt.action_capability).actual_delivery === "foreground",
          `Truthful two-axis structured receipt lost: ${textOf(delivered)}`);
        await observe(first, "image");
        const imageOnly = await scroll(first, { x: 120, y: 90, delta_x: 1, delta_y: 0 });
        assert(!imageOnly.isError && semantic(imageOnly).status === "delivered", "Image-only scroll refused");
        for (const operation of ["partial", "last_check", "wrong_unit", "wrong_delta", "wrong_axes"]) {
          await control(operation); view = await observe(first);
          const result = await rejected(first, { x: 130, y: 100, delta_x: 1, delta_y: 1 });
          const action = semantic(result), native = record(action.state);
          assert(action.status === "unknown" && action.effect === "unknown", `${operation} lost structured uncertainty`);
          if (operation === "partial") assert(native.pointer_delivered === true && JSON.stringify(native.attempted_axes) === '["y","x"]' &&
            JSON.stringify(native.delivered_axes) === '["y"]' && native.code === "cancelled", "Interrupted native prefix lost");
          if (operation === "last_check") assert(JSON.stringify(native.delivered_axes) === '["y","x"]' && native.code === "foreground_lost",
            "Complete native prefix lost after final check failed");
        }
        await control("success");
        const sent = (await journal()).filter(row => row.name === "scroll_at").length;
        for (const extra of [{ delta_y: 51 }, { delta_x: 0, delta_y: 0 }, { x: -1 }, { y: undefined }, { unit: "pixels" }, { direction: "down" },
          { amount: 1 }, { button: "left" }, { modifiers: ["ctrl"] }]) await rejected(first, extra);
        assert((await journal()).filter(row => row.name === "scroll_at").length === sent, "An invalid scroll reached native input");
      } else {
        // An element crop is readonly: it grants no input and issues no observation.
        const cropped = await ok("read", { path: reference(view, "observation"), views: [`element:crop,${field(view.details, "hint")}`] });
        assert(cropped.content.some(block => block.type === "image" && block.mimeType === "image/jpeg") && field(cropped.details, "input") === "none" &&
          field(cropped.details, "observation_id") === undefined, "Detail granted input authority");
        await control("capability_off"); await observe(first);
        await rejected(first);
        await control("capability_on");
        const external = reference(await ok("search", { path: "computer:machine/local/windows", query: "Unowned fixture" }), "window");
        await observe(external); await control("safe");
        await rejected(external);
        await observe(first, "image");
        const owned = await scroll(first);
        assert(!owned.isError && semantic(owned).status === "delivered", "Safe denied owned image scroll");
        await observe(first); await control("close_first");
        await rejected(first);
        await observe(second); await control("recycle_second");
        await rejected(second);
        // Insert never acts on a window; it names the tool that does.
        const insert = await denied("insert", { path: first, text: JSON.stringify({ action: "scroll", x: 100, y: 80, delta_y: 2, unit: "wheel_detents" }) });
        assert(textOf(insert).includes("computer_scroll"), "Insert refusal named no tool");
      }
      await ok("delete", { path: "computer:session" });
      return { content: [{ type: "text" as const, text: `Scroll ${scenario} contract passed` },
        ...(image ? [{ type: "image" as const, data: image.data!, mimeType: image.mimeType! }] : [])], details: { scenario } };
    },
  });
  pi.on("session_shutdown", async () => { await session?.close(); });
}
