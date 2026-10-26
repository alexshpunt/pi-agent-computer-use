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
function reference(result: Result, kind: "window" | "observation"): string {
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
  const [{ registerComputerProvider }, { loadComputerConfig }, { McpDriver }, { ComputerSession }, { registerComputerTools }] =
    await Promise.all([load("provider.ts"), load("config.ts"), load("driver.ts"), load("session.ts"), load("computer-tools.ts")]);
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
  const provider = await registerComputerProvider(pi, getSession, close);
  registerComputerTools(pi, provider.resources);
  pi.registerTool({
    name: "verify_window_management", label: "Verify one-use window management",
    description: "Exercise real IDE state and management with synthetic MCP receipts only.",
    parameters: Type.Object({ scenario: Type.Union([Type.Literal("workflow"), Type.Literal("admission"), Type.Literal("receipts"), Type.Literal("restore"), Type.Literal("typed")]) }),
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
      // A state Read only looks: no pixels, no address that grants anything, and the window's observations stay.
      const stateRead = async (window: string) => {
        const result = await ok("read", { path: window, views: ["state"] });
        assert(result.content.every(block => block.type !== "image"), "Management state granted pixels");
        assert(!/computer:window-state\//.test(body(result)), `State Read issued a window-state address: ${body(result)}`);
        if (management) {
          assert(find(result, "coordinate_space") === "windows_desktop_pixels" && find(result, "bounds_source") !== undefined,
            `State lost explicit desktop bounds source: ${body(result)}`);
          assert(find(result, "virtual_desktop") !== undefined, `State dropped native desktop membership: ${body(result)}`);
        }
        return result;
      };
      // computer_window samples the window's state itself and sends one command against that sample.
      const manage = (window: string, command: Record<string, unknown>, callSignal = signal) => call("computer_window", { window, ...command }, callSignal);
      const move = { action: "move", x: -20, y: 120 };
      const open = async () => reference(await ok("computer_open", { at: "computer:machine/local", app: "Notepad" }), "window");
      assert(!pi.getAllTools().some(tool => /^computer_(read|search|delete)$/.test(tool.name)), "Standalone computer tools leaked into the IDE provider");
      const first = await open(), second = await open();
      const listed = await ok("search", { path: "computer:machine/local/windows", query: "Owned management fixture" });
      assert(body(listed).includes(first) && body(listed).includes(second), "Search lost exact-source references");
      await stateRead(first);
      if (scenario === "workflow") {
        const invalid = [
          { action: "move", x: 1 }, { ...move, x: 100001 }, { ...move, y: -100001 },
          { action: "resize", width: 0, height: 80 }, { action: "resize", width: 32768, height: 80 },
          { ...move, width: 10 }, { ...move, unit: "css_pixels" }, { ...move, pid: 42 }, { ...move, state_id: "foreign" }, { ...move, delivery_mode: "foreground" },
          { action: "minimize", x: 1 }, { action: "maximize", height: 5 }, { action: "click", x: 1, y: 1 },
        ];
        // Write and Insert never act on a window; they name the tool that does.
        assert(body(await denied("write", { path: first, content: "never type" })).includes("computer_type"), "Write refusal named no tool");
        assert(body(await denied("insert", { path: first, text: JSON.stringify(move) })).includes("computer_window"), "Insert refusal named no tool");
        for (const command of invalid) {
          const result = await call("computer_window", { window: first, ...command });
          assert(result.isError, `computer_window accepted ${JSON.stringify(command)}: ${body(result).split("\n")[0]}`);
        }
        assert(await count("manage_window") === 0, "Invalid geometry reached native mutation");
        const result = await manage(first, move);
        assert(!result.isError && semantic(result).effect === "applied", `Valid desktop move failed: ${body(result)}`);
        assert(find(result, "mutation_attempted") === true && find(result, "postcondition_confirmed") === true,
          "Delivered management discarded native completion prefix");
        for (const command of [{ action: "resize", width: 180, height: 120 }, { action: "focus" }, { action: "maximize" }, { action: "minimize" }]) {
          await control("reset");
          const result = await manage(first, command);
          assert(!result.isError && semantic(result).effect === "applied", `Valid ${command.action} failed: ${body(result)}`);
        }
        await control("reset"); await control("outer_bounds");
        const outer = await manage(first, move);
        assert(!outer.isError && find(outer, "bounds_source") === "window_rect", "Explicit outer bounds became visible-frame coordinates");
        // A state Read between a UI Read and input keeps the UI observation's refs current.
        const ui = await ok("read", { path: first, views: ["ui"] });
        await stateRead(first);
        await ok("read", { path: reference(ui, "observation") });
        assert(await count("manage_window") === 6, "Read-only state sent a mutation");
      } else if (scenario === "admission") {
        const external = reference(await ok("search", { path: "computer:machine/local/windows", query: "Unowned management fixture" }), "window");
        await stateRead(external); mode = "safe";
        const refused = await denied("computer_window", { window: external, ...move });
        assert(semantic(refused).effect === "not-applied", "Safe denial lost no-dispatch effect");
        assert(await count("manage_window") === 0, "Safe denial dispatched management");
        const aborted = new AbortController(); aborted.abort();
        const cancelled = await manage(first, move, aborted.signal);
        assert(cancelled.isError && await count("manage_window") === 0, "Pre-dispatch cancellation mutated the source");
        await control("close_first");
        await denied("computer_window", { window: first, ...move });
        await control("reuse_second");
        await denied("computer_window", { window: second, ...move });
        assert(await count("manage_window") === 0, "Closed/reused source sent native mutation");
        mode = "yolo";
        const replacement = reference(await ok("search", { path: "computer:machine/local/windows", query: "Owned management fixture 92" }), "window");
        await control("reused_after_dispatch", 92);
        const reused = await denied("computer_window", { window: replacement, ...move });
        assert(semantic(reused).effect === "unknown" && find(reused, "postcondition_confirmed") === true,
          "Post-dispatch reuse became success or discarded completed prefix");
        assert(await count("manage_window") === 1, "Post-dispatch reuse sent an extra mutation");
      } else if (scenario === "typed") {
        const window = (args: Record<string, unknown>, target = first) => call("computer_window", { window: target, ...args });
        for (const bad of [{ action: "move", x: 1 }, { action: "maximize", x: 1 }, { action: "resize", width: 10 }, { action: "restore", y: 2 }]) {
          const result = await window(bad);
          assert(result.isError, `computer_window accepted ${JSON.stringify(bad)}: ${body(result)}`);
        }
        await denied("computer_window", { window: "computer:machine/local", action: "focus" });
        assert(await count("manage_window") === 0, "Invalid computer_window calls reached native management");
        const moved = await window({ action: "move", x: -20, y: 120 });
        assert(!moved.isError && semantic(moved).effect === "applied" && body(moved).includes("on local"), `computer_window move failed: ${body(moved)}`);
        await control("reset");
        const resized = await window({ action: "resize", width: 180, height: 120 });
        assert(!resized.isError && semantic(resized).effect === "applied", `computer_window resize failed: ${body(resized)}`);
        await control("reset");
        assert(!(await window({ action: "maximize" })).isError, "computer_window maximize failed");
        await control("reset"); await control("minimized");
        const restored = await window({ action: "restore" });
        assert(!restored.isError && find(restored, "restore_requested") === true, `computer_window restore failed: ${body(restored)}`);
        await control("reset");
        // computer_wait samples the window's UI and sends nothing: the synthetic walk is complete and empty.
        const button = "getByRole('button', { name: 'Save' })";
        const absent = await call("computer_wait", { window: first, mode: "check", conditions: [{ target: button, is: "absent" }] });
        assert(!absent.isError && find(absent, "verdict") === "satisfied", `computer_wait check failed: ${body(absent)}`);
        const waited = await call("computer_wait", { window: first, timeout_ms: 300, conditions: [{ target: button, is: "exists" }] });
        assert(find(waited, "verdict") === "unsatisfied" && find(waited, "timed_out") === true, `computer_wait did not time out: ${body(waited)}`);
        await denied("computer_wait", { window: "computer:machine/local", conditions: [{ target: button, is: "exists" }] });
        await denied("computer_wait", { window: first, mode: "check", timeout_ms: 10, conditions: [{ target: button, is: "exists" }] });
        await denied("computer_browser", { window: first, action: "reload" });
        await denied("computer_files", { machine: first, action: "list" });
        await denied("computer_clipboard", { machine: "computer:machine/local/windows", action: "read" });
        await denied("computer_record", { at: first, action: "video_start", seconds: 5 });
        await denied("computer_record", { at: "computer:machine/local", action: "sequence", duration_ms: 100 });
        // Input tools check the address, the target and the fields before anything reaches the window.
        await denied("computer_click", { window: "computer:machine/local", target: "1:a" });
        await denied("computer_click", { window: first, target: "e3" });
        await denied("computer_click", { window: first, target: "9:z" });
        await denied("computer_click", { window: first, x: 5 });
        await denied("computer_type", { window: first, text: "x", replace: true });
        await denied("computer_press", { window: first, key: "hyper+a" });
        await denied("computer_select", { window: first, target: "1:a", checked: true, values: ["a"] });
        const external = reference(await ok("search", { path: "computer:machine/local/windows", query: "Unowned management fixture" }), "window");
        mode = "safe";
        const refused = await window({ action: "focus" }, external);
        assert(refused.isError && semantic(refused).effect === "not-applied", `Safe mode let computer_window manage a foreign window: ${body(refused)}`);
        mode = "yolo";
      } else if (scenario === "receipts") {
        for (const operation of ["refused", "partial", "final_cancel", "wrong_state", "wrong_window", "wrong_operation", "wrong_route",
          "missing_focus", "missing_prefix", "missing_receipt", "wrong_request", "wrong_before", "constrained", "changed_source", "contradictory_foreground"]) {
          await control("reset"); await control(operation);
          const result = await denied("computer_window", { window: first, ...move }), action = semantic(result);
          assert(action.effect === (operation === "refused" ? "not-applied" : "unknown"), `Wrong effect for ${operation}: ${body(result)}`);
          if (["partial", "final_cancel"].includes(operation)) assert(find(result, "mutation_attempted") === true, `${operation} lost attempted prefix`);
          if (operation === "final_cancel") assert(find(result, "postcondition_confirmed") === true, "Final cancellation lost completed prefix");
        }
        await control("reset");
        const abortAfter = new AbortController(); cancelAfterDispatch = abortAfter;
        const cancelled = await manage(first, move, abortAfter.signal);
        assert(cancelled.isError && semantic(cancelled).effect === "unknown" && find(cancelled, "postcondition_confirmed") === true,
          `Cancellation after native completion discarded the delivered prefix: ${body(cancelled)}`);
      } else {
        await control("minimized");
        const focus = await denied("computer_window", { window: first, action: "focus" });
        assert(semantic(focus).effect === "not-applied" && find(focus, "mutation_attempted") === false && await count("restore_window") === 0,
          "Focus implicitly restored or activated a minimized target");
        const restored = await manage(first, { action: "restore" });
        assert(!restored.isError && semantic(restored).effect === "applied" && find(restored, "restore_requested") === true,
          `Control admission lost existing restore: ${body(restored)}`);
        for (const situation of ["other_desktop", "unknown_desktop"]) {
          await control("reset"); await control(situation);
          const result = await denied("computer_window", { window: first, action: "focus" });
          assert(semantic(result).effect === "not-applied" && find(result, "mutation_attempted") === false,
            `${situation} activation implicitly switched desktops`);
        }
        management = false; await control("reset"); await control("minimized");
        const managementBefore = await count("manage_window");
        await stateRead(first);
        const refused = await denied("computer_window", { window: first, ...move });
        assert(/only restore and activate/.test(body(refused)), `Restore-only runtime refusal changed: ${body(refused)}`);
        assert(await count("manage_window") === managementBefore, "Restore-only state borrowed management authority");
        const legacy = await manage(first, { action: "restore" });
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
      await ok("delete", { path: "computer:session" });
      return { content: [{ type: "text" as const, text: `IDE window management ${scenario} contract passed` }],
        details: { scenario, mutations: rows.filter(row => row.name === "manage_window").length } };
    },
  });
  pi.on("session_shutdown", async () => { await session?.close(); });
}
