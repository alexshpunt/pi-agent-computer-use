import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { readEscapeStop, registerComputerSettingsCommand, writeEscapeStop } from "../src/computer-settings.ts";
import { registerComputerMode } from "../src/mode.ts";
import { CuaImageSettings } from "../src/cua-image-settings.ts";
import { VisualSettings } from "../src/native-visuals.ts";
import { HumanStop } from "../src/human-stop.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function workspace() { const dir = await mkdtemp(path.join(tmpdir(), "computer-settings-")); dirs.push(dir); return dir; }

test("the shortcut setting defaults to enabled and can be saved without losing existing configuration", async () => {
  const cwd = await workspace();
  expect(await readEscapeStop(cwd)).toBe(true);
  await mkdir(path.join(cwd, ".pi"));
  const file = path.join(cwd, ".pi", "computer-use.json");
  await writeFile(file, JSON.stringify({ machines: { office: { ssh: "office" } }, command: "driver" }));
  await writeEscapeStop(cwd, false);
  expect(await readEscapeStop(cwd)).toBe(false);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ machines: { office: { ssh: "office" } }, command: "driver", escapeStop: false });
  await writeEscapeStop(cwd, true);
  expect(await readEscapeStop(cwd)).toBe(true);
});

test("the shortcut setting never overwrites an invalid configuration", async () => {
  const cwd = await workspace(); await mkdir(path.join(cwd, ".pi"));
  const file = path.join(cwd, ".pi", "computer-use.json");
  await writeFile(file, "invalid json");
  await expect(writeEscapeStop(cwd, false)).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe("invalid json");
});


test("the panel changes the real settings and respects mode safety", async () => {
  initTheme("dark", false);
  const cwd = await workspace();
  const handlers = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const entries: unknown[] = [];
  const pi = { on: vi.fn(), registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => handlers.set(name, command.handler), appendEntry: (_type: string, data: unknown) => entries.push(data), sendMessage: vi.fn() } as unknown as ExtensionAPI;
  const stop = new HumanStop();
  let safeAllowed = false;
  const mode = registerComputerMode(pi, async () => {}, () => safeAllowed, stop);
  const images = new CuaImageSettings(); const visuals = new VisualSettings();
  registerComputerSettingsCommand(pi, { mode, images, visuals, stop });
  let component: Component | undefined;
  const ctx = { cwd, mode: "tui", hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn(), custom: async (factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => Component) => {
    component = factory({ terminal: { rows: 35 }, requestRender: () => {} }, { fg: (_c: string, s: string) => s, bold: (s: string) => s }, {}, () => {});
  } } } as unknown as ExtensionCommandContext;
  await handlers.get("computer-settings")!("", ctx);
  const key = (data: string) => component!.handleInput!(data);
  const settled = () => new Promise(resolve => setTimeout(resolve, 20));
  key("\r"); await settled();
  expect(mode()).toBe("yolo");
  safeAllowed = true; key("\r"); await settled(); expect(mode()).toBe("safe");
  stop.stop(); expect(stop.stopped).toBe(true);
  key("\u001b[B"); key("\r"); await settled(); expect(stop.stopped).toBe(false);
  key("\u001b[B"); key("\r"); await vi.waitFor(async () => expect(await readEscapeStop(cwd)).toBe(false)); await settled();
  key("\u001b[B"); key("\r"); key("\u0015"); key("800"); key("\r"); await settled(); expect(images.settings().maxLongEdge).toBe(800);
  for (let i = 0; i < 5; i++) key("\u001b[B");
  key("\r"); await settled(); expect(visuals.current().preset).toBe("off"); expect(entries).toContainEqual(expect.objectContaining({ preset: "off" }));
});