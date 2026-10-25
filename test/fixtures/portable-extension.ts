import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadComputerConfig } from "../../src/config.ts";
import { McpDriver } from "../../src/driver.ts";
import { registerFixtureComputerTools } from "./standalone-computer.ts";
import { ComputerSession } from "../../src/session.ts";

/** Exercise the common tools and real MCP child with deferred native lifetime, not a GUI platform simulation. */
export default function portableFixture(pi: ExtensionAPI): void {
  createCodemodeExtension({ mode: "on" })(pi);
  let session: ComputerSession | undefined;
  registerFixtureComputerTools(pi, async cwd => session ??= new ComputerSession(
    new McpDriver(await loadComputerConfig(cwd))),
  async () => session!.close());
  pi.on("session_shutdown", async () => { await session?.close(); });
}
