import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import extension from "../src/index.ts";
import { registerComputerMode } from "../src/mode.ts";

type Command = { handler(args: string, ctx: ExtensionCommandContext): Promise<void> };
function fixture(branch: unknown[] = []) {
  const commands = new Map<string, Command>();
  const tools = new Map<string, { execute(...args: unknown[]): Promise<unknown> }>();
  const events = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => unknown>();
  const appendEntry = vi.fn((customType: string, data: unknown) => branch.push({ type: "custom", customType, data }));
  const ctx = { hasUI: true, ui: { setStatus: vi.fn(), notify: vi.fn() },
    sessionManager: { getBranch: () => branch } } as unknown as ExtensionCommandContext;
  extension({ registerCommand: (name: string, command: Command) => commands.set(name, command),
    registerTool: (tool: { name: string; execute(...args: unknown[]): Promise<unknown> }) => tools.set(tool.name, tool),
    on: (name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => unknown) => events.set(name, handler),
    appendEntry } as unknown as ExtensionAPI);
  return { commands, tools, events, appendEntry, ctx,
    close: () => tools.get("computer_close")!.execute("close", {}, undefined, undefined, ctx) };
}

test("only a user command changes mode; the computer tool surface cannot promote it", async () => {
  const f = fixture();
  expect(f.commands.has("computer-mode")).toBe(true);
  expect([...f.tools.keys()]).toEqual(["computer_classify", "computer_sequence", "computer_apps", "computer_open", "computer_windows", "computer_observe", "computer_act", "computer_close"]);
  expect(await f.close()).toMatchObject({ details: { mode: "yolo" } });
  await f.commands.get("computer-mode")!.handler("safe", f.ctx);
  expect(await f.close()).toMatchObject({ details: { mode: "safe" } });
  expect(f.appendEntry).toHaveBeenCalledWith("computer-use-mode", { mode: "safe" });
  expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("computer-use", "Computer: SAFE");
});

test("invalid mode arguments neither change policy nor persist a new value", async () => {
  const f = fixture();
  expect(f.commands.has("computer-mode")).toBe(true);
  await f.commands.get("computer-mode")!.handler("safe yolo", f.ctx);
  expect(await f.close()).toMatchObject({ details: { mode: "yolo" } });
  expect(f.appendEntry).not.toHaveBeenCalled();
  expect(f.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/computer-mode safe|yolo"), "warning");
});

test("a user-selected Safe mode is restored on reload instead of silently falling back to YOLO", async () => {
  const branch: unknown[] = [];
  const first = fixture(branch);
  expect(first.commands.has("computer-mode")).toBe(true);
  await first.commands.get("computer-mode")!.handler("safe", first.ctx);
  const reloaded = fixture(branch);
  await reloaded.events.get("session_start")!({ type: "session_start", reason: "reload" }, reloaded.ctx);
  expect(await reloaded.close()).toMatchObject({ details: { mode: "safe" } });
  expect(reloaded.ctx.ui.setStatus).toHaveBeenLastCalledWith("computer-use", "Computer: SAFE");
});

test("user policy change and branch restore clear frames without exposing a model command", async () => {
  const clear = vi.fn(async () => {}); const f = fixture();
  const getMode = registerComputerMode({ registerCommand: (name: string, command: Command) => f.commands.set(name, command),
    on: (name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => unknown) => f.events.set(name, handler),
    appendEntry: f.appendEntry } as unknown as ExtensionAPI, clear);
  await f.commands.get("computer-mode")!.handler("", f.ctx); expect(clear).not.toHaveBeenCalled();
  await f.commands.get("computer-mode")!.handler("safe", f.ctx);
  expect(getMode()).toBe("safe"); expect(clear).toHaveBeenCalledTimes(1);
  await f.events.get("session_tree")!({}, f.ctx); expect(clear).toHaveBeenCalledTimes(2);
  await f.commands.get("computer-mode")!.handler("invalid", f.ctx); expect(clear).toHaveBeenCalledTimes(2);
});