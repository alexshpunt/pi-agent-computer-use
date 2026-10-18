import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ComputerMode, ComputerResult, ComputerSession, WindowTarget } from "../../src/session.ts";
import type { DomResource } from "../../src/dom-resource.ts";

interface Result { isError?: boolean; content: { type: string; text?: string; data?: string; mimeType?: string }[]; details?: unknown }
interface Row { name: string; arguments: Record<string, unknown> }
const body = (result: Result) => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw Error(message); }
function find(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  if (key in value) return (value as Record<string, unknown>)[key];
  for (const child of Object.values(value)) { const result = find(child, key); if (result !== undefined) return result; }
  return undefined;
}
function reference(result: Result, kind: "window" | "observation"): string {
  const match = body(result).match(new RegExp(`computer:${kind}/[a-zA-Z0-9-]+`));
  assert(match, `Missing ${kind} address: ${body(result)}`); return match[0];
}

/** Exercise ordinary IDE native-detail resources through a synthetic MCP peer and the real wrapper. */
export default async function fixture(pi: ExtensionAPI): Promise<void> {
  createCodemodeExtension({ mode: "on" })(pi);
  const source = process.env.PI_DOM_DETAIL_PROVIDER_SOURCE ?? path.resolve(import.meta.dirname, "../..");
  const load = (name: string) => import(pathToFileURL(path.join(source, "src", name)).href);
  const [{ registerComputerProvider }, { loadComputerConfig }, { McpDriver }, { ComputerSession }, { ReactiveAnimationDriver }] =
    await Promise.all([load("provider.ts"), load("config.ts"), load("driver.ts"), load("session.ts"), load("reactive-animation.ts")]);
  const Base = McpDriver as typeof import("../../src/driver.ts").McpDriver;
  let mode: ComputerMode = "yolo", qualified = true, session: ComputerSession | undefined, driver: FixtureDriver | undefined, log: string | undefined;
  class FixtureDriver extends Base {
    get platform() { return "windows" as const; }
    get domInspection() { return true; }
    // Qualification and native lifetime are simulated; transport, wrapper and provider are production code.
    get nativeDomRaster() {
      const runtime = { source: "a".repeat(40), sha256: "b".repeat(64) };
      return qualified ? { runtime, qualification: { runtime, browser: { product: "Chrome/155.0.8059.40", revision: "@tested-fixture" }, dpr: 1.5 } } : undefined;
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
  const close = async (): Promise<ComputerResult> => session ? session.close() : { content: [], details: { status: "closed", mode } };
  await registerComputerProvider(pi, getSession, close);
  pi.on("session_shutdown", async () => { await close(); });
  pi.registerTool({
    name: "verify_dom_native_detail", label: "Verify readonly native DOM detail",
    description: "Use this fixture to verify ordinary IDE DOM crop/highlight without a native desktop.",
    parameters: Type.Object({ scenario: Type.Union([Type.Literal("workflow"), Type.Literal("refusal")]) }),
    async execute(_id, { scenario }, signal, _update, ctx) {
      const call = async (name: string, args: Record<string, unknown>): Promise<Result> => {
        const executed = await ctx.executeTool(name, args, { signal });
        return { ...executed.result, isError: executed.isError } as Result;
      };
      const ok = async (name: string, args: Record<string, unknown>) => {
        const result = await call(name, args); assert(!result.isError, `${name} failed: ${body(result)}`); return result;
      };
      const denied = async (name: string, args: Record<string, unknown>) => {
        let result: Result;
        try { result = await call(name, args); } catch (error) { result = { isError: true, content: [{ type: "text", text: String(error) }] }; }
        assert(result.isError, `${name} accepted invalid readonly/source authority: ${body(result)}`);
        assert(result.content.every(block => block.type !== "image"), "Refusal leaked native pixels"); return result;
      };
      const journal = async (): Promise<Row[]> => (await readFile(log!, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const geometry = async () => (await journal()).filter(row => row.arguments.native_geometry_ref !== undefined);
      const crops = async () => (await journal()).filter(row => row.name === "zoom");
      const snapshots = async () => (await journal()).filter(row => row.name === "get_browser_state" && row.arguments.snapshot_format && !row.arguments.native_geometry_ref);
      const window = reference(await ok("search", { path: "computer:windows", query: "Native DOM detail fixture" }), "window");
      const read = async () => {
        const result = await ok("read", { path: window, views: ["dom"] });
        const dom = find(result.details, "dom") as DomResource | undefined;
        assert(dom?.elements.length === 1 && dom.elements[0].bounds_css === null, "DOM source lost its readonly records");
        assert(result.content.every(block => block.type !== "image"), "DOM collection unexpectedly acquired pixels");
        return { result, dom, path: reference(result, "observation"), hint: dom.elements[0].hint };
      };
      assert(!pi.getAllTools().some(tool => /^(browser_|computer_)/.test(tool.name)), "Duplicate browser/computer tool surface escaped");
      if (scenario === "workflow") {
        const source = await read(), before = (await snapshots()).length;
        const searched = await ok("search", { path: source.path, query: "Advance" });
        assert((find(searched.details, "dom") as DomResource).elements[0].hint === source.hint, "Cached search changed DOM identity");
        const description = await driver!.call("fixture_control", { operation: "describe" }, signal);
        const cropped = await ok("read", { path: source.path, views: [`element:crop,${source.hint}`] });
        const image = cropped.content.filter(block => block.type === "image");
        assert(image.length === 1 && image[0].mimeType === "image/png" && image[0].data, "Crop image disappeared across ordinary Read");
        assert(createHash("sha256").update(Buffer.from(image[0].data, "base64")).digest("hex") === description.structuredContent?.pixel_hash,
          "Ordinary Read changed the native crop PNG");
        const detail = find(cropped.details, "dom_native_detail") as Record<string, unknown> | undefined;
        assert(detail?.operation === "crop" && detail.hint === source.hint && detail.input_authority === false && detail.paint_freshness === "unverified",
          "Readonly native-detail provenance was lost");
        assert(find(cropped.details, "action_capability") === undefined && find(cropped.details, "dom_geometry") === undefined &&
          find(cropped.details, "ui") === undefined, "Crop minted input/CSS/UIA authority");
        assert(!/bt-private-detail|tab-private-detail|p[0-9]+:[0-9]+|frame-private|loader-private|private-context|backend_node_id|context_unique_id/.test(JSON.stringify(cropped.details)),
          "Native DOM capabilities leaked across the public provider");
        assert(body(cropped).includes("candidate_not_raster_qualified") && body(cropped).includes("input=none") && body(cropped).includes("paint=unverified"),
          "Presentation hid native candidate or paint/input limits");
        const highlighted = await ok("read", { path: source.path, views: [`element:highlight,${source.hint}`] });
        assert(highlighted.content.filter(block => block.type === "image").length === 1 &&
          highlighted.content.find(block => block.type === "image")?.data !== image[0].data, "Highlight did not annotate native crop pixels");
        assert((find(highlighted.details, "dom_native_detail") as Record<string, unknown>)?.operation === "highlight", "Highlight lost its operation");
        const cached = await ok("read", { path: source.path });
        assert(JSON.stringify(find(cached.details, "dom")) === JSON.stringify(source.dom), "Crop/highlight rewrote cached DOM or CSS bounds");
        await denied("write", { path: source.path, content: "native crop is not input authority" });
        await denied("insert", { path: source.path, text: '{"action":"click","x":1,"y":1}' });
        await denied("read", { path: source.path, views: ["region:0,0,1,1"] });
        assert((await snapshots()).length === before && (await geometry()).length === 6 && (await crops()).length === 2,
          "Readonly detail resnapshotted, replayed or granted nested capture authority");
      } else {
        const source = await read(), before = (await journal()).length;
        qualified = false;
        await denied("read", { path: source.path, views: [`element:crop,${source.hint}`] });
        assert((await geometry()).length === 0 && (await crops()).length === 0, "Unqualified source acquired geometry or native pixels");
        assert(JSON.stringify(find((await ok("read", { path: source.path })).details, "dom")) === JSON.stringify(source.dom), "Qualification refusal retired valid cached DOM");
        assert((await journal()).slice(before).every(row => row.name === "fixture_identity"), "Unqualified route dispatched a hidden native operation");
        qualified = true;
        const fresh = await read(); await driver!.call("fixture_control", { operation: "change_after_crop" }, signal);
        const failed = await denied("read", { path: fresh.path, views: [`element:crop,${fresh.hint}`] });
        assert(find(failed.details, "dom_native_detail") === undefined && find(failed.details, "agent_image") === undefined,
          "Changed post-capture source exported pixel provenance");
        await denied("read", { path: fresh.path });
        assert((await geometry()).length === 3 && (await crops()).length === 1, "Source change replayed native capture or omitted post-validation");
      }
      await ok("insert", { path: "computer:session", text: '{"action":"close"}' });
      const rows = await journal();
      assert(rows.every(row => ["fixture_identity", "fixture_control", "list_windows", "start_session", "end_session", "get_browser_state", "zoom"].includes(row.name)),
        "Input, browser preparation or alternate capture fallback reached the synthetic peer");
      assert(rows.filter(row => row.name === "start_session").length === 1 && rows.filter(row => row.name === "end_session").length === 1,
        "Owned runtime session did not close exactly once");
      return { content: [{ type: "text", text: `IDE native DOM detail ${scenario} contract passed` }], details: { scenario } };
    },
  });
}
