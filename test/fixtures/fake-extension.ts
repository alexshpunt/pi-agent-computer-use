import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadComputerConfig } from "../../src/config.ts";
import { McpDriver } from "../../src/driver.ts";
import { registerComputerTools } from "../../src/index.ts";
import { registerComputerMode } from "../../src/mode.ts";
import { ComputerSession, type WindowTarget } from "../../src/session.ts";

// Only the Windows lifetime marker is substituted. Real tool registration, session logic, MCP and EOF are exercised.
class FixtureDriver extends McpDriver {
  override get platform() { return "windows" as const; }
  override async identity(target: WindowTarget, _create: boolean, signal?: AbortSignal): Promise<string | undefined> {
    const state = await this.call("fixture_identity", target as unknown as Record<string, unknown>, signal);
    return state.structuredContent?.identity as string | undefined;
  }
}
export default function fixtureExtension(pi: ExtensionAPI): void {
  const getMode = registerComputerMode(pi);
  let session: ComputerSession | undefined;
  registerComputerTools(pi, async cwd => session ??= new ComputerSession(new FixtureDriver(await loadComputerConfig(cwd)), getMode),
    async () => session!.close());
  pi.on("session_shutdown", async () => { await session?.close(); });
}
