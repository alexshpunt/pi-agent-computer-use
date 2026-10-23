import { registerClassifierTool } from "./classifier-tool.ts";
import { registerVisionDebug } from "./vision-debug.ts";
import { CuaImageSettings } from "./cua-image-settings.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadComputerConfig } from "./config.ts";
import { ReactiveAnimationDriver, loadReactiveAnimationConfig } from "./reactive-animation.ts";
import { McpDriver } from "./driver.ts";
import { registerComputerMode } from "./mode.ts";
import { WindowHighlights } from "./window-highlights.ts";
import { ComputerSession, type ComputerResult } from "./session.ts";
import { registerComputerProvider } from "./provider.ts";
import { registerStandaloneTools } from "./standalone-tools.ts";
import { WebBrowser } from "./web-browser.ts";
import { localRunner } from "./runner.ts";
import { MachineHost } from "./machine-host.ts";
import { machineFactory, sandboxFactory } from "./machine.ts";

/**
 * Register native computer resources with ordinary IDE tools when Pi Agent IDE accepts them, otherwise as
 * deferred computer_* tools, and retain the separate visual classifier.
 */
export default async function computerUse(pi: ExtensionAPI): Promise<void> {
  const closeClassifier = registerClassifierTool(pi);
  let overviewKernel: "lanczos3" | "bilinear" = "lanczos3";
  const images = new CuaImageSettings(() => overviewKernel);
  const debug = registerVisionDebug(pi, images);
  const highlights = new WindowHighlights();
  const getMode = registerComputerMode(pi, () => highlights.clear());
  let session: ComputerSession | undefined;
  let loading: Promise<ComputerSession> | undefined;
  async function getSession(cwd: string): Promise<ComputerSession> {
    if (session) return session;
    if (!loading) loading = loadComputerConfig(cwd).then(async config => {
      const driver = new ReactiveAnimationDriver(new McpDriver(config), await loadReactiveAnimationConfig(cwd));
      overviewKernel = driver.overviewKernel ?? "lanczos3";
      session = new ComputerSession(driver, getMode, () => images.settings(), driver.platform === "windows" ? highlights.flash : undefined, image => debug.trace.retainOriginal(image),
        driver.platform === "windows" ? (options, signal) => WebBrowser.launch({ ...options, interop: config.interop }, signal) : undefined,
        driver.platform === "windows" ? new MachineHost(localRunner(config.interop)) : undefined);
      return session;
    });
    try { return await loading; }
    finally { loading = undefined; }
  }
  const openSandbox = sandboxFactory({ settings: () => images.settings(), retainRaw: image => debug.trace.retainOriginal(image) });
  const connectMachine = machineFactory({ getMode, settings: () => images.settings(), retainRaw: image => debug.trace.retainOriginal(image) });
  const provider = await registerComputerProvider(pi, getSession, async () => {
    await closeClassifier();
    const result: ComputerResult = session ? await session.close() : {
      content: [{ type: "text", text: "Not started." }],
      details: { status: "closed", mode: getMode() },
    };
    session = undefined;
    try { await highlights.close(); }
    catch { return { content: [{ type: "text", text: "Qt frame shutdown is unconfirmed." }],
      details: { status: "unknown", mode: getMode() }, isError: true }; }
    return result;
  }, openSandbox, connectMachine, getMode);
  // Every extension has loaded by session_start, so an IDE that accepts the provider has done so by now.
  let standalone = false;
  pi.on("session_start", () => {
    if (standalone || provider.attached()) return;
    standalone = true;
    registerStandaloneTools(pi, provider.resources, provider.guide);
  });
  pi.on("session_shutdown", async () => {
    await closeClassifier();
    if (loading) await loading.catch(() => undefined);
    try { await session?.close(); } finally { await highlights.close(); }
    session = undefined;
  });
}
