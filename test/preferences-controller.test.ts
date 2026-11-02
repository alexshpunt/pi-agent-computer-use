import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CuaImageSettings } from "../src/cua-image-settings.ts";
import { VisualSettings } from "../src/native-visuals.ts";
import { HumanStop } from "../src/human-stop.ts";
import { registerComputerMode } from "../src/mode.ts";
import { PreferencesController } from "../src/preferences-controller.ts";

const dirs: string[] = []; const agentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(async () => { if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = agentDir; await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
test("a scoped preset preserves a legacy per-setting preview preference", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cua-previews-")); dirs.push(root); process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  const pi = { on: vi.fn(), registerCommand: vi.fn(), appendEntry: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
  const ctx = { cwd: path.join(root, "project"), hasUI: true, isProjectTrusted: () => true, ui: { notify: vi.fn(), setStatus: vi.fn() }, sessionManager: { getBranch: () => [{ type: "custom", customType: "computer-use-visuals", data: { preset: "subtle", previews: false } }] } } as unknown as ExtensionCommandContext;
  const visuals = new VisualSettings(); visuals.restore({ preset: "subtle", previews: false });
  const prefs = new PreferencesController(new CuaImageSettings(), visuals, registerComputerMode(pi)); prefs.captureBaseline(ctx);
  await prefs.set(ctx, "global", "preset", "full");
  expect(visuals.current()).toMatchObject({ preset: "full", previews: false });
});

test("a session Safe selection is not widened by the global default on restore", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cua-mode-")); dirs.push(root); process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  const branch: unknown[] = []; const events = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => Promise<void>>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => Promise<void>) => events.set(name, handler), registerCommand: vi.fn(), appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }), sendMessage: vi.fn() } as unknown as ExtensionAPI;
  const ctx = { cwd: path.join(root, "project"), hasUI: true, isProjectTrusted: () => true, ui: { notify: vi.fn(), setStatus: vi.fn() }, sessionManager: { getBranch: () => branch } } as unknown as ExtensionCommandContext;
  const mode = registerComputerMode(pi); const prefs = new PreferencesController(new CuaImageSettings(), new VisualSettings(), mode);
  await prefs.set(ctx, "global", "mode", "yolo");
  await mode.select("safe", ctx); expect(mode()).toBe("safe");
  await events.get("session_tree")!({}, ctx); prefs.captureBaseline(ctx); await prefs.apply(ctx, true, true);
  expect(mode()).toBe("safe");
});
test("a blocked Safe change is not persisted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cua-safe-")); dirs.push(root);
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  const pi = { on: vi.fn(), registerCommand: vi.fn(), appendEntry: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
  const ctx = { cwd: path.join(root, "project"), hasUI: true, isProjectTrusted: () => true, ui: { notify: vi.fn(), setStatus: vi.fn() } } as unknown as ExtensionCommandContext;
  const mode = registerComputerMode(pi, undefined, () => false);
  const prefs = new PreferencesController(new CuaImageSettings(), new VisualSettings(), mode);
  await expect(prefs.set(ctx, "project", "mode", "safe")).rejects.toThrow();
  expect((await prefs.read(ctx)).effective.mode).toBeUndefined();
  expect(mode()).toBe("yolo");
});
test("restores preferences across sessions, preserves legacy settings and ignores untrusted project overrides", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cua-controller-")); dirs.push(root);
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent"); const cwd = path.join(root, "project");
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  const config = path.join(cwd, ".pi", "computer-use.json"); await writeFile(config, JSON.stringify({ command: "driver", escapeStop: false }));
  const ctx = { cwd, hasUI: true, isProjectTrusted: () => true, ui: { notify: vi.fn(), setStatus: vi.fn() } } as unknown as ExtensionCommandContext;
  const make = () => {
    const pi = { on: vi.fn(), registerCommand: vi.fn(), appendEntry: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const images = new CuaImageSettings(); const visuals = new VisualSettings(); const stop = new HumanStop();
    const mode = registerComputerMode(pi, undefined, undefined, stop);
    return { images, visuals, stop, mode, prefs: new PreferencesController(images, visuals, mode) };
  };
  const first = make();
  await first.prefs.set(ctx, "global", "cap", 900);
  await first.prefs.set(ctx, "project", "cap", 700);
  await first.prefs.set(ctx, "global", "escape", true);
  expect((await first.prefs.read(ctx)).effective.escape).toBe(false);
  const next = make(); next.stop.stop(); await next.prefs.apply(ctx);
  expect(next.images.settings().maxLongEdge).toBe(700); expect(next.stop.stopped).toBe(true);
  await next.prefs.set(ctx, "project", "escape", undefined);
  expect((await next.prefs.read(ctx)).effective.escape).toBe(true);
  expect(JSON.parse(await readFile(config, "utf8"))).toEqual({ command: "driver" });
  const untrusted = { ...ctx, isProjectTrusted: () => false } as ExtensionCommandContext;
  await next.prefs.apply(untrusted);
  expect(next.images.settings().maxLongEdge).toBe(900);
});
