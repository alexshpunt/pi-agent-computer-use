import { addressPattern } from "./addresses.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ComputerMode, ComputerResult, ComputerSession, WindowTarget } from "../../src/session.ts";

interface Result { isError?: boolean; content: { type: string; text?: string; data?: string; mimeType?: string }[]; details?: unknown }
const textOf = (result: Result) => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
const assert = (condition: unknown, message: string): void => { if (!condition) throw Error(message); };
const reference = (result: Result, kind: "app" | "window" | "observation" | "sequence") => {
  const match = textOf(result).match(addressPattern(kind));
  if (!match) throw Error(`No ${kind} resource in real tool result: ${textOf(result)}`);
  return match[0].split("?")[0];
};
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  if (key in value) return (value as Record<string, unknown>)[key];
  for (const child of Object.values(value)) { const found = field(child, key); if (found !== undefined) return found; }
  return undefined;
}
const hintOf = (result: Result) => {
  const structured = field(result, "hint");
  if (typeof structured === "string") return structured;
  const body = textOf(result);
  const match = body.match(/"hint"\s*:\s*"([^"]+)"/) ?? body.match(/(?:^|\s|\[)([0-9][0-9a-z]*:[a-z]+)\b/m);
  if (!match) throw Error(`No current UI hint in real tool result: ${body}`);
  return match[1];
};

/** Test-only synthetic peer and proof driver; all effects run through actual IDE tools. */
export default async function fixture(pi: ExtensionAPI): Promise<void> {
  const source = process.env.PI_COMPUTER_PROVIDER_SOURCE ?? path.resolve(import.meta.dirname, "../..");
  const load = (name: string) => import(pathToFileURL(path.join(source, "src", name)).href);
  const [{ registerComputerProvider }, { loadComputerConfig }, { McpDriver }, { ComputerSession }, { registerComputerTools }] =
    await Promise.all([load("provider.ts"), load("config.ts"), load("driver.ts"), load("session.ts"), load("computer-tools.ts")]);
  const Driver = McpDriver as typeof import("../../src/driver.ts").McpDriver;
  class FixtureDriver extends Driver {
    get platform() { return "windows" as const; }
    async identity(target: WindowTarget, _create: boolean, signal?: AbortSignal) {
      const result = await this.call("fixture_identity", target as unknown as Record<string, unknown>, signal);
      return result.structuredContent?.identity as string | undefined;
    }
  }
  let mode: ComputerMode = "yolo", session: ComputerSession | undefined, driver: FixtureDriver | undefined, log: string | undefined;
  const getSession = async (cwd: string): Promise<ComputerSession> => {
    if (!driver) {
      const config = await loadComputerConfig(cwd);
      log = config.args[1];
      driver = new FixtureDriver(config);
    }
    session ??= new ComputerSession(driver, () => mode);
    return session!;
  };
  const close = async (): Promise<ComputerResult> => session ? session.close() : {
    content: [{ type: "text", text: "No fixture runtime is running." }], details: { status: "closed", mode },
  };
  const provider = await registerComputerProvider(pi, getSession, close);
  registerComputerTools(pi, provider.resources);
  pi.registerTool({
    name: "verify_ide_computer", label: "Verify IDE computer fixture",
    description: "Exercise ordinary IDE tools against a synthetic native peer; never operate a desktop.",
    parameters: Type.Object({ scenario: Type.Union([Type.Literal("workflow"), Type.Literal("admission")]) }),
    async execute(_id, { scenario }, signal, _update, ctx) {
      const call = async (name: string, args: Record<string, unknown>): Promise<Result> => {
        try {
          const outcome = await ctx.executeTool(name, args, { signal });
          return { ...outcome.result, isError: outcome.isError } as Result;
        }
        catch (error) { return { isError: true, content: [{ type: "text", text: String(error) }] }; }
      };
      const ok = async (name: string, args: Record<string, unknown>) => {
        const result = await call(name, args);
        assert(!result.isError, `${name} failed: ${textOf(result)}`);
        return result;
      };
      const denied = async (name: string, args: Record<string, unknown>) => {
        const result = await call(name, args);
        assert(result.isError, `${name} reported a forbidden/uncertain operation as success: ${textOf(result)}`);
        return result;
      };
      const journal = async () => (await readFile(log!, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const inputs = async () => (await journal()).filter(row => ["type_text", "click", "press_key", "hotkey"].includes(row.name));
      const captures = async () => (await journal()).filter(row => row.name === "get_window_state");
      // Whether a call captured the window before its first native input. The action's successor captures it after the
      // input (LPT-914, LPT-915); a capture before it would silently refresh the input's authority.
      const capturedBeforeInput = async (from: number) => {
        const rows = (await journal()).slice(from), input = rows.findIndex(row => ["type_text", "click", "press_key", "hotkey"].includes(row.name));
        return rows.slice(0, input < 0 ? rows.length : input).some(row => row.name === "get_window_state");
      };
      const control = async (operation: string) => {
        if (operation === "safe") mode = "safe";
        else await driver!.call("fixture_control", { operation }, signal);
      };
      const open = async () => reference(await ok("computer_open", { at: "computer:machine/local", app: "Notepad" }), "window");
      // Write and Insert never act on computer resources: they refuse, name the typed tool and send nothing.
      const refused = async (name: "write" | "insert", args: Record<string, unknown>, tool: string) => {
        const before = (await inputs()).length, result = await denied(name, args);
        assert(textOf(result).includes(`Use ${tool}`), `${name} refusal did not name ${tool}: ${textOf(result)}`);
        assert((await inputs()).length === before, `${name} sent native input`);
        return result;
      };
      assert(!pi.getAllTools().some(tool => /^computer_(read|search|delete)$/.test(tool.name)), "Provider exposed duplicate ordinary computer tools");
      const apps = await ok("search", { path: "computer:machine/local/apps", query: "Notepad" });
      assert(textOf(apps).includes("Notepad"), "Installed-app Search lost the native app");
      const first = reference(await ok("computer_open", { at: reference(apps, "app") }), "window"), second = await open();
      const found = await ok("search", { path: "computer:machine/local/windows", query: "Owned fixture" });
      assert(textOf(found).includes(first) && textOf(found).includes(second), "Window Search lost exact resources");
      let view = await ok("read", { path: first });
      const image = view.content.find(block => block.type === "image");
      assert(image?.mimeType === "image/png" && image.data, "Native Read image did not reach real Pi");
      let observation = reference(view, "observation");
      if (scenario === "workflow") {
        const nativeBeforeDetail = (await captures()).length;
        const detail = await ok("read", { path: observation, views: ["region:80,60,40,20"] });
        assert(detail.content.some(block => block.type === "image" && block.mimeType === "image/jpeg"), "Rectangular Read did not return native detail");
        assert((await captures()).length === nativeBeforeDetail, "Detail silently created a new grounding overview");
        await refused("insert", { path: observation, text: JSON.stringify({ action: "click", x: 100, y: 80 }) }, "computer_click");
        view = await ok("read", { path: first });
        const hint = hintOf(view), literal = '  {"looks":"like JSON"}\n"quoted text"\n  ';
        await refused("write", { path: reference(view, "observation"), content: literal }, "computer_type");
        const nativeBeforeType = (await journal()).length;
        await ok("computer_type", { window: first, target: hint, text: literal, delay_ms: 0 });
        assert(!await capturedBeforeInput(nativeBeforeType), "computer_type refreshed native capture");
        const written = (await inputs()).at(-1);
        assert(written?.name === "type_text" && written.arguments.text === literal && written.arguments.delay_ms === 0, "Literal typing normalized text, added a command or lost delay");
        view = await ok("read", { path: first });
        const nativeBeforeClick = (await journal()).length;
        await ok("computer_click", { window: first, target: hintOf(view) });
        assert(!await capturedBeforeInput(nativeBeforeClick), "computer_click refreshed native capture");
        const uiOnly = await ok("read", { path: first, views: ["ui"] });
        assert(!uiOnly.content.some(block => block.type === "image"), "UI text view included an image");
        assert(textOf(uiOnly).includes("Fixture text field") && textOf(uiOnly).includes("Fixture button"), "UI text view lost observed structure");
        const uiAddress = reference(uiOnly, "observation"), beforeSlice = (await captures()).length;
        const sliced = await ok("read", { path: uiAddress, views: ["ui"], offset: 2, limit: 1 });
        assert(!sliced.content.some(block => block.type === "image"), "UI line selection was treated as pixel crop");
        assert(textOf(sliced).length < textOf(uiOnly).length, "UI offset/limit did not bound the text view");
        assert((await captures()).length === beforeSlice, "Cached UI line Read performed another native capture");
        await control("large_tree");
        const large = await ok("read", { path: first, views: ["ui"] });
        const blocks = field(large, "blocks");
        assert(Array.isArray(blocks) && blocks.some(block => block.type === "text" && block.text.includes("Last collected control")), "Native canonical Read data silently truncated the collected UI");
        assert(textOf(large).includes("Presentation truncated") || textOf(large).includes("Last collected control"), "UI presentation lost rows without a truncation notice");
        await control("success");
        // Read only looks: frames over time come from computer_record.
        const looked = await denied("read", { path: first, views: ['sequence:{"duration_ms":200,"fps":10,"max_frames":2}'] });
        assert(textOf(looked).includes("computer_record"), `Read sequence refusal named no tool: ${textOf(looked)}`);
        const temporal = await ok("computer_record", { at: first, action: "sequence", duration_ms: 200, fps: 10, max_frames: 2 });
        assert(!temporal.content.some(block => block.type === "image"), "Sequence capture implicitly forwarded frames");
        const sequence = reference(temporal, "sequence"), beforeFrames = (await captures()).length;
        const frames = await ok("read", { path: sequence, views: ["frames:endpoints"] });
        assert(frames.content.filter(block => block.type === "image").length === 2 && textOf(frames).includes("frame 0") && textOf(frames).includes("frame 1"), "Frame Read lost native image labels");
        assert((await captures()).length === beforeFrames, "Frame selection recaptured the desktop");
        await refused("insert", { path: sequence, text: JSON.stringify({ action: "click", x: 100, y: 80 }) }, "computer_click");
        await ok("write", { path: "local.txt", content: "Local source stays local\n" });
        await ok("insert", { path: "local.txt", anchor: "Local source stays local", text: "Second local line" });
        const local = await ok("read", { path: "local.txt" });
        assert(textOf(local).includes("Second local line"), "Computer provider intercepted local editor behavior");
      } else {
        const listed = await ok("search", { path: "computer:machine/local/windows", query: "Unowned fixture" });
        const external = reference(listed, "window");
        await ok("read", { path: external });
        await control("safe");
        const safeRefusal = await denied("computer_type", { window: external, text: "Safe must refuse this text" });
        assert(textOf(safeRefusal).includes("Safe mode allows only windows opened by this session"), "Typed tool refusal hid the native policy reason");
        view = await ok("read", { path: first }); observation = reference(view, "observation");
        assert(textOf(await denied("insert", { path: first, text: "not JSON" })).includes("Insert does not act on computer resources; nothing was sent."), "Insert refusal changed");
        await denied("computer_click", { window: observation, x: 100, y: 80 });
        await denied("computer_type", { window: "computer:machine/local/display/primary", text: "not input authority" });
        assert((await inputs()).length === 0, "Invalid/Safe/display requests sent native input");
        await control("partial");
        const beforePartial = (await journal()).length;
        const partial = await denied("computer_type", { window: first, target: hintOf(view), text: "interrupted prefix" });
        assert(/unknown|partial|uncertain|interrupted/i.test(textOf(partial)), "Interrupted result lost its uncertainty");
        assert(!await capturedBeforeInput(beforePartial), "Interrupted action resolution refreshed native capture");
        assert((await inputs()).length === 1 && (await inputs())[0].name === "type_text" && (await inputs())[0].arguments.text === "interrupted prefix", "Interrupted input was sent more than once");
        await ok("read", { path: first });
        await control("close_first");
        await denied("computer_click", { window: first, x: 100, y: 80 });
        await ok("read", { path: second });
        await control("recycle_second");
        await denied("computer_type", { window: second, text: "reused native handle" });
        assert((await inputs()).length === 1, "Closed/reused target received native input");
      }
      await ok("delete", { path: "computer:session" });
      return { content: [{ type: "text" as const, text: `IDE computer ${scenario} contract passed` },
        ...(image ? [{ type: "image" as const, data: image.data!, mimeType: image.mimeType! }] : [])],
        details: { scenario, nativeInputs: await inputs(), nativeCaptures: (await captures()).length,
          ...(scenario === "workflow" ? { localText: await readFile(path.join(ctx.cwd, "local.txt"), "utf8") } : {}) } };
    },
  });
  pi.on("session_shutdown", async () => { await session?.close(); });
}
