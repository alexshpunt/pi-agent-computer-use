import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadComputerConfig } from "../../src/config.ts";
import { McpDriver } from "../../src/driver.ts";
import { registerComputerTools } from "../../src/index.ts";
import { registerComputerMode } from "../../src/mode.ts";
import { ComputerSession, type WindowTarget } from "../../src/session.ts";

// Simulate the qualified drag capability and Windows identity only. No native application evidence.
class FixtureDriver extends McpDriver {
  override get platform() { return "windows" as const; }
  override get captureBoundDrag(): boolean { return true; }
  override async identity(target: WindowTarget, _create: boolean, signal?: AbortSignal): Promise<string | undefined> {
    const state = await this.call("fixture_identity", target as unknown as Record<string, unknown>, signal);
    return state.structuredContent?.identity as string | undefined;
  }
}

/** Exercise real Codemode, tool registration, session admission and MCP delivery. */
export default function captureDragFixture(pi: ExtensionAPI): void {
  createCodemodeExtension({ mode: "on" })(pi);
  const getMode = registerComputerMode(pi);
  let session: ComputerSession | undefined;
  registerComputerTools(pi, async cwd => session ??= new ComputerSession(new FixtureDriver(await loadComputerConfig(cwd)), getMode),
    async () => session!.close());
  pi.on("session_shutdown", async () => { await session?.close(); });
}
