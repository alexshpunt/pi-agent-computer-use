import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import extension from "../src/index.ts";
import { registerComputerMode } from "../src/mode.ts";
import { registerComputerProvider } from "../src/provider.ts";

// Policy is independent of the IDE event bus; real-Pi provider tests cover that boundary.
vi.mock("../src/provider.ts", () => ({ registerComputerProvider: vi.fn(async () => ({ resources: {}, guide: "", attached: () => true })) }));

type Command = { handler(args: string, ctx: ExtensionCommandContext): Promise<void> };
async function fixture(branch: unknown[] = []) {
  const commands = new Map<string, Command>();
  const tools = new Map<string, { execute(...args: unknown[]): Promise<unknown> }>();
  const events = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => unknown>();
  const appendEntry = vi.fn((customType: string, data: unknown) => branch.push({ type: "custom", customType, data }));
  const ctx = { hasUI: true, ui: { setStatus: vi.fn(), notify: vi.fn() },
    sessionManager: { getBranch: () => branch, getSessionId: () => "session" } } as unknown as ExtensionCommandContext;
  await extension({ registerCommand: (name: string, command: Command) => commands.set(name, command),
    registerTool: (tool: { name: string; execute(...args: unknown[]): Promise<unknown> }) => tools.set(tool.name, tool),
    // Pi runs every handler of an event in registration order.
    on: (name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => unknown) => {
      const previous = events.get(name);
      events.set(name, previous ? async (event, context) => { await previous(event, context); return handler(event, context); } : handler);
    },
    getActiveTools: () => [], getAllTools: () => [], setActiveTools: vi.fn(),
    appendEntry } as unknown as ExtensionAPI);
  return { commands, tools, events, appendEntry, ctx,
    close: vi.mocked(registerComputerProvider).mock.calls.at(-1)![2] };
}

test("only a user command changes mode; the computer tool surface cannot promote it", async () => {
  const f = await fixture();
  expect(f.commands.has("computer-mode")).toBe(true);
  expect([...f.tools.keys()]).toEqual([]);
  expect(await f.close()).toMatchObject({ details: { mode: "yolo" } });
  await f.commands.get("computer-mode")!.handler("safe", f.ctx);
  expect(await f.close()).toMatchObject({ details: { mode: "safe" } });
  expect(f.appendEntry).toHaveBeenCalledWith("computer-use-mode", { mode: "safe" });
  expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("computer-use", "Computer: SAFE");
});

test("invalid mode arguments neither change policy nor persist a new value", async () => {
  const f = await fixture();
  expect(f.commands.has("computer-mode")).toBe(true);
  await f.commands.get("computer-mode")!.handler("safe yolo", f.ctx);
  expect(await f.close()).toMatchObject({ details: { mode: "yolo" } });
  expect(f.appendEntry).not.toHaveBeenCalled();
  expect(f.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/computer-mode safe|yolo"), "warning");
});

test("a user-selected Safe mode is restored on reload instead of silently falling back to YOLO", async () => {
  const branch: unknown[] = [];
  const first = await fixture(branch);
  expect(first.commands.has("computer-mode")).toBe(true);
  await first.commands.get("computer-mode")!.handler("safe", first.ctx);
  const reloaded = await fixture(branch);
  await reloaded.events.get("session_start")!({ type: "session_start", reason: "reload" }, reloaded.ctx);
  expect(await reloaded.close()).toMatchObject({ details: { mode: "safe" } });
  expect(reloaded.ctx.ui.setStatus).toHaveBeenLastCalledWith("computer-use", "Computer: SAFE");
});

test("user policy change and branch restore clear frames without exposing a model command", async () => {
  const clear = vi.fn(async () => {}); const f = await fixture();
  const getMode = registerComputerMode({ registerCommand: (name: string, command: Command) => f.commands.set(name, command),
    on: (name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => unknown) => f.events.set(name, handler),
    appendEntry: f.appendEntry } as unknown as ExtensionAPI, clear);
  await f.commands.get("computer-mode")!.handler("", f.ctx); expect(clear).not.toHaveBeenCalled();
  await f.commands.get("computer-mode")!.handler("safe", f.ctx);
  expect(getMode()).toBe("safe"); expect(clear).toHaveBeenCalledTimes(1);
  await f.events.get("session_tree")!({}, f.ctx); expect(clear).toHaveBeenCalledTimes(2);
  await f.commands.get("computer-mode")!.handler("invalid", f.ctx); expect(clear).toHaveBeenCalledTimes(2);
});