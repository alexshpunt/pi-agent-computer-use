import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadComputerConfig } from "../../src/config.ts";
import { McpDriver } from "../../src/driver.ts";
import { registerComputerTools } from "../../src/index.ts";
import { registerComputerMode } from "../../src/mode.ts";
import { ComputerSession } from "../../src/session.ts";

// Substitute only runtime qualification for a deterministic MCP peer. Production runtimes still require exact bytes.
class FixtureDriver extends McpDriver {
  override get platform() { return "windows" as const; }
  override get selectedDisplays(): boolean { return true; }
}
export default function selectedDisplayFixture(pi: ExtensionAPI): void {
  createCodemodeExtension({ mode: "on" })(pi);
  const getMode = registerComputerMode(pi); let session: ComputerSession | undefined;
  registerComputerTools(pi, async cwd => session ??= new ComputerSession(new FixtureDriver(await loadComputerConfig(cwd)), getMode),
    async () => session!.close());
  pi.on("session_shutdown", async () => { await session?.close(); });
}
