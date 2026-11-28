import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { loadComputerConfig, readMachineSettings } from "../src/config.ts";
import { McpDriver } from "../src/driver.ts";
import { observationSource } from "../src/observation-source.ts";

vi.mock("../src/wsl-interop.ts", () => ({ liveInterop: vi.fn(async () => undefined) }));

// LPT-1939: a window read asks the driver to peek at a minimized window, but only a driver that lists the argument.
async function sent(mode: "peek" | "legacy", options: { minimizedCapture?: "peek" | "refuse" } = {}, args: Record<string, unknown> = {}) {
  await mkdir(".tmp/minimized-peek", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/minimized-peek/run-"));
  const log = path.join(cwd, "calls.jsonl");
  const backend = new McpDriver({ command: process.execPath, args: [path.resolve("test/fixtures/minimized-peek-driver.mjs"), log, mode], driverOverride: true, ...options });
  try {
    const result = await backend.call("get_window_state", { pid: 42, window_id: 91, ...args });
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { name: string; arguments: Record<string, unknown> });
    return { result, call: calls.find(call => call.name === "get_window_state")! };
  } finally { await backend.close(); await rm(cwd, { recursive: true, force: true }); }
}

test("a window read asks a driver that supports it to peek at a minimized window", async () => {
  const { call } = await sent("peek");
  expect(call.arguments).toMatchObject({ pid: 42, window_id: 91, minimized_capture: "peek" });
});
test("a driver that does not list the argument never receives it", async () => {
  const { call } = await sent("legacy");
  expect(call.arguments).not.toHaveProperty("minimized_capture");
});
test("the project can keep minimized windows refused", async () => {
  const { call } = await sent("peek", { minimizedCapture: "refuse" });
  expect(call.arguments).not.toHaveProperty("minimized_capture");
});
test("a tree-only read does not restore a window, and an explicit mode is kept", async () => {
  expect((await sent("peek", {}, { include_screenshot: false })).call.arguments).not.toHaveProperty("minimized_capture");
  expect((await sent("peek", {}, { minimized_capture: "refuse" })).call.arguments).toMatchObject({ minimized_capture: "refuse" });
});

test("the observation names a peek next to the pixels", async () => {
  const { result } = await sent("peek");
  const source = observationSource("window", result.structuredContent!, { window_ref: "w1" });
  expect(source.visibility.minimized_capture).toEqual({ mode: "peek", settle_ms: 150, held_ms: 480 });
  expect(observationSource("window", { pid: 42 }, { window_ref: "w1" }).visibility).not.toHaveProperty("minimized_capture");
});

test("the minimized capture setting is read for local and remote drivers and refuses unknown values", async () => {
  await mkdir(".tmp/minimized-peek", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/minimized-peek/config-"));
  try {
    await mkdir(path.join(cwd, ".pi"));
    const file = path.join(cwd, ".pi/computer-use.json");
    for (const minimizedCapture of ["peek", "refuse"]) {
      await writeFile(file, JSON.stringify({ command: "driver", minimizedCapture }));
      expect((await loadComputerConfig(cwd)).minimizedCapture).toBe(minimizedCapture);
      expect((await readMachineSettings(cwd)).minimizedCapture).toBe(minimizedCapture);
    }
    await writeFile(file, JSON.stringify({ command: "driver", minimizedCapture: "restore" }));
    await expect(loadComputerConfig(cwd)).rejects.toThrow();
    await expect(readMachineSettings(cwd)).rejects.toThrow();
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
