import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { loadComputerConfig } from "../../src/config.ts";
import { McpDriver } from "../../src/driver.ts";
import { ReactiveAnimationDriver } from "../../src/reactive-animation.ts";
import { registerFixtureComputerTools } from "./standalone-computer.ts";
import { ComputerSession, type ComputerMode, type WindowTarget } from "../../src/session.ts";

// Capability, identity and native outcomes are simulated; all production admission runs in real Pi.
class FixtureDriver extends McpDriver {
  override get platform() { return "windows" as const; }
  override get nativePointer(): boolean { return true; }
  override async identity(target: WindowTarget, _create: boolean, signal?: AbortSignal) {
    const result = await this.call("fixture_identity", target as unknown as Record<string, unknown>, signal);
    return result.structuredContent?.identity as string | undefined;
  }
}
/** Synthetic controls belong only to this isolated test extension, never the shipped tool surface. */
export default function fixture(pi: ExtensionAPI): void {
  createCodemodeExtension({ mode: "on" })(pi);
  let mode: ComputerMode = "yolo", session: ComputerSession | undefined, driver: FixtureDriver | undefined;
  const getSession = async (cwd: string) => {
    driver ??= new FixtureDriver(await loadComputerConfig(cwd));
    return session ??= new ComputerSession(new ReactiveAnimationDriver(driver, { glide_duration_ms: 1 }), () => mode);
  };
  registerFixtureComputerTools(pi, getSession, async () => session!.close());
  pi.registerTool({
    name: "fixture_pointer_control", label: "Fixture pointer control", description: "Change synthetic fixture state only.",
    parameters: Type.Object({ operation: Type.Union(["safe", "partial", "malformed", "close_first", "recycle_second"].map(value => Type.Literal(value))) }),
    async execute(_id, { operation }, signal, _update, ctx) {
      await getSession(ctx.cwd);
      if (operation === "safe") mode = "safe";
      else await driver!.call("fixture_control", { operation }, signal);
      return { content: [{ type: "text", text: "Synthetic fixture changed." }], details: {} };
    },
  });
  pi.on("session_shutdown", async () => { await session?.close(); });
}
