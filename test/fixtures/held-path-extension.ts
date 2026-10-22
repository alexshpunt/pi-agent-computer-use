import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadComputerConfig } from "../../src/config.ts";
import { McpDriver } from "../../src/driver.ts";
import { registerFixtureComputerTools } from "./standalone-computer.ts";
import { ComputerSession, type Driver, type WindowTarget } from "../../src/session.ts";

/** Deterministic held-path peer. This tests Pi/schema/session effects, not Windows release. */
export default function heldPathFixture(pi: ExtensionAPI): void {
  createCodemodeExtension({ mode: "on" })(pi);
  let session: ComputerSession | undefined;
  registerFixtureComputerTools(pi, async cwd => {
    if (!session) {
      const peer = new McpDriver(await loadComputerConfig(cwd));
      const driver: Driver = {
        heldPaths: true, heldKeys: true,
        call: (name, args, signal) => peer.call(name === "hold_keys" ? "fixture_key_hold" : name === "drag" && args.via !== undefined ? "fixture_held_path" : name, args, signal),
        identity: async (target: WindowTarget, _create: boolean, signal?: AbortSignal) =>
          (await peer.call("fixture_identity", { ...target }, signal)).structuredContent?.identity as string | undefined,
        close: () => peer.close(),
      };
      session = new ComputerSession(driver);
    }
    return session;
  }, async () => session!.close());
  pi.on("session_shutdown", async () => { await session?.close(); });
}
