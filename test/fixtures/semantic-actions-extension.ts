import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadComputerConfig } from "../../src/config.ts";
import { McpDriver } from "../../src/driver.ts";
import { registerFixtureComputerTools } from "./standalone-computer.ts";
import { ComputerSession, type WindowTarget } from "../../src/session.ts";

// Only the capability and identity peer are simulated. Native app behavior is not tested here.
class FixtureDriver extends McpDriver {
  override get platform() { return "windows" as const; }
  override get semanticActions(): boolean { return true; }
  override async identity(target: WindowTarget, _create: boolean, signal?: AbortSignal) {
    const result = await this.call("fixture_identity", target as unknown as Record<string, unknown>, signal);
    return result.structuredContent?.identity as string | undefined;
  }
}
/** Run production registration, admission, Codemode and MCP in real Pi. */
export default function fixture(pi: ExtensionAPI): void {
  createCodemodeExtension({ mode: "on" })(pi);
  let session: ComputerSession | undefined;
  registerFixtureComputerTools(pi, async cwd => session ??= new ComputerSession(new FixtureDriver(await loadComputerConfig(cwd))),
    async () => session!.close());
  pi.on("session_shutdown", async () => { await session?.close(); });
}
