import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { WindowOverlay, type OverlayPeer, type WindowObserver } from "./window-overlay.ts";
import { startOverlayPeer } from "./window-overlay-peer.ts";

/** Find only a trusted user-installed Windows rendering helper. No model-supplied executable or auto-install. */
export async function findWindowOverlay(): Promise<string> {
  if (process.env.PI_WINDOW_OVERLAY_PATH) return process.env.PI_WINDOW_OVERLAY_PATH;
  const suffix = ["Programs", "PiComputerUsePoC", "window-overlay-0.1.0", "pi-window-overlay.exe"];
  const candidates = process.platform === "win32"
    ? [path.join(process.env.LOCALAPPDATA ?? "", ...suffix)]
    : (await readdir("/mnt/c/Users").catch(() => [] as string[]))
      .map(user => path.join("/mnt/c/Users", user, "AppData", "Local", ...suffix));
  const found: string[] = [];
  for (const candidate of candidates) if ((await stat(candidate).catch(() => undefined))?.isFile()) found.push(candidate);
  if (found.length !== 1) throw new Error("Install one qualified Windows window overlay, or set PI_WINDOW_OVERLAY_PATH.");
  return found[0];
}

/** Share one lazy rendering peer. Explicit confirmed close permits a fresh peer; unknown shutdown never does. */
export class WindowHighlights {
  private current: WindowOverlay;
  private stopping?: Promise<void>;
  constructor(private readonly createPeer: () => Promise<OverlayPeer> = async () => startOverlayPeer(await findWindowOverlay())) {
    this.current = new WindowOverlay(createPeer);
  }

  /** Called only after an authorized whole-window capture; no helper starts at registration. */
  readonly flash: WindowObserver = (frame, signal) => this.stopping
    ? Promise.resolve({ status: "skipped" }) : this.current.flash(frame, signal);

  /** Revoke the current frame, including an in-flight startup, without starting a helper. */
  clear(): Promise<void> { return this.current.clear(); }

  /** Close only the helper. A failed cleanup stays blocked until extension reload. */
  close(): Promise<void> {
    if (this.stopping) return this.stopping;
    return this.stopping = this.current.close().then(() => {
      this.current = new WindowOverlay(this.createPeer); this.stopping = undefined;
    });
  }
}
