import { addressPattern } from "./addresses.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ComputerMode, ComputerResult, ComputerSession, WindowTarget } from "../../src/session.ts";

interface Result { isError?: boolean; content: { type: string; text?: string }[]; details?: unknown }
interface Row { name: string; arguments: Record<string, unknown> }
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
  assert(found, `No ${kind} resource: ${body(result)}`); return found[0];
}
function semantic(result: Result): Record<string, unknown> {
  const value = find(result.details, "semanticAction");
  assert(value && typeof value === "object", `No semantic receipt: ${body(result)}`); return value as Record<string, unknown>;
}

/** Tests ordinary IDE tools against a synthetic peer; no desktop is available to this extension. */
export default async function fixture(pi: ExtensionAPI): Promise<void> {
  const source = process.env.PI_WINDOW_MANAGEMENT_PROVIDER_SOURCE ?? path.resolve(import.meta.dirname, "../..");
  const load = (name: string) => import(pathToFileURL(path.join(source, "src", name)).href);
  const [{ registerComputerProvider }, { loadComputerConfig }, { McpDriver }, { ComputerSession }] =
    await Promise.all([load("provider.ts"), load("config.ts"), load("driver.ts"), load("session.ts")]);
  const Base = McpDriver as typeof import("../../src/driver.ts").McpDriver;
  let management = true, restoration = true, mode: ComputerMode = "yolo";
  let session: ComputerSession | undefined, driver: FixtureDriver | undefined, log: string | undefined;
  let cancelAfterDispatch: AbortController | undefined;
  class FixtureDriver extends Base {
    get platform() { return "windows" as const; }
    get windowRestore() { return restoration; }
    get windowManagement() { return management; }
    async call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      const result = await super.call(name, args, signal);
      if (name === "manage_window" && cancelAfterDispatch) {
        const controller = cancelAfterDispatch; cancelAfterDispatch = undefined; controller.abort();
      }
      return result;
    }
    async identity(target: WindowTarget, _create: boolean, signal?: AbortSignal) {
      return (await this.call("fixture_identity", target as unknown as Record<string, unknown>, signal)).structuredContent?.identity as string | undefined;
    }
  }
  const getSession = async (cwd: string): Promise<ComputerSession> => {
    if (!driver) { const config = await loadComputerConfig(cwd); log = config.args[1]; driver = new FixtureDriver(config); }
    // Match production wrapping; management/restore capabilities and native calls must survive it unchanged.
    session ??= new ComputerSession(driver, () => mode); return session!;
  };
  const close = async (): Promise<ComputerResult> => session ? session.close() : {
    content: [{ type: "text", text: "No synthetic runtime is running." }], details: { status: "closed", mode },
  };
  await registerComputerProvider(pi, getSession, close);
  pi.registerTool({
    name: "verify_window_management", label: "Verify one-use window management",
    description: "Exercise real IDE state and management with synthetic MCP receipts only.",
    parameters: Type.Object({ scenario: Type.Union([Type.Literal("workflow"), Type.Literal("admission"), Type.Literal("receipts"), Type.Literal("restore")]) }),
    async execute(_id, { scenario }, signal, _update, ctx) {
      const call = async (name: string, args: Record<string, unknown>, callSignal = signal): Promise<Result> => {
        try { const result = await ctx.executeTool(name, args, { signal: callSignal }); return { ...result.result, isError: result.isError } as Result; }
        catch (error) { return { isError: true, content: [{ type: "text", text: String(error) }] }; }
      };
      const ok = async (name: string, args: Record<string, unknown>) => {
        const result = await call(name, args); assert(!result.isError, `${name} failed: ${body(result)}`); return result;
      };
      const denied = async (name: string, args: Record<string, unknown>) => {
        const result = await call(name, args); assert(result.isError, `${name} accepted invalid/uncertain action: ${body(result)}`); return result;
      };
      const journal = async (): Promise<Row[]> => (await readFile(log!, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const count = async (name: string) => (await journal()).filter(row => row.name === name).length;
      const control = (operation: string, window_id = 91) => driver!.call("fixture_control", { operation, window_id }, signal);
      const stateRead = async (window: string) => {
        const result = await ok("read", { path: window, views: ["state"] });
        assert(result.content.every(block => block.type !== "image"), "Management state granted pixels");
        if (management) {
          assert(find(result, "coordinate_space") === "windows_desktop_pixels" && find(result, "bounds_source") !== undefined,
            `State lost explicit desktop bounds source: ${body(result)}`);
          assert(find(result, "virtual_desktop") !== undefined, `State dropped native desktop membership: ${body(result)}`);
        }
        return reference(result, "window-state");
      };
      const insert = (state: string, command: Record<string, unknown>) => call("insert", { path: state, text: JSON.stringify(command) });
      const move = { action: "move", x: -20, y: 120, unit: "windows_desktop_pixels" };
      const open = async () => reference(await ok("insert", { path: "computer:machine/local", text: '{"action":"open","app":"Notepad"}' }), "window");
      assert(!pi.getAllTools().some(tool => /^computer_/.test(tool.name)), "Separate computer tools leaked into the IDE provider");
      const first = await open(), second = await open();
      const listed = await ok("search", { path: "computer:machine/local/windows", query: "Owned management fixture" });
      assert(body(listed).includes(first) && body(listed).includes(second), "Search lost exact-source references");
      let state = await stateRead(first);
      if (scenario === "workflow") {
        const statusBefore = await count("get_window_control_state"), captureBefore = await count("get_window_state");
        const cached = await ok("read", { path: state });
        assert(reference(cached, "window-state") === state, "Cached Read renewed one-use admission");
        assert(await count("get_window_control_state") === statusBefore && await count("get_window_state") === captureBefore,
          "Cached Read acquired hidden metadata or pixels");
        const invalid = [
          { action: "move", x: 1, y: 2 }, { ...move, unit: "css_pixels" }, { ...move, x: 1.5 }, { ...move, x: 100001 },
          { ...move, y: -100001 }, { action: "move", x: 1, unit: "windows_desktop_pixels" },
          { action: "resize", width: 0, height: 80, unit: "windows_desktop_pixels" },
          { action: "resize", width: 32768, height: 80, unit: "windows_desktop_pixels" },
          { action: "resize", width: 100, height: 2.5, unit: "windows_desktop_pixels" },
          { ...move, width: 10 }, { ...move, pid: 42 }, { ...move, window_id: 91 }, { ...move, state_id: "foreign" },
          { ...move, delivery_mode: "foreground" }, { ...move, hint: "1" }, { ...move, animation: {} },
          { action: "sequence", sequence: [move] }, { action: "focus", unit: "windows_desktop_pixels" },
          { action: "minimize", x: 1 }, { action: "maximize", height: 5 }, { action: "click", x: 1, y: 1 },
        ];
        await denied("write", { path: state, content: "never type" });
        for (const command of invalid) await denied("insert", { path: state, text: JSON.stringify(command) });
        assert(await count("manage_window") === 0, "Invalid geometry or borrowed input authority reached native mutation");
        const result = await insert(state, move);
        assert(!result.isError && semantic(result).effect === "applied", `Valid desktop move failed: ${body(result)}`);
        assert(find(result, "mutation_attempted") === true && find(result, "postcondition_confirmed") === true,
          "Delivered management discarded native completion prefix");
        await denied("insert", { path: state, text: JSON.stringify(move) }); await denied("read", { path: state });
        assert(await count("manage_window") === 1 && await count("get_window_control_state") === statusBefore,
          "Consumed admission replayed or editor resolution refreshed native state");
        const operations = [{ action: "resize", width: 180, height: 120, unit: "windows_desktop_pixels" },
          { action: "focus" }, { action: "maximize" }, { action: "minimize" }];
        for (const command of operations) {
          await control("reset"); state = await stateRead(first);
          const result = await insert(state, command);
          assert(!result.isError && semantic(result).effect === "applied", `Valid ${command.action} failed: ${body(result)}`);
        }
        await control("reset"); await control("outer_bounds"); state = await stateRead(first);
        const outer = await insert(state, move);
        assert(!outer.isError && find(outer, "bounds_source") === "window_rect", "Explicit outer bounds became visible-frame coordinates");
        await control("reset"); const retired = await stateRead(first); await stateRead(first);
        await denied("insert", { path: retired, text: JSON.stringify(move) });
        state = await stateRead(first); const ui = await ok("read", { path: first, views: ["ui"] });
        await denied("insert", { path: state, text: JSON.stringify(move) });
        const observation = reference(ui, "observation");
        await denied("insert", { path: observation, text: JSON.stringify(move) });
        await stateRead(first); await denied("write", { path: observation, content: "retired UI" });
        state = await stateRead(first);
        await ok("read", { path: first, views: ['sequence:{"duration_ms":200,"fps":10,"max_frames":2}'] });
        await denied("insert", { path: state, text: JSON.stringify(move) });
        assert(await count("manage_window") === 6, "Read-only authority retirement sent a mutation");
      } else if (scenario === "admission") {
        const external = reference(await ok("search", { path: "computer:machine/local/windows", query: "Unowned management fixture" }), "window");
        const externalState = await stateRead(external); mode = "safe";
        const refused = await denied("insert", { path: externalState, text: JSON.stringify(move) });
        assert(semantic(refused).effect === "not-applied", "Safe denial lost no-dispatch effect");
        assert(await count("manage_window") === 0, "Safe denial dispatched management");
        state = await stateRead(first); const prior = await count("get_window_control_state");
        await ok("read", { path: state }); assert(await count("get_window_control_state") === prior, "Safe cached Read renewed state");
        const aborted = new AbortController(); aborted.abort();
        const cancelled = await call("insert", { path: state, text: JSON.stringify(move) }, aborted.signal);
        assert(cancelled.isError && await count("manage_window") === 0, "Pre-dispatch cancellation mutated the source");
        state = await stateRead(first); await control("close_first");
        await denied("read", { path: state }); await denied("insert", { path: state, text: JSON.stringify(move) });
        state = await stateRead(second); await control("reuse_second");
        await denied("insert", { path: state, text: JSON.stringify(move) });
        assert(await count("manage_window") === 0, "Closed/reused source sent native mutation");
        mode = "yolo";
        const replacement = reference(await ok("search", { path: "computer:machine/local/windows", query: "Owned management fixture 92" }), "window");
        state = await stateRead(replacement); await control("reused_after_dispatch", 92);
        const reused = await denied("insert", { path: state, text: JSON.stringify(move) });
        assert(semantic(reused).effect === "unknown" && find(reused, "postcondition_confirmed") === true,
          "Post-dispatch reuse became success or discarded completed prefix");
        await denied("insert", { path: state, text: JSON.stringify(move) });
        assert(await count("manage_window") === 1, "Post-dispatch reuse was replayed");
      } else if (scenario === "receipts") {
        for (const operation of ["refused", "partial", "final_cancel", "wrong_state", "wrong_window", "wrong_operation", "wrong_route",
          "missing_focus", "missing_prefix", "missing_receipt", "wrong_request", "wrong_before", "constrained", "changed_source", "contradictory_foreground"]) {
          await control("reset"); state = await stateRead(first); await control(operation);
          const result = await denied("insert", { path: state, text: JSON.stringify(move) }), action = semantic(result);
          assert(action.effect === (operation === "refused" ? "not-applied" : "unknown"), `Wrong effect for ${operation}: ${body(result)}`);
          if (["partial", "final_cancel"].includes(operation)) assert(find(result, "mutation_attempted") === true, `${operation} lost attempted prefix`);
          if (operation === "final_cancel") assert(find(result, "postcondition_confirmed") === true, "Final cancellation lost completed prefix");
          const before = await count("manage_window");
          await denied("insert", { path: state, text: JSON.stringify(move) }); await denied("read", { path: state });
          assert(await count("manage_window") === before, `${operation} was replayed`);
        }
        await control("reset"); state = await stateRead(first);
        const abortAfter = new AbortController(); cancelAfterDispatch = abortAfter;
        const cancelled = await call("insert", { path: state, text: JSON.stringify(move) }, abortAfter.signal);
        assert(cancelled.isError && semantic(cancelled).effect === "unknown" && find(cancelled, "postcondition_confirmed") === true,
          `Cancellation after native completion discarded the delivered prefix: ${body(cancelled)}`);
        const countAfter = await count("manage_window");
        await denied("insert", { path: state, text: JSON.stringify(move) });
        assert(await count("manage_window") === countAfter, "Post-dispatch cancellation was replayed");
      } else {
        await control("minimized"); state = await stateRead(first);
        const focus = await denied("insert", { path: state, text: '{"action":"focus"}' });
        assert(semantic(focus).effect === "not-applied" && find(focus, "mutation_attempted") === false && await count("restore_window") === 0,
          "Focus implicitly restored or activated a minimized target");
        state = await stateRead(first);
        const restored = await insert(state, { action: "restore" });
        assert(!restored.isError && semantic(restored).effect === "applied" && find(restored, "restore_requested") === true,
          `Control admission lost existing restore: ${body(restored)}`);
        await denied("insert", { path: state, text: JSON.stringify(move) });
        for (const situation of ["other_desktop", "unknown_desktop"]) {
          await control("reset"); await control(situation); state = await stateRead(first);
          const result = await denied("insert", { path: state, text: '{"action":"focus"}' });
          assert(semantic(result).effect === "not-applied" && find(result, "mutation_attempted") === false,
            `${situation} activation implicitly switched desktops`);
        }
        management = false; await control("reset"); await control("minimized"); state = await stateRead(first);
        const legacyReads = await count("get_window_status"), managementBefore = await count("manage_window");
        await ok("read", { path: state });
        await denied("insert", { path: state, text: JSON.stringify(move) });
        assert(await count("manage_window") === managementBefore && await count("get_window_status") === legacyReads,
          "Restore-only state borrowed management authority or silently refreshed state");
        state = await stateRead(first);
        const legacy = await insert(state, { action: "restore" });
        assert(!legacy.isError && find(legacy, "restore_requested") === true, `Legacy flat restore changed: ${body(legacy)}`);
        restoration = false;
        const before = await count("get_window_status");
        await denied("read", { path: first, views: ["state"] });
        assert(await count("get_window_status") === before, "Unqualified runtime acquired native state");
      }
      const rows = await journal();
      assert(rows.every(row => ["fixture_identity", "fixture_control", "list_apps", "list_windows", "launch_app", "get_window_state",
        "get_window_status", "get_window_control_state", "restore_window", "manage_window"].includes(row.name)),
        "Management used hidden input, desktop capture or activation fallback");
      await ok("insert", { path: "computer:session", text: '{"action":"close"}' });
      return { content: [{ type: "text" as const, text: `IDE window management ${scenario} contract passed` }],
        details: { scenario, mutations: rows.filter(row => row.name === "manage_window").length } };
    },
  });
  pi.on("session_shutdown", async () => { await session?.close(); });
}
