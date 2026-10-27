import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { BundledRuntime } from "../src/native-runtime.ts";

// These tests read configuration only; the live WSL interop socket of the machine running them stays out.
vi.mock("../src/wsl-interop.ts", () => ({ liveInterop: vi.fn(async () => undefined) }));

// Selecting the shipped runtime needs Windows or WSL and its files; stand in for that lookup only.
const runtime: BundledRuntime = { target: "win32-x64", root: "/package/native-runtime/win32-x64", command: "/package/native-runtime/win32-x64/runtime/cua-driver.exe",
  source: "a".repeat(40), version: "0.37.0", driverVersion: "0.37.0", files: {} };
const findBundledRuntime = vi.fn(async (_interop?: string) => runtime);
vi.mock("../src/native-runtime.ts", () => ({ findBundledRuntime }));
const { loadComputerConfig } = await import("../src/config.ts");

const owned: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); findBundledRuntime.mockClear();
  await Promise.all(owned.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function workspace(config?: Record<string, unknown>) {
  await mkdir(".tmp", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp", "config-bundled-")); owned.push(cwd);
  if (config) { await mkdir(path.join(cwd, ".pi")); await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify(config)); }
  return cwd;
}

test("the shipped runtime runs as the windows-desktop profile", async () => {
  vi.stubEnv("CUA_DRIVER_PATH", undefined);
  expect(await loadComputerConfig(await workspace())).toEqual({ command: runtime.command, bundled: runtime, runtime: "windows-desktop" });
  expect(findBundledRuntime).toHaveBeenCalledWith(undefined);
});

test("an empty CUA_DRIVER_PATH falls back to the shipped runtime, not an empty command", async () => {
  vi.stubEnv("CUA_DRIVER_PATH", "");
  expect(await loadComputerConfig(await workspace())).toEqual({ command: runtime.command, bundled: runtime, runtime: "windows-desktop" });
});

test("an interop override reaches the runtime lookup and the driver", async () => {
  vi.stubEnv("CUA_DRIVER_PATH", undefined);
  expect(await loadComputerConfig(await workspace({ interop: "/run/WSL/7_interop" })))
    .toEqual({ command: runtime.command, bundled: runtime, interop: "/run/WSL/7_interop", runtime: "windows-desktop" });
  expect(findBundledRuntime).toHaveBeenCalledWith("/run/WSL/7_interop");
});

test("a trusted command and its own profile replace the shipped runtime without looking it up", async () => {
  vi.stubEnv("CUA_DRIVER_PATH", undefined);
  const config = { command: "/owned/candidate/cua-driver.exe", runtime: "windows-window-management" };
  expect(await loadComputerConfig(await workspace(config))).toEqual(config);
  vi.stubEnv("CUA_DRIVER_PATH", "C:\\Trusted\\cua-driver.exe");
  expect(await loadComputerConfig(await workspace())).toEqual({ command: "C:\\Trusted\\cua-driver.exe" });
  expect(findBundledRuntime).not.toHaveBeenCalled();
});
