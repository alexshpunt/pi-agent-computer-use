import { addressPattern } from "./addresses.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ComputerMode, ComputerResult, ComputerSession, WindowTarget } from "../../src/session.ts";

interface Result { isError?: boolean; content: { type: string; text?: string }[]; details?: unknown }
const body = (result: Result) => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw Error(message); }
function find(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  if (key in value) return (value as Record<string, unknown>)[key];
  for (const child of Object.values(value)) { const found = find(child, key); if (found !== undefined) return found; }
  return undefined;
}
function reference(result: Result, kind: "window" | "window-state" | "observation"): string {
  const found = body(result).match(addressPattern(kind));
  assert(found, `No ${kind} resource in native tool receipt: ${body(result)}`);
  return found[0];
}
function semantic(result: Result): Record<string, unknown> {
  const value = find(result.details, "semanticAction");
  assert(value && typeof value === "object", `No semantic action receipt: ${body(result)}`);
  return value as Record<string, unknown>;
}

/** Synthetic MCP witness; every tested read and restoration uses the actual public IDE tools. */
export default async function fixture(pi: ExtensionAPI): Promise<void> {
  const source = process.env.PI_RESTORE_PROVIDER_SOURCE ?? path.resolve(import.meta.dirname, "../..");
  const load = (name: string) => import(pathToFileURL(path.join(source, "src", name)).href);
  const [{ registerComputerProvider }, { loadComputerConfig }, { McpDriver }, { ComputerSession }] =
    await Promise.all([load("provider.ts"), load("config.ts"), load("driver.ts"), load("session.ts")]);
  const Base = McpDriver as typeof import("../../src/driver.ts").McpDriver;
  let capability = true, mode: ComputerMode = "yolo", session: ComputerSession | undefined, driver: FixtureDriver | undefined, log: string | undefined;
  class FixtureDriver extends Base {
    get platform() { return "windows" as const; }
    get windowRestore() { return capability; }
    async identity(target: WindowTarget, _create: boolean, signal?: AbortSignal) {
      return (await this.call("fixture_identity", target as unknown as Record<string, unknown>, signal)).structuredContent?.identity as string | undefined;
    }
  }
  const getSession = async (cwd: string): Promise<ComputerSession> => {
    if (!driver) { const config = await loadComputerConfig(cwd); log = config.args[1]; driver = new FixtureDriver(config); }
    session ??= new ComputerSession(driver, () => mode);
    return session!;
  };
  const close = async (): Promise<ComputerResult> => session ? session.close() : {
    content: [{ type: "text", text: "No fixture runtime is running." }], details: { status: "closed", mode },
  };
  await registerComputerProvider(pi, getSession, close);
  pi.registerTool({
    name: "verify_window_restore", label: "Verify metadata-only window restore",
    description: "Exercise real IDE resource tools against synthetic window restore receipts, never a desktop.",
    parameters: Type.Object({ scenario: Type.Union([Type.Literal("workflow"), Type.Literal("admission")]) }),
    async execute(_id, { scenario }, signal, _update, ctx) {
      const call = async (name: string, args: Record<string, unknown>): Promise<Result> => {
        try { const value = await ctx.executeTool(name, args, { signal }); return { ...value.result, isError: value.isError } as Result; }
        catch (error) { return { isError: true, content: [{ type: "text", text: String(error) }] }; }
      };
      const ok = async (name: string, args: Record<string, unknown>) => {
        const value = await call(name, args); assert(!value.isError, `${name} failed: ${body(value)}`); return value;
      };
      const denied = async (name: string, args: Record<string, unknown>) => {
        const value = await call(name, args); assert(value.isError, `${name} accepted forbidden/uncertain operation: ${body(value)}`); return value;
      };
      const journal = async () => (await readFile(log!, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const count = async (name: string) => (await journal()).filter(row => row.name === name).length;
      const control = (operation: string) => driver!.call("fixture_control", { operation }, signal);
      const stateRead = async (window: string) => {
        const value = await ok("read", { path: window, views: ["state"] });
        assert(value.content.every(block => block.type !== "image"), "State Read granted pixel authority");
        assert(find(value, "minimized") === true && find(value, "foreground_at_target") === false && find(value, "keyboard_focus_at_target") === null,
          `State lost separate native window/focus measurements: ${body(value)}`);
        return reference(value, "window-state");
      };
      const restore = (state: string) => call("insert", { path: state, text: '{"action":"restore"}' });
      const open = async () => reference(await ok("insert", { path: "computer:machine/local", text: '{"action":"open","app":"Notepad"}' }), "window");
      assert(!pi.getAllTools().some(tool => /^computer_/.test(tool.name)), "Duplicate computer tools escaped primary IDE provider");
      const first = await open(), second = await open();
      const listed = await ok("search", { path: "computer:machine/local/windows", query: "Owned restore fixture" });
      assert(body(listed).includes(first) && body(listed).includes(second), "Search lost exact native window references");
      let state = await stateRead(first);
      if (scenario === "workflow") {
        const before = await count("get_window_status"), cached = await ok("read", { path: state });
        assert(reference(cached, "window-state") === state, "Cached state Read issued fresh authority");
        assert(await count("get_window_status") === before && await count("get_window_state") === 2,
          "Cached state Read or editor resolution silently acquired native state/pixels");
        for (const [name, args] of [
          ["write", { path: state, content: "must not type" }],
          ["insert", { path: state, text: '{"action":"click","x":1,"y":1}' }],
          ["insert", { path: state, text: '{"action":"restore","window_id":92}' }],
          ["insert", { path: state, text: '{"action":"restore","state_id":"other"}' }],
          ["insert", { path: state, text: '{"action":"restore","delivery_mode":"foreground"}' }],
          ["insert", { path: state, text: '{"action":"sequence","sequence":[]}' }],
        ] as const) await denied(name, args);
        assert(await count("restore_window") === 0, "Invalid state command dispatched restoration");
        const result = await restore(state);
        assert(!result.isError, `Admitted restore failed: ${body(result)}`);
        const action = semantic(result);
        assert(action.ok === true && action.effect === "applied" && action.status === "delivered", "Confirmed restoration lost semantic success");
        assert(find(action, "restore_requested") === true && find(action, "foreground_at_target") === true && find(action, "keyboard_focus_at_target") === null,
          "Restore collapsed foreground and keyboard focus or discarded prefix");
        assert(body(result).includes("restore_requested=true") && /keyboard_focus(?:_at_target)?=(?:null|unknown|unavailable)/.test(body(result)),
          `Human tool receipt hid restoration/focus prefix: ${body(result)}`);
        await denied("insert", { path: state, text: '{"action":"restore"}' });
        await denied("read", { path: state });
        assert(await count("restore_window") === 1 && await count("get_window_status") === before, "Consumed state was replayed or silently refreshed");
        const old = await stateRead(first); state = await stateRead(first);
        await denied("insert", { path: old, text: '{"action":"restore"}' });
        const ui = await ok("read", { path: first, views: ["ui"] });
        await denied("insert", { path: state, text: '{"action":"restore"}' });
        const observation = reference(ui, "observation");
        await stateRead(first);
        await denied("write", { path: observation, content: "retired UI" });
        assert(await count("restore_window") === 1, "Retired metadata/UI authority dispatched restoration");
        const beforeSequence = await stateRead(first);
        await ok("read", { path: first, views: ['sequence:{"duration_ms":200,"fps":10,"max_frames":2}'] });
        await denied("insert", { path: beforeSequence, text: '{"action":"restore"}' });
        assert(await count("restore_window") === 1, "Temporal Read retained restore authority");
      } else {
        const external = reference(await ok("search", { path: "computer:machine/local/windows", query: "Unowned restore fixture" }), "window");
        const externalState = await stateRead(external); mode = "safe";
        const refusal = await denied("insert", { path: externalState, text: '{"action":"restore"}' });
        assert(semantic(refusal).effect === "not-applied" && body(refusal).includes("Safe mode"), "Safe denial hid no-dispatch effect");
        const current = await stateRead(first);
        const cachedBefore = await count("get_window_status");
        await ok("read", { path: current });
        assert(await count("get_window_status") === cachedBefore, "Owned cached state Read refreshed under Safe");
        for (const operation of ["refused", "partial", "final_cancel", "wrong_state", "wrong_window", "wrong_route", "missing_focus", "not_foreground"]) {
          const address = await stateRead(first); await control(operation);
          const result = await denied("insert", { path: address, text: '{"action":"restore"}' }), action = semantic(result);
          assert(action.effect === (operation === "refused" ? "not-applied" : "unknown"), `Wrong semantic effect for ${operation}: ${body(result)}`);
          assert(find(action, "restore_attempted") === (operation !== "refused"), `Native prefix discarded for ${operation}`);
          if (operation === "final_cancel") assert(find(action, "activation_succeeded") === true, "Final cancellation lost fully delivered prefix");
          const before = await count("restore_window");
          await denied("insert", { path: address, text: '{"action":"restore"}' });
          assert(await count("restore_window") === before, `Unknown/refused ${operation} was replayed`);
        }
        state = await stateRead(first); await control("close_first");
        await denied("read", { path: state });
        await denied("insert", { path: state, text: '{"action":"restore"}' });
        state = await stateRead(second); await control("reuse_second");
        await denied("insert", { path: state, text: '{"action":"restore"}' });
        const beforeReuse = await count("restore_window");
        mode = "yolo";
        const replacement = reference(await ok("search", { path: "computer:machine/local/windows", query: "Owned restore fixture 92" }), "window");
        state = await stateRead(replacement); await control("reused_after_restore");
        const reused = await denied("insert", { path: state, text: '{"action":"restore"}' });
        assert(semantic(reused).effect === "unknown" && find(reused, "activation_succeeded") === true, "Post-dispatch reuse lost completed prefix or became success");
        assert(await count("restore_window") === beforeReuse + 1, "Closed/reused reference sent an extra restoration");
        capability = false;
        const beforeUnqualified = await count("get_window_status");
        const latest = reference(await ok("search", { path: "computer:machine/local/windows", query: "Owned restore fixture 92" }), "window");
        const manual = await denied("read", { path: latest, views: ["state"] });
        assert(/manually|user/i.test(body(manual)), "Unqualified runtime omitted manual recovery");
        assert(await count("get_window_status") === beforeUnqualified, "Unqualified runtime sent native state acquisition");
      }
      const rows = await journal();
      assert(rows.every(row => ["fixture_identity", "fixture_control", "list_apps", "list_windows", "launch_app", "get_window_state", "get_window_status", "restore_window"].includes(row.name)),
        "Restore used hidden input, capture fallback or bring_to_front");
      await ok("insert", { path: "computer:session", text: '{"action":"close"}' });
      return { content: [{ type: "text" as const, text: `IDE window restore ${scenario} contract passed` }],
        details: { scenario, restores: rows.filter(row => row.name === "restore_window").length, statusReads: rows.filter(row => row.name === "get_window_status").length } };
    },
  });
  pi.on("session_shutdown", async () => { await session?.close(); });
}
