import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ComputerMode, ComputerResult, ComputerSession, WindowTarget } from "../../src/session.ts";
import type { DomResource, DomGeometryResource } from "../../src/dom-resource.ts";

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
  assert(found, `No ${kind} resource: ${body(result)}`); return found[0];
}
function dom(result: Result): DomResource {
  const value = find(result.details, "dom");
  assert(value && typeof value === "object", `No structured readonly DOM resource: ${body(result)}`);
  return value as DomResource;
}

function geometry(result: Result): DomGeometryResource {
  const value = find(result.details, "dom_geometry");
  assert(value && typeof value === "object", `No structured readonly CSS geometry: ${body(result)}`);
  return value as DomGeometryResource;
}

/** Exercise ordinary IDE tools against a synthetic MCP peer, not an installed Windows runtime. */
export default async function fixture(pi: ExtensionAPI): Promise<void> {
  const source = process.env.PI_DOM_INSPECTION_PROVIDER_SOURCE ?? path.resolve(import.meta.dirname, "../..");
  const load = (name: string) => import(pathToFileURL(path.join(source, "src", name)).href);
  const [{ registerComputerProvider }, { loadComputerConfig }, { McpDriver }, { ComputerSession }, { ReactiveAnimationDriver }] =
    await Promise.all([load("provider.ts"), load("config.ts"), load("driver.ts"), load("session.ts"), load("reactive-animation.ts")]);
  const Base = McpDriver as typeof import("../../src/driver.ts").McpDriver;
  let mode: ComputerMode = "yolo", session: ComputerSession | undefined, driver: FixtureDriver | undefined, log: string | undefined;
  let cancelAfterSnapshot: AbortController | undefined;
  class FixtureDriver extends Base {
    get platform() { return "windows" as const; }
    // The actual transport, schema negotiation and wrapper remain production code. This flag admits the synthetic peer only.
    get domInspection() { return true; }
    async call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      const result = await super.call(name, args, signal);
      if (name === "get_browser_state" && args.snapshot_format && cancelAfterSnapshot) {
        const controller = cancelAfterSnapshot; cancelAfterSnapshot = undefined; controller.abort();
      }
      return result;
    }
    async identity(target: WindowTarget, _create: boolean, signal?: AbortSignal) {
      return (await this.call("fixture_identity", target as unknown as Record<string, unknown>, signal)).structuredContent?.identity as string | undefined;
    }
  }
  const getSession = async (cwd: string): Promise<ComputerSession> => {
    if (!driver) { const config = await loadComputerConfig(cwd); log = config.args![1]; driver = new FixtureDriver(config); }
    session ??= new ComputerSession(new ReactiveAnimationDriver(driver, { glide_duration_ms: 1 }), () => mode);
    return session!;
  };
  const close = async (): Promise<ComputerResult> => session ? session.close() : {
    content: [{ type: "text", text: "No synthetic runtime is running." }], details: { status: "closed", mode },
  };
  await registerComputerProvider(pi, getSession, close);
  pi.registerTool({
    name: "verify_dom_inspection", label: "Verify readonly window DOM",
    description: "Exercise real ordinary IDE DOM operations against a synthetic MCP peer only.",
    parameters: Type.Object({ scenario: Type.Union([Type.Literal("workflow"), Type.Literal("admission"), Type.Literal("receipts")]) }),
    async execute(_id, { scenario }, signal, _update, ctx) {
      const call = async (name: string, args: Record<string, unknown>, callSignal = signal): Promise<Result> => {
        try { const result = await ctx.executeTool(name, args, { signal: callSignal }); return { ...result.result, isError: result.isError } as Result; }
        catch (error) { return { isError: true, content: [{ type: "text", text: String(error) }] }; }
      };
      const ok = async (name: string, args: Record<string, unknown>, callSignal = signal) => {
        const result = await call(name, args, callSignal); assert(!result.isError, `${name} failed: ${body(result)}`); return result;
      };
      const denied = async (name: string, args: Record<string, unknown>, callSignal = signal) => {
        const result = await call(name, args, callSignal); assert(result.isError, `${name} accepted invalid readonly authority: ${body(result)}`); return result;
      };
      const journal = async (): Promise<Row[]> => (await readFile(log!, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const snapshots = async () => (await journal()).filter(row => row.arguments.snapshot_format === "dom_inspect_v1" && row.arguments.geometry_ref === undefined);
      const geometryReads = async () => (await journal()).filter(row => row.arguments.geometry_ref !== undefined);
      const control = (operation: string, window_id = 91) => driver!.call("fixture_control", { operation, window_id }, signal);
      const window = async (id = 91) => reference(await ok("search", { path: "computer:windows", query: `Readonly DOM fixture ${id}` }), "window");
      const read = (target: string, options?: Record<string, unknown>) => ok("read", { path: target, views: [options ? `dom:${JSON.stringify(options)}` : "dom"] });
      assert(!pi.getAllTools().some(tool => /^browser_|^computer_/.test(tool.name)), "Separate browser/computer tools leaked into the provider");
      const first = await window();
      if (scenario === "workflow") {
        const view = await read(first, { include_hidden: true, max_nodes: 4, max_depth: 12 });
        const resource = dom(view), observation = reference(view, "observation");
        assert(view.content.every(block => block.type !== "image") && find(view.details, "ui") === undefined, "DOM acquired pixels or UI input authority");
        assert(resource.elements.length === 4 && resource.collection_complete === false && resource.omitted.frames === 1, "Partial frame coverage became complete");
        assert(resource.elements.filter(row => row.name === "Advance").length === 3, "Duplicate accessible names were silently ranked away");
        const checkbox = resource.elements.find(row => row.role === "checkbox");
        assert(checkbox?.value === "live value" && checkbox.states.checked === true && checkbox.attributes["data-testid"] === "enabled", "Live states/attributes were lost");
        assert(resource.elements[1].frame.ref === "df-frame" && resource.elements[1].frame.kind === "iframe", "Frame-qualified source identity was lost");
        assert(resource.elements.every(row => row.bounds_css === null) && find(resource, "geometry_status") === "unqualified_native_layout_units",
          "Unqualified native layout units were exposed as proven CSS/native crop geometry");
        assert(resource.elements.every(row => !("ref" in row) && !("actions" in row)), "Native readonly refs became exposed action capabilities");
        const before = (await snapshots()).length;
        const cached = await ok("read", { path: observation });
        assert(reference(cached, "observation") === observation, "Cached read renewed snapshot identity");
        const none = dom(await ok("search", { path: observation, query: "not in this collection", limit: 2 }));
        assert(none.elements.length === 0 && none.collection_complete === false && none.returned_count === 4, "Local empty search claimed native absence or rewrote coverage");
        await ok("read", { path: observation, views: [`element:inspect,${checkbox.hint}`] });
        await denied("read", { path: observation, views: [`element:crop,${checkbox.hint}`] });
        await denied("write", { path: observation, content: "never type" });
        await denied("insert", { path: observation, text: '{"action":"click","x":10,"y":20}' });
        await denied("read", { path: first, views: ['dom:{"target_id":"foreign"}'] });
        assert((await snapshots()).length === before, "Cached inspection or invalid fields dispatched a hidden DOM walk");
        const sample = await ok("read", { path: observation, views: [`element:geometry,${checkbox.hint}`] });
        const measured = geometry(sample);
        assert(measured.window_ref === resource.window_ref && measured.observation_id === resource.observation_id &&
          measured.hint === checkbox.hint && measured.frame.ref === checkbox.frame.ref, "Geometry lost its model-visible readonly source");
        assert(measured.coordinate_space === "frame_viewport_css_pixels" && measured.viewport === "layout" &&
          measured.native_pixel_mapping === "unavailable" && measured.atomic === false && measured.bounds.x === 10.25,
          "CSS sample was converted or claimed native-pixel/atomic authority");
        assert(sample.content.every(block => block.type !== "image") && find(sample.details, "ui") === undefined &&
          find(sample.details, "agent_image") === undefined && find(sample.details, "action_capability") === undefined,
          "CSS geometry minted image or input authority");
        assert(!/bt-91|tab-91|p[0-9]+:[0-9]+/.test(JSON.stringify(sample.details)), "Native capabilities leaked into the geometry result");
        await ok("read", { path: observation, views: [`element:geometry,${checkbox.hint}`] });
        const geometryCount = (await geometryReads()).length;
        await denied("read", { path: observation, views: [`element:geometry,${resource.elements[1].hint}`] });
        assert((await geometryReads()).length === geometryCount, "Child-frame geometry reached native sampling");
        assert((await snapshots()).length === before, "Geometry silently resnapshotted or changed source metadata");
        assert(dom(await ok("read", { path: observation })).elements.every(row => row.bounds_css === null),
          "Fresh viewport CSS sample overwrote cached unqualified document geometry");
        await denied("write", { path: observation, content: "geometry is not typing authority" });
        await denied("insert", { path: observation, text: '{"action":"click","x":10.25,"y":20.5}' });
        const scoped = await ok("read", { path: observation, views: [`element:scope,${resource.elements[1].hint}`] });
        assert(dom(scoped).scope === "subtree" && dom(scoped).elements[0].frame.ref === "df-frame", "Frame-qualified scope changed source");
        const request = (await snapshots()).at(-1)!.arguments;
        assert(request.scope_ref === `${resource.snapshot_id}:1` && request.target_id === "bt-91" && request.tab_id === "tab-91", "Scope did not translate the exact current readonly ref");
        await denied("read", { path: observation });
        const current = reference(scoped, "observation");
        await denied("read", { path: current, views: [`element:inspect,${checkbox.hint}`] });
        await ok("read", { path: first, views: ["ui"] }); await denied("read", { path: current });
        const ui = await ok("read", { path: first, views: ["ui"] }), uiRef = reference(ui, "observation");
        await denied("read", { path: uiRef, views: ["element:geometry,1:a"] });
        const final = await read(first, { locator: { role: "button", name: "Advance" }, max_nodes: 1 });
        assert(dom(final).truncated === true && dom(final).matched_count === 2 && dom(final).elements.length === 1, "Bounded exact locator hid duplicate/truncation evidence");
        await denied("write", { path: uiRef, content: "retired UI" });
        const bindings = (await journal()).filter(row => row.name === "get_browser_state" && row.arguments.pid !== undefined);
        assert(bindings.length === 2, "Scoped DOM silently rebound or refreshed the native binding");
      } else if (scenario === "admission") {
        const view = await read(first), observation = reference(view, "observation"), before = (await snapshots()).length;
        mode = "safe";
        await denied("read", { path: observation, views: [`element:geometry,${dom(view).elements[0].hint}`] });
        assert((await geometryReads()).length === 0, "Safe mode dispatched geometry before permission admission");
        await denied("read", { path: observation }); await denied("read", { path: first, views: ["dom"] });
        mode = "yolo";
        const second = await window(92), oldSecond = reference(await read(second), "observation");
        await control("reuse", 92); await denied("read", { path: oldSecond }); await denied("read", { path: second, views: ["dom"] });
        const third = await window(93), oldThird = reference(await read(third), "observation");
        await control("close", 93); await denied("read", { path: oldThird });
        assert((await snapshots()).length === before + 2, "Safe/lifetime refusal dispatched a DOM query");
        const aborted = new AbortController(); aborted.abort();
        await denied("read", { path: first, views: ["dom"] }, aborted.signal);
        assert((await snapshots()).length === before + 2, "Already-cancelled read dispatched a native snapshot");
        const after = new AbortController(); cancelAfterSnapshot = after;
        const cancelled = await denied("read", { path: first, views: ["dom"] }, after.signal);
        assert(find(cancelled.details, "dom") === undefined, "Cancelled native reply leaked a usable DOM observation");
        assert((await snapshots()).length === before + 3, "Cancellation replayed the readonly acquisition");
      } else {
        for (const outcome of ["ambiguous_binding", "foreign_profile", "wrong_target", "missing_metadata", "input_authority", "bad_counts", "refused"]) {
          // A UI read retires the prior admission so binding failures are exercised rather than bypassed through a cached binding.
          await ok("read", { path: first, views: ["ui"] }); await control(outcome);
          const result = await denied("read", { path: first, views: ["dom"] });
          assert(find(result.details, "dom") === undefined, `Malformed ${outcome} minted readonly authority`);
        }
        assert((await snapshots()).length === 5, "Malformed replies were retried or binding refusals reached DOM collection");
        const recovery = await read(first);
        assert(dom(recovery).elements.length === 3, "A new explicit read could not recover after a known refusal");
        const recoveryRef = reference(recovery, "observation"), recoveryHint = dom(recovery).elements[0].hint;
        await control("wrong_geometry_source");
        const substituted = await denied("read", { path: recoveryRef, views: [`element:geometry,${recoveryHint}`] });
        assert(find(substituted.details, "dom_geometry") === undefined, "Substituted geometry source leaked coordinates");
        await denied("read", { path: recoveryRef });
        const current = await read(first), currentRef = reference(current, "observation"), currentHint = dom(current).elements[0].hint;
        const afterGeometry = new AbortController(); cancelAfterSnapshot = afterGeometry;
        const cancelledGeometry = await denied("read", { path: currentRef, views: [`element:geometry,${currentHint}`] }, afterGeometry.signal);
        assert(find(cancelledGeometry.details, "dom_geometry") === undefined, "Cancelled geometry response minted usable coordinates");
        await denied("read", { path: currentRef });
        assert((await geometryReads()).length === 2, "Malformed/cancelled geometry was replayed or omitted");
      }
      const rows = await journal();
      assert(rows.every(row => ["fixture_identity", "fixture_control", "list_windows", "start_session", "end_session", "get_window_state", "get_browser_state"].includes(row.name)),
        "Unexpected browser/native input, preparation or capture fallback was dispatched");
      assert(rows.filter(row => row.name === "get_window_state").every(row => row.arguments.include_screenshot === false), "UI-only retirement acquired pixels");
      await ok("insert", { path: "computer:session", text: '{"action":"close"}' });
      assert((await journal()).at(-1)?.name === "end_session", "Owning browser session was not released");
      return { content: [{ type: "text", text: `IDE readonly DOM ${scenario} contract passed` }], details: { scenario, nativeSnapshots: (await snapshots()).length } };
    },
  });
}
