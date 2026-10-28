import { Type } from "@earendil-works/pi-ai";
import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ComputerMode, ComputerResult, ComputerSession, WindowTarget } from "../../src/session.ts";

/**
 * Test-only: the real computer provider and typed tools over the synthetic ide-provider driver, plus fixture_control to
 * make the next native input unknown or to close a window. Used to look at the real Pi TUI; it never touches a desktop.
 */
export default async function fixture(pi: ExtensionAPI): Promise<void> {
  const source = path.resolve(import.meta.dirname, "../..");
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
  const mode: ComputerMode = "yolo";
  let session: ComputerSession | undefined, driver: FixtureDriver | undefined;
  const getSession = async (cwd: string): Promise<ComputerSession> => {
    driver ??= new FixtureDriver(await loadComputerConfig(cwd));
    session ??= new ComputerSession(driver, () => mode);
    return session!;
  };
  const close = async (): Promise<ComputerResult> => session ? session.close() : { content: [{ type: "text", text: "No fixture runtime is running." }], details: { status: "closed", mode } };
  createCodemodeExtension({ mode: "on" })(pi);
  const provider = await registerComputerProvider(pi, getSession, close);
  registerComputerTools(pi, provider.resources);
  // Addresses carry a random per-run tag; a fixed one lets a scripted conversation name its windows.
  Object.defineProperty((provider.resources as unknown as { shorts: object }).shorts, "tag", { value: "tt" });
  pi.registerTool({
    name: "fixture_control", label: "Fixture control", description: "Make the synthetic driver's next input partial, or close its first window.",
    parameters: Type.Object({ operation: Type.Union([Type.Literal("partial"), Type.Literal("close_first"), Type.Literal("success")]) }),
    async execute(_id, { operation }, signal, _update, ctx) {
      await getSession(ctx.cwd);
      await driver!.call("fixture_control", { operation }, signal);
      return { content: [{ type: "text", text: `fixture ${operation}` }], details: {} };
    },
  });
}
