import { expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerComputerMode } from "../src/mode.ts";
import { HumanStop } from "../src/human-stop.ts";

test("restoring a scoped mode does not resume a stopped computer and respects the Safe guard", async () => {
  const stop = new HumanStop();
  const pi = { on: vi.fn(), registerCommand: vi.fn(), appendEntry: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
  const ctx = { hasUI: true, ui: { setStatus: vi.fn(), notify: vi.fn() } } as unknown as ExtensionCommandContext;
  let safeAllowed = false;
  const mode = registerComputerMode(pi, async () => {}, () => safeAllowed, stop);
  stop.stop();
  expect(await mode.applyPreference("safe", ctx)).toBe(false);
  expect(mode()).toBe("yolo");
  expect(stop.stopped).toBe(true);
  safeAllowed = true;
  expect(await mode.applyPreference("safe", ctx)).toBe(true);
  expect(mode()).toBe("safe");
  expect(stop.stopped).toBe(true);
});
