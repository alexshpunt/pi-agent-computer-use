import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadComputerConfig } from "../../src/config.ts";
import { McpDriver } from "../../src/driver.ts";
import { registerComputerTools } from "../../src/index.ts";
import { ReactiveAnimationDriver } from "../../src/reactive-animation.ts";
import { ComputerSession } from "../../src/session.ts";

/** Exercise the common tools and real MCP child with deferred native lifetime, not a GUI platform simulation. */
export default function portableFixture(pi: ExtensionAPI): void {
  createCodemodeExtension({ mode: "on" })(pi);
  let session: ComputerSession | undefined;
  registerComputerTools(pi, async cwd => session ??= new ComputerSession(
    new ReactiveAnimationDriver(new McpDriver(await loadComputerConfig(cwd)), { glide_duration_ms: 1 })),
  async () => session!.close());
  pi.on("session_shutdown", async () => { await session?.close(); });
}
