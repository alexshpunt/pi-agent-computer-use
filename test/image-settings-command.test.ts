import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { CuaImageSettings } from "../src/cua-image-settings.ts";
import { registerImageSettingsCommand } from "../src/image-settings-command.ts";

type Command = { handler(args: string, ctx: ExtensionCommandContext): Promise<void> };
function fixture() {
  const commands = new Map<string, Command>();
  const images = new CuaImageSettings(() => "bilinear");
  const notify = vi.fn();
  registerImageSettingsCommand({ registerCommand: (name: string, command: Command) => commands.set(name, command) } as unknown as ExtensionAPI, images);
  const ctx = { hasUI: true, ui: { notify } } as unknown as ExtensionCommandContext;
  return { images, notify, run: (input: string) => commands.get("computer-images")!.handler(input, ctx), commands };
}

test("the human image command changes future native captures without a filter switch", async () => {
  const f = fixture(); const old = f.images.settings();
  await f.run("cap 800"); await f.run("scale 0.5"); await f.run("hints off"); await f.run("guides all");
  expect(f.images.settings()).toMatchObject({ kernel: "bilinear", maxLongEdge: 800, scale: 0.5, hints: false,
    guides: { grid: true, action: true }, version: 4 });
  expect(old).toMatchObject({ maxLongEdge: 1280, scale: 1, version: 0 });
  expect(old.hints).toBeUndefined(); expect(old.guides).toBeUndefined();
  await f.run("reset"); expect(f.images.settings()).toEqual(old);
});

test("bad image command arguments preserve the full settings tuple", async () => {
  const f = fixture(); await f.run("cap 800"); const saved = f.images.settings();
  for (const input of ["cap 63", "cap 800.5", "cap Infinity", "scale 0", "scale NaN", "hints false", "hints off extra",
    "guides on", "kernel lanczos3", "mode yolo", "reset extra"]) {
    await f.run(input); expect(f.images.settings()).toEqual(saved);
    expect(f.notify.mock.calls.at(-1)?.[1]).toBe("warning");
  }
});

test("showing image settings does not change captures and instances stay independent", async () => {
  const first = fixture(); const second = fixture();
  await first.run("cap 600"); await first.run("guides grid");
  const saved = first.images.settings(); await first.run(""); await first.run("show");
  expect(first.images.settings()).toEqual(saved);
  expect(second.images.settings()).toMatchObject({ maxLongEdge: 1280, scale: 1, version: 0 });
  expect(first.commands.size).toBe(1);
  expect(first.notify.mock.calls.at(-1)?.[0]).toContain("600");
});
