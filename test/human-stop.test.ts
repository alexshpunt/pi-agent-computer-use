import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { McpDriver } from "../src/driver.ts";
import { HumanStop, reportsHumanStop } from "../src/human-stop.ts";
import { registerComputerMode } from "../src/mode.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

type Entry = { event?: string; pid?: number; env?: Record<string, string | null>; name?: string; arguments?: Record<string, unknown> };
async function start(mode: "notify" | "refuse-only" = "notify") {
  const dir = await mkdtemp(path.join(tmpdir(), "human-stop-"));
  dirs.push(dir);
  const log = path.join(dir, "calls.jsonl");
  const stop = new HumanStop();
  const driver = new McpDriver({ command: process.execPath, args: [path.resolve("test/fixtures/human-stop-driver.mjs"), log, mode] }, "0.33.2", undefined,
    stop, () => "Fix the build: <LPT-1088>");
  const entries = async () => (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Entry);
  return { driver, stop, entries };
}
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("condition not reached");
};

test("the driver stops on the native notification, refuses without reaching the process, and a resume starts a new one", async () => {
  const { driver, stop, entries } = await start();
  const stops = vi.fn();
  stop.onStop(stops);
  try {
    expect((await driver.call("list_windows", {})).isError).toBeFalsy();
    const [first] = await entries();
    // Three physical Escape presses stop input; agents take turns per action; the cursor names the session; nothing waits for the human.
    expect(first.env).toEqual({ CUA_ESCAPE_STOP: "1", CUA_SHARED_INPUT_LOCK: "1", CUA_SESSION_LABEL: "Fix the build LPT-1088", CUA_HUMAN_IDLE_MS: null });

    const stopped = await driver.call("press_key", { key: "escape-x3" });
    expect(stopped.structuredContent).toMatchObject({ code: "human_stop", status: "refused" });
    expect(stop.stopped).toBe(true);
    expect(stops).toHaveBeenCalledTimes(1);

    const calls = (await entries()).length;
    const refused = await driver.call("list_windows", {});
    expect(refused).toMatchObject({ isError: true, structuredContent: { code: "human_stop", attempted: false } });
    expect(refused.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("/computer-mode") });
    expect((await entries()).length).toBe(calls);

    stop.resume();
    await until(async () => (await entries()).some(entry => entry.event === "stdin-eof" && entry.pid === first.pid));
    expect((await driver.call("list_windows", {})).isError).toBeFalsy();
    const starts = (await entries()).filter(entry => entry.event === "start");
    expect(starts).toHaveLength(2);
    expect(starts[1].pid).not.toBe(first.pid);
  } finally { await driver.close(); }
});

test("a refusal that names the stop is enough when the notification is missed", async () => {
  const { driver, stop } = await start("refuse-only");
  try {
    await driver.call("press_key", { key: "escape-x3" });
    expect(stop.stopped).toBe(true);
  } finally { await driver.close(); }
});

test("native results report the stop by code or by message", () => {
  expect(reportsHumanStop({ content: [], structuredContent: { code: "human_stop" } })).toBe(true);
  expect(reportsHumanStop({ content: [], structuredContent: { refusal: { code: "human_stop" } } })).toBe(true);
  expect(reportsHumanStop({ content: [{ type: "text", text: "Error: human_stop: the human pressed Escape" }] })).toBe(true);
  expect(reportsHumanStop({ content: [{ type: "text", text: "foreground_lost" }], structuredContent: { code: "foreground_unavailable" } })).toBe(false);
});

test("the stop shows as STOPPED, tells the agent, and selecting a mode turns computer use on again", async () => {
  const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
  const events = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => unknown>();
  const sendMessage = vi.fn();
  const pi = { registerCommand: (name: string, command: never) => commands.set(name, command), on: (name: string, handler: never) => events.set(name, handler),
    appendEntry: vi.fn(), sendMessage } as unknown as ExtensionAPI;
  const ctx = { hasUI: true, ui: { setStatus: vi.fn(), notify: vi.fn() }, sessionManager: { getBranch: () => [] } } as unknown as ExtensionCommandContext;
  const stop = new HumanStop();
  const getMode = registerComputerMode(pi, async () => {}, () => true, stop);
  await events.get("session_start")!({}, ctx);

  stop.stop();
  expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("computer-use", "Computer: STOPPED");
  expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Escape was pressed three times"), "warning");
  expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ customType: "computer-use-stop", content: expect.stringContaining("Do not retry") }), { deliverAs: "steer" });

  // Showing the mode does not turn it on.
  await commands.get("computer-mode")!.handler("", ctx);
  expect(stop.stopped).toBe(true);
  expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("STOPPED"), "warning");

  // Selecting the current mode turns it on again.
  await commands.get("computer-mode")!.handler("yolo", ctx);
  expect(stop.stopped).toBe(false);
  expect(getMode()).toBe("yolo");
  expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("computer-use", "Computer: YOLO");
  expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringContaining("on again") }), { deliverAs: "nextTurn" });
});
