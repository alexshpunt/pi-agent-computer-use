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
  const match = textOf(result).match(new RegExp(`computer:${kind}/[a-zA-Z0-9-]+`));
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
  const [{ registerComputerProvider }, { loadComputerConfig }, { McpDriver }, { ComputerSession }] =
    await Promise.all([load("provider.ts"), load("config.ts"), load("driver.ts"), load("session.ts")]);
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
  await registerComputerProvider(pi, getSession, close);
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
      const open = async () => reference(await ok("insert", { path: "computer:machine/local", text: JSON.stringify({ action: "open", app: "Notepad" }) }), "window");
      assert(!pi.getAllTools().some(tool => /^computer_/.test(tool.name)), "Provider exposed duplicate ordinary computer_* tools");
      const apps = await ok("search", { path: "computer:machine/local/apps", query: "Notepad" });
      assert(textOf(apps).includes("Notepad"), "Installed-app Search lost the native app");
      const first = reference(await ok("insert", { path: reference(apps, "app"), text: JSON.stringify({ action: "open" }) }), "window"), second = await open();
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
        const beforeDenied = (await inputs()).length;
        await denied("insert", { path: observation, text: JSON.stringify({ action: "click", x: 100, y: 80 }) });
        assert((await inputs()).length === beforeDenied, "Consumed detail observation dispatched input");
        view = await ok("read", { path: first }); observation = reference(view, "observation");
        const hint = hintOf(view), literal = '  {"looks":"like JSON"}\n"quoted text"\n  ';
        const nativeBeforeWrite = (await journal()).length;
        await ok("write", { path: `${observation}?hint=${encodeURIComponent(hint)}&delivery=foreground&delay_ms=0`, content: literal });
        assert(!await capturedBeforeInput(nativeBeforeWrite), "Write resolution refreshed native capture");
        const written = (await inputs()).at(-1);
        assert(written?.name === "type_text" && written.arguments.text === literal && written.arguments.delay_ms === 0, "Literal Write normalized text, added a command or lost delay");
        await denied("write", { path: observation, content: "replay" });
        view = await ok("read", { path: first }); observation = reference(view, "observation");
        const nativeBeforeInsert = (await journal()).length;
        await ok("insert", { path: observation, text: JSON.stringify({ action: "click", hint: hintOf(view) }) });
        assert(!await capturedBeforeInput(nativeBeforeInsert), "Insert resolution refreshed native capture");
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
        const temporal = await ok("read", { path: first, views: ['sequence:{"duration_ms":200,"fps":10,"max_frames":2}'] });
        assert(!temporal.content.some(block => block.type === "image"), "Sequence capture implicitly forwarded frames");
        const sequence = reference(temporal, "sequence"), beforeFrames = (await captures()).length;
        const frames = await ok("read", { path: sequence, views: ["frames:endpoints"] });
        assert(frames.content.filter(block => block.type === "image").length === 2 && textOf(frames).includes("frame 0") && textOf(frames).includes("frame 1"), "Frame Read lost native image labels");
        assert((await captures()).length === beforeFrames, "Frame selection recaptured the desktop");
        await denied("insert", { path: sequence, text: JSON.stringify({ action: "click", x: 100, y: 80 }) });
        await ok("write", { path: "local.txt", content: "Local source stays local\n" });
        await ok("insert", { path: "local.txt", anchor: "Local source stays local", text: "Second local line" });
        const local = await ok("read", { path: "local.txt" });
        assert(textOf(local).includes("Second local line"), "Computer provider intercepted local editor behavior");
      } else {
        const listed = await ok("search", { path: "computer:machine/local/windows", query: "Unowned fixture" });
        const external = reference(listed, "window");
        const externalView = await ok("read", { path: external });
        await control("safe");
        const safeRefusal = await denied("write", { path: reference(externalView, "observation"), content: "Safe must refuse this text" });
        assert(textOf(safeRefusal).includes("Safe mode allows only windows opened by this session"), "Ordinary tool refusal hid the native policy reason");
        assert(!textOf(safeRefusal).includes("no file was written"), "Semantic Write was misrepresented as a filesystem operation");
        view = await ok("read", { path: first }); observation = reference(view, "observation");
        await denied("insert", { path: observation, text: "not JSON" });
        await denied("insert", { path: observation, text: JSON.stringify({ action: "click", x: 100, y: 80, window_ref: second }) });
        await denied("insert", { path: first, text: JSON.stringify({ action: "click", x: 100, y: 80 }) });
        await denied("write", { path: "computer:machine/local/display/primary", content: "not input authority" });
        assert((await inputs()).length === 0, "Invalid/Safe/display requests sent native input");
        view = await ok("read", { path: first }); observation = reference(view, "observation");
        await control("partial");
        const beforePartial = (await journal()).length;
        const partial = await denied("insert", { path: observation, text: JSON.stringify({ action: "sequence", sequence: [
          { action: "type_text", x: 100, y: 80, text: "interrupted prefix" }, { action: "type_text", text: "must not run" },
        ] }) });
        assert(/unknown|partial|uncertain|interrupted/i.test(textOf(partial)), "Interrupted result lost its uncertainty");
        assert(!await capturedBeforeInput(beforePartial), "Interrupted action resolution refreshed native capture");
        await denied("insert", { path: observation, text: JSON.stringify({ action: "click", x: 100, y: 80 }) });
        assert((await inputs()).length === 1 && (await inputs())[0].name === "type_text" && (await inputs())[0].arguments.text === "interrupted prefix", "Interrupted prefix was replayed or later sequence input was sent");
        view = await ok("read", { path: first }); observation = reference(view, "observation");
        await control("close_first");
        await denied("insert", { path: observation, text: JSON.stringify({ action: "click", x: 100, y: 80 }) });
        view = await ok("read", { path: second }); observation = reference(view, "observation");
        await control("recycle_second");
        await denied("write", { path: observation, content: "reused native handle" });
        assert((await inputs()).length === 1, "Closed/reused target received native input");
      }
      await ok("insert", { path: "computer:session", text: JSON.stringify({ action: "close" }) });
      return { content: [{ type: "text" as const, text: `IDE computer ${scenario} contract passed` },
        ...(image ? [{ type: "image" as const, data: image.data!, mimeType: image.mimeType! }] : [])],
        details: { scenario, nativeInputs: await inputs(), nativeCaptures: (await captures()).length,
          ...(scenario === "workflow" ? { localText: await readFile(path.join(ctx.cwd, "local.txt"), "utf8") } : {}) } };
    },
  });
  pi.on("session_shutdown", async () => { await session?.close(); });
}
