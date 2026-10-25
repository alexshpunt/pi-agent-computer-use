import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { McpDriver } from "../src/driver.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function start(mode: "applies" | "refuses" | "ignores") {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-cursor-"));
  dirs.push(dir);
  const log = path.join(dir, "calls.jsonl");
  const driver = new McpDriver({ command: process.execPath, args: [path.resolve("test/fixtures/agent-cursor-driver.mjs"), log, mode] });
  const calls = async () => (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { name: string; arguments: Record<string, unknown> });
  return { driver, calls };
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

test("a refused cursor setting stops the driver before any input", async () => {
  const { driver, calls } = await start("refuses");
  await expect(driver.call("list_windows", {})).rejects.toThrow("refused the agent cursor glide setting");
  expect((await calls()).map(call => call.name)).toEqual(["set_agent_cursor_motion"]);
});

test("a cursor setting that never applies stops the driver after six reads", async () => {
  const { driver, calls } = await start("ignores");
  await expect(driver.call("list_windows", {})).rejects.toThrow("did not apply the agent cursor glide setting");
  expect((await calls()).map(call => call.name)).toEqual(["set_agent_cursor_motion", ...Array(6).fill("get_agent_cursor_state")]);
});
