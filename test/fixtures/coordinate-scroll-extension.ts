import { readFile } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadComputerConfig } from "../../src/config.ts";
import { McpDriver } from "../../src/driver.ts";
import { ReactiveAnimationDriver } from "../../src/reactive-animation.ts";
import { registerComputerProvider } from "../../src/provider.ts";
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
  const match = textOf(result).match(new RegExp(`computer:${kind}/[a-zA-Z0-9-]+`));
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
    return session ??= new ComputerSession(new ReactiveAnimationDriver(driver, { glide_duration_ms: 1 }), () => mode);
  };
  const close = async (): Promise<ComputerResult> => session ? session.close() : {
    content: [{ type: "text", text: "No synthetic runtime is running." }], details: { status: "closed", mode },
  };
  await registerComputerProvider(pi, getSession, close);
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
      const control = async (operation: string) => {
        if (operation === "safe") mode = "safe";
        else if (operation === "capability_off") capability = false;
        else if (operation === "capability_on") capability = true;
        else await driver!.call("fixture_control", { operation }, signal);
      };
      const open = async () => reference(await ok("insert", { path: "computer:session", text: JSON.stringify({ action: "open", app: "Notepad" }) }), "window");
      const observe = (window: string, granularity = "full") => ok("read", { path: window,
        views: [granularity, ...(granularity === "ui" ? [] : ['capture:{"hints":false}'])] });
      const command = (extra: Record<string, unknown> = {}) => ({ action: "scroll", x: 100, y: 80, delta_y: 2, unit: "wheel_detents", ...extra });
      const act = async (observation: string, command: Record<string, unknown>) => {
        const before = (await captures()).length;
        const result = await call("insert", { path: observation, text: JSON.stringify(command) });
        assert((await captures()).length === before, "Insert resolution silently refreshed native capture authority");
        return result;
      };
      const rejected = async (observation: string, command: Record<string, unknown>) => {
        const result = await act(observation, command);
        assert(result.isError, `Insert admitted a forbidden or consumed observation: ${textOf(result)}`);
        return result;
      };
      assert(!pi.getAllTools().some(tool => /^computer_/.test(tool.name)), "Provider exposed duplicate ordinary computer_* tools");
      const first = await open(), second = await open();
      const listed = await ok("search", { path: "computer:windows", query: "Owned fixture" });
      assert(textOf(listed).includes(first) && textOf(listed).includes(second), "Search lost exact opened resources");
      let view = await observe(first), observation = reference(view, "observation");
      const image = view.content.find(block => block.type === "image");
      assert(image?.mimeType === "image/png" && image.data, "Native overview image did not reach actual Pi");
      if (scenario === "receipts") {
        const background = command();
        const refused = await rejected(observation, background), refusal = semantic(refused), refusalState = record(refusal.state);
        assert(refusal.status === "refused" && refusal.effect === "not-applied" && refusalState.code === "background_unavailable" && refusalState.pointer_attempted === false,
          "Structured background refusal lost its no-input evidence");
        await rejected(observation, { ...background, delivery_mode: "foreground" });
        view = await observe(first); observation = reference(view, "observation");
        const full = command({ delta_x: -2, delta_y: 3, delivery_mode: "foreground" });
        const delivered = await act(observation, full), receipt = semantic(delivered), state = record(receipt.state);
        assert(!delivered.isError && receipt.status === "delivered" && receipt.effect === "applied" && state.unit === "wheel_detents" &&
          JSON.stringify(state.delivered_axes) === '["y","x"]' && state.pointer_changed === null && record(receipt.action_capability).actual_delivery === "foreground",
          "Truthful two-axis structured receipt lost");
        await rejected(observation, full);
        view = await observe(first, "image"); observation = reference(view, "observation");
        const imageOnly = await act(observation, command({ x: 120, y: 90, delta_x: 1, delta_y: 0, delivery_mode: "foreground" }));
        assert(!imageOnly.isError && semantic(imageOnly).status === "delivered", "Image-only scroll refused");
        for (const operation of ["partial", "last_check", "wrong_unit", "wrong_delta", "wrong_axes", "background_success"]) {
          await control(operation); view = await observe(first); observation = reference(view, "observation");
          const request = command({ x: 130, y: 100, delta_x: 1, delta_y: 1, delivery_mode: operation === "background_success" ? "background" : "foreground" });
          const result = await rejected(observation, request), action = semantic(result), native = record(action.state);
          assert(action.status === "unknown" && action.effect === "unknown", `${operation} lost structured uncertainty`);
          if (operation === "partial") assert(native.pointer_delivered === true && JSON.stringify(native.attempted_axes) === '["y","x"]' &&
            JSON.stringify(native.delivered_axes) === '["y"]' && native.code === "cancelled", "Interrupted native prefix lost");
          if (operation === "last_check") assert(JSON.stringify(native.delivered_axes) === '["y","x"]' && native.code === "foreground_lost",
            "Complete native prefix lost after final check failed");
          await rejected(observation, request);
        }
        await control("success");
        for (const extra of [
          { delta_y: 51 }, { delta_y: 1.5 }, { delta_x: -1.5 }, { delta_x: 0, delta_y: 0 }, { unit: "pixels" }, { unit: undefined }, { x: 500 }, { x: -1 }, { y: undefined },
          { direction: "down" }, { by: "line" }, { amount: 1 }, { button: "left" }, { modifiers: ["ctrl"] }, { animation: "reactive" },
        ]) {
          view = await observe(first); observation = reference(view, "observation");
          await rejected(observation, command({ delivery_mode: "foreground", ...extra }));
        }
        view = await observe(first); observation = reference(view, "observation");
        await rejected(observation, { action: "sequence", sequence: [command({ delivery_mode: "foreground" })] });
      } else {
        await rejected(observation, command({ window_ref: second, delivery_mode: "foreground" }));
        view = await observe(first, "ui"); observation = reference(view, "observation");
        assert(!view.content.some(block => block.type === "image") && field(view.details, "ui"), "UI-only fixture observation lost its projection");
        await rejected(observation, command({ delivery_mode: "foreground" }));
        view = await observe(first); observation = reference(view, "observation");
        const hint = field(view.details, "hint");
        assert(typeof hint === "string", "Native fixture failed to supply a current hint");
        await rejected(observation, command({ hint, delivery_mode: "foreground" }));
        view = await observe(first); observation = reference(view, "observation");
        const token = field(view.details, "element_token");
        assert(typeof token === "string", "Native fixture failed to supply a current token");
        await rejected(observation, command({ element_token: token, delivery_mode: "foreground" }));
        view = await observe(first); observation = reference(view, "observation");
        const cropped = await ok("read", { path: observation, views: ["region:50,50,100,100"] });
        assert(cropped.content.some(block => block.type === "image" && block.mimeType === "image/jpeg") && field(cropped.details, "input") === "none" &&
          field(cropped.details, "observation_id") === undefined, "Detail granted input authority");
        await rejected(observation, command({ delivery_mode: "foreground" }));
        await control("capability_off"); view = await observe(first); observation = reference(view, "observation");
        await rejected(observation, command({ delivery_mode: "foreground" }));
        await control("capability_on");
        const external = reference(await ok("search", { path: "computer:windows", query: "Unowned fixture" }), "window");
        view = await observe(external); observation = reference(view, "observation"); await control("safe");
        await rejected(observation, command({ delivery_mode: "foreground" }));
        view = await observe(first, "image"); observation = reference(view, "observation");
        const owned = await act(observation, command({ delivery_mode: "foreground" }));
        assert(!owned.isError && semantic(owned).status === "delivered", "Safe denied owned image scroll");
        view = await observe(first); observation = reference(view, "observation"); await control("close_first");
        await rejected(observation, command({ delivery_mode: "foreground" }));
        view = await observe(second); observation = reference(view, "observation"); await control("recycle_second");
        await rejected(observation, command({ delivery_mode: "foreground" }));
        await denied("insert", { path: first, text: JSON.stringify(command({ delivery_mode: "foreground" })) });
      }
      await ok("insert", { path: "computer:session", text: JSON.stringify({ action: "close" }) });
      return { content: [{ type: "text" as const, text: `Scroll ${scenario} contract passed` },
        ...(image ? [{ type: "image" as const, data: image.data!, mimeType: image.mimeType! }] : [])], details: { scenario } };
    },
  });
  pi.on("session_shutdown", async () => { await session?.close(); });
}
