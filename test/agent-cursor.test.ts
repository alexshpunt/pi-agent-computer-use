import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { McpDriver } from "../src/driver.ts";
import { VisualSettings } from "../src/native-visuals.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function start(mode: "applies" | "refuses" | "ignores" | "no-overlay" | "visuals" | "visuals-refused" | "visuals-retry-discovery" | "visuals-retry-configuration") {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-cursor-"));
  dirs.push(dir);
  const log = path.join(dir, "calls.jsonl");
  const settings = new VisualSettings();
  const driver = new McpDriver({ command: process.execPath, args: [path.resolve("test/fixtures/agent-cursor-driver.mjs"), log, mode] }, "0.33.2", settings);
  const calls = async () => (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { name: string; arguments: Record<string, unknown> });
  return { driver, calls, settings };
}

test("the driver makes the agent cursor jump and checks the setting before any other call", async () => {
  const { driver, calls } = await start("applies");
  try {
    expect((await driver.call("list_windows", {})).isError).toBeFalsy();
    expect(await calls()).toEqual([
      { name: "set_agent_cursor_motion", arguments: { glide_duration_ms: 1 } },
      { name: "get_agent_cursor_state", arguments: {} },
      { name: "list_windows", arguments: {} },
    ]);
  } finally { await driver.close(); }
});

test("a native visual driver receives presentation settings without forcing a one-millisecond glide", async () => {
  const { driver, calls } = await start("visuals");
  try {
    await driver.call("list_windows", {});
    expect((await calls()).map(call => call.name)).toEqual(["set_agent_visuals", "list_windows"]);
    expect((await calls())[0].arguments).toMatchObject({ preset: "full", previews: true });
    await driver.visuals({ target: { pid: 42, window_id: 101 }, identity: `PiComputerUse.${"a".repeat(32)}:42:1`, bounds: { x: 0, y: 0, width: 800, height: 600 } });
    for (let n = 0; n < 20 && (await calls()).length < 3; n++) await new Promise(resolve => setTimeout(resolve, 5));
    expect((await calls()).at(-1)).toMatchObject({ name: "present_agent_activity", arguments: { kind: "overview", generation: 1 } });
  } finally { await driver.close(); }
});
test.each(["discovery", "configuration"] as const)("visuals and off preferences survive cancellation during first %s", async phase => {
  const { driver, calls, settings } = await start(`visuals-retry-${phase}`);
  const controller = new AbortController();
  const attempt = driver.call("list_windows", {}, controller.signal).catch(error => error);
  try {
    const waiting = phase === "discovery" ? "discovery_wait" : "set_agent_visuals";
    await vi.waitFor(async () => expect((await calls()).some(call => call.name === waiting)).toBe(true));
    controller.abort();
    expect(await attempt).toBeInstanceOf(Error);
    expect((await driver.call("list_windows", {})).isError).toBeFalsy();
    const frame = { target: { pid: 42, window_id: 101 }, identity: `PiComputerUse.${"a".repeat(32)}:42:1`, bounds: { x: 0, y: 0, width: 800, height: 600 } };
    expect(await driver.visuals(frame)).toMatchObject({ status: "queued" });
    await vi.waitFor(async () => expect((await calls()).at(-1)).toMatchObject({ name: "present_agent_activity", arguments: { kind: "overview" } }));
    settings.update({ preset: "off" });
    await vi.waitFor(async () => expect((await calls()).at(-1)).toMatchObject({ name: "set_agent_visuals", arguments: { preset: "off" } }));
    expect(await driver.visuals(frame)).toMatchObject({ status: "skipped" });
    expect((await calls()).filter(call => call.name === "list_windows")).toHaveLength(1);
    expect((await calls()).filter(call => call.name === "present_agent_activity")).toHaveLength(1);
  } finally { controller.abort(); await attempt; await driver.close(); }
});
test("presentation configuration failure leaves input usable without replay", async () => {
  const { driver, calls } = await start("visuals-refused");
  try {
    expect((await driver.call("list_windows", {})).isError).toBeFalsy();
    expect((await calls()).map(call => call.name)).toEqual(["set_agent_visuals", "list_windows"]);
  } finally { await driver.close(); }
});

test("a capture companion disables its own native presentation", async () => {
  const { driver, calls } = await start("visuals"); const companion = driver.companion()!;
  try {
    await companion.call("list_windows", {});
    expect((await calls())[0]).toMatchObject({ name: "set_agent_visuals", arguments: { preset: "off" } });
    await driver.call("list_windows", {});
    expect((await calls())[2]).toMatchObject({ name: "set_agent_visuals", arguments: { preset: "full" } });
  } finally { await companion.close(); await driver.close(); }
});
test("a refused cursor setting stops the driver before any input", async () => {
  const { driver, calls } = await start("refuses");
  await expect(driver.call("list_windows", {})).rejects.toThrow("refused the agent cursor glide setting");
  expect((await calls()).map(call => call.name)).toEqual(["set_agent_cursor_motion"]);
});

test("a driver without an overlay draws no cursor, so an unapplied setting does not stop it", async () => {
  const { driver, calls } = await start("no-overlay");
  try {
    expect((await driver.call("list_windows", {})).isError).toBeFalsy();
    expect((await calls()).map(call => call.name)).toEqual(["set_agent_cursor_motion", ...Array(6).fill("get_agent_cursor_state"), "list_windows"]);
  } finally { await driver.close(); }
});

test("a cursor setting that never applies stops the driver after six reads", async () => {
  const { driver, calls } = await start("ignores");
  await expect(driver.call("list_windows", {})).rejects.toThrow("did not apply the agent cursor glide setting");
  expect((await calls()).map(call => call.name)).toEqual(["set_agent_cursor_motion", ...Array(6).fill("get_agent_cursor_state")]);
});
