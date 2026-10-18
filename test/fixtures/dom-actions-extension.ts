import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ComputerMode, ComputerResult, ComputerSession, WindowTarget } from "../../src/session.ts";
import type { DomActionReceipt } from "../../src/dom-action.ts";
import type { DomResource } from "../../src/dom-resource.ts";

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
  const found = body(result).match(new RegExp(`computer:${kind}/[a-zA-Z0-9-]+`));
  assert(found, `No ${kind} source in ${body(result)}`); return found[0];
}

/** Real ordinary IDE and CodeMode calls against a synthetic MCP peer; never native GUI input. */
export default async function fixture(pi: ExtensionAPI): Promise<void> {
  createCodemodeExtension({ mode: "on" })(pi);
  const source = process.env.PI_DOM_ACTION_PROVIDER_SOURCE ?? path.resolve(import.meta.dirname, "../..");
  const load = (name: string) => import(pathToFileURL(path.join(source, "src", name)).href);
  const [{ registerComputerProvider }, { loadComputerConfig }, { McpDriver }, { ComputerSession }, { ReactiveAnimationDriver }] =
    await Promise.all([load("provider.ts"), load("config.ts"), load("driver.ts"), load("session.ts"), load("reactive-animation.ts")]);
  const Base = McpDriver as typeof import("../../src/driver.ts").McpDriver;
  let mode: ComputerMode = "yolo", session: ComputerSession | undefined, driver: FixtureDriver | undefined, log: string | undefined;
  class FixtureDriver extends Base {
    get platform() { return "windows" as const; }
    // Only qualification/lifetime are simulated; production transport and wrapper still run.
    get domInspection() { return true; }
    get domActions() { return true; }
    async identity(target: WindowTarget, _create: boolean, signal?: AbortSignal) {
      return (await this.call("fixture_identity", target as unknown as Record<string, unknown>, signal)).structuredContent?.identity as string | undefined;
    }
  }
  const getSession = async (cwd: string): Promise<ComputerSession> => {
    if (!driver) { const config = await loadComputerConfig(cwd); log = config.args![1]; driver = new FixtureDriver(config); }
    session ??= new ComputerSession(new ReactiveAnimationDriver(driver, { glide_duration_ms: 1 }), () => mode);
    return session!;
  };
  const close = async (): Promise<ComputerResult> => session ? session.close() : { content: [], details: { status: "closed", mode } };
  await registerComputerProvider(pi, getSession, close);
  pi.on("session_shutdown", async () => { await close(); });
  pi.registerTool({
    name: "prepare_dom_action_source", label: "Prepare synthetic DOM source", description: "Use this fixture to obtain one synthetic DOM source for CodeMode; it opens no application.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      const call = async (name: string, args: Record<string, unknown>): Promise<Result> => {
        const result = await ctx.executeTool(name, args, { signal });
        assert(!result.isError, `${name} refused the synthetic CodeMode source`);
        return result.result as Result;
      };
      assert(!pi.getAllTools().some(tool => /^(browser_|computer_)/.test(tool.name)), "Separate browser/computer tools escaped into the provider");
      const window = reference(await call("search", { path: "computer:windows", query: "DOM action fixture" }), "window");
      const result = await call("read", { path: window, views: ["dom"] }), dom = find(result.details, "dom") as DomResource | undefined;
      assert(dom?.elements.length === 1, "CodeMode source lost its readonly DOM hint");
      return { content: [{ type: "text", text: JSON.stringify({ path: reference(result, "observation"), hint: dom.elements[0].hint }) }], details: {} };
    },
  });
  pi.registerTool({
    name: "verify_dom_actions", label: "Verify locator DOM actions", description: "Use this fixture to verify ordinary IDE and CodeMode DOM action receipts without a GUI.",
    parameters: Type.Object({ scenario: Type.Union([Type.Literal("workflow"), Type.Literal("admission")]) }),
    async execute(_id, { scenario }, signal, _update, ctx) {
      const call = async (name: string, args: Record<string, unknown>): Promise<Result> => {
        try { const result = await ctx.executeTool(name, args, { signal }); return { ...result.result, isError: result.isError } as Result; }
        catch (error) { return { isError: true, content: [{ type: "text", text: String(error) }] }; }
      };
      const ok = async (name: string, args: Record<string, unknown>) => {
        const result = await call(name, args); assert(!result.isError, `${name} failed: ${body(result)}`); return result;
      };
      const denied = async (name: string, args: Record<string, unknown>) => {
        const result = await call(name, args); assert(result.isError, `${name} accepted forbidden input: ${body(result)}`); return result;
      };
      const journal = async (): Promise<Row[]> => (await readFile(log!, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const actions = async () => (await journal()).filter(row => row.name === "browser_dom_action");
      const control = (operation: string) => driver!.call("fixture_control", { operation }, signal);
      const window = reference(await ok("search", { path: "computer:windows", query: "DOM action fixture" }), "window");
      const read = async () => {
        const result = await ok("read", { path: window, views: ["dom"] });
        const dom = find(result.details, "dom") as DomResource | undefined;
        assert(dom?.elements.length === 1, "Fresh DOM source lost its inspected element");
        assert(result.content.every(block => block.type !== "image"), "DOM action source acquired pixels");
        return { path: reference(result, "observation"), hint: dom.elements[0].hint };
      };
      const command = (hint: string, action = "click") => ({ action: "dom", source_hint: hint, input_route: "dom_event",
        request: { action, locator: { test_id: "name" }, timeout_ms: 1000, ...(action === "fill" ? { text: "private typed value" } : {}) } });
      const insert = (source: { path: string; hint: string }, action = "click") => call("insert", { path: source.path, text: JSON.stringify(command(source.hint, action)) });
      const consumed = async (source: { path: string; hint: string }, before: number) => {
        await denied("insert", { path: source.path, text: JSON.stringify(command(source.hint)) });
        await denied("read", { path: source.path });
        assert((await actions()).length === before, "A consumed DOM source was replayed or silently refreshed");
      };
      assert(!pi.getAllTools().some(tool => /^(browser_|computer_)/.test(tool.name)), "Separate browser/computer tools escaped into the production provider");
      if (scenario === "workflow") {
        const first = await read(), delivered = await insert(first, "fill");
        const receipt = find(delivered.details, "dom_action") as DomActionReceipt | undefined;
        assert(!delivered.isError, `Acknowledged fill became a failed tool call: ${body(delivered)}`);
        assert(receipt?.status === "dispatched" && receipt.action_result.effect === "unverifiable" && receipt.progress.acknowledged_steps.join() === "focus,beforeinput,fill,input,change",
          `Native fill prefix was lost across the real semantic Insert boundary: ${body(delivered)}`);
        assert(find(delivered.details, "effect") === "unknown", "Dispatch was promoted to verified application success");
        assert(!/bt-action|tab-action|p[0-9]+:[0-9]+|private typed value/.test(JSON.stringify(delivered.details)), "Private native references or input text leaked into the receipt");
        assert(body(delivered).includes("effects=unverified") && body(delivered).includes("acknowledged"), "Human receipt hid dispatch uncertainty or its prefix");
        await consumed(first, 1);
        const second = await read();
        const clicked = await insert(second), clickReceipt = find(clicked.details, "dom_action") as DomActionReceipt | undefined;
        assert(clickReceipt?.status === "dispatched" && clickReceipt.progress.acknowledged_steps.join() === "click", "Ordinary click lost its native dispatch prefix");
        assert(!clicked.isError, `Acknowledged click became a failed tool call: ${body(clicked)}`);
        await consumed(second, 2);
        const third = await read(); await control("unknown");
        const unknown = await insert(third, "double_click"), prefix = find(unknown.details, "dom_action") as DomActionReceipt | undefined;
        assert(unknown.isError, "An unknown in-flight effect became a successful tool call");
        assert(prefix?.progress.in_flight === "dblclick" && prefix.progress.acknowledged_steps.join() === "click,click" && prefix.progress.automatic_retry === false,
          `Unknown dispatch lost its acknowledged prefix: ${body(unknown)}`);
        assert(find(unknown.details, "effect") === "unknown" && find(unknown.details, "status") === "unknown", "Partial mutation became a known no-effect refusal");
        await consumed(third, 3);
        const fourth = await read(); await control("diagnostic");
        const diagnostic = await insert(fourth), diagnosticPrefix = find(diagnostic.details, "dom_progress") as { in_flight?: string; acknowledged_steps?: string[] } | undefined;
        assert(diagnostic.isError, "An incomplete diagnostic prefix became a successful tool call");
        assert(diagnosticPrefix?.in_flight === "click" && diagnosticPrefix.acknowledged_steps?.length === 0 && find(diagnostic.details, "effect") === "unknown",
          `MCP diagnostic prefix disappeared: ${body(diagnostic)}`);
        await consumed(fourth, 4);
        const fifth = await read(); await control("malformed");
        const malformed = await insert(fifth);
        assert(malformed.isError, "A malformed native receipt became a successful tool call");
        assert(find(malformed.details, "effect") === "unknown" && find(malformed.details, "dom_action") === undefined && !JSON.stringify(malformed.details).includes("backendNodeId"),
          "Malformed native payload was accepted or leaked raw capabilities");
        await consumed(fifth, 5);
      } else {
        const source = await read(), valid = command(source.hint);
        await denied("write", { path: source.path, content: "Readonly hints are not typing authority" });
        for (const value of [
          { action: "click", hint: source.hint }, { ...valid, target_id: "foreign" }, { ...valid, tab_id: "foreign" },
          { ...valid, source_ref: "p1:0" }, { ...valid, window_ref: "foreign" }, { ...valid, observation_id: "foreign" },
          { ...valid, input_route: undefined }, { ...valid, input_route: "automatic" },
          { ...valid, request: { ...valid.request, x: 1, y: 2 } }, { ...valid, request: { action: "fill", locator: { test_id: "name" } } },
        ]) await denied("insert", { path: source.path, text: JSON.stringify(value) });
        for (const suffix of ["?hint=1%3Aa", "?delivery=foreground", "?delay_ms=1"])
          await denied("insert", { path: source.path + suffix, text: JSON.stringify(valid) });
        await denied("insert", { path: source.path, text: JSON.stringify(valid), anchor: "end" });
        assert((await actions()).length === 0, "Invalid identity, route, coordinate or address field reached native input");
        await ok("read", { path: source.path });
        const trusted = await call("insert", { path: source.path, text: JSON.stringify({ ...valid, input_route: "trusted" }) });
        const refusal = find(trusted.details, "dom_action") as DomActionReceipt | undefined;
        assert(trusted.isError, "An unavailable trusted route became a successful tool call");
        assert(refusal?.input_route === "trusted" && refusal.refusal?.code === "browser_input_trust_unavailable" && !refusal.progress.mutation_attempted,
          `Unsupported trusted intent downgraded or lost its no-dispatch result: ${body(trusted)}`);
        assert(find(trusted.details, "effect") === "not-applied", "Predispatch trust refusal became applied or unknown");
        await consumed(source, 1);
        const foreign = await read();
        await denied("insert", { path: foreign.path, text: JSON.stringify({ ...command(foreign.hint), source_hint: "foreign:a" }) });
        assert((await actions()).length === 1, "A foreign readonly source hint reached native DOM input");
        const blocked = await read(); mode = "safe";
        await denied("insert", { path: blocked.path, text: JSON.stringify(command(blocked.hint)) });
        assert((await actions()).length === 1, "Safe mode admitted an unowned DOM mutation");
        mode = "yolo";
      }
      await ok("insert", { path: "computer:session", text: '{"action":"close"}' });
      const rows = await journal();
      assert(rows.every(row => ["fixture_identity", "fixture_control", "list_windows", "start_session", "end_session", "get_browser_state", "browser_dom_action"].includes(row.name)),
        "Native coordinates, browser preparation, capture or another input fallback escaped the DOM route");
      assert(rows.filter(row => row.name === "start_session").length === 1 && rows.filter(row => row.name === "end_session").length === 1, "Owned native browser session was not released exactly once");
      return { content: [{ type: "text", text: `IDE DOM actions ${scenario} contract passed` }], details: { scenario, nativeActions: (await actions()).length } };
    },
  });
}
