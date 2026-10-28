import { expect, test } from "vitest";
import { CuaImageSettings, nativeImageCap } from "../src/cua-image-settings.ts";

test("image settings follow the selected native filter without offering a filter switch", () => {
  let kernel: "lanczos3" | "bilinear" = "bilinear";
  const images = new CuaImageSettings(() => kernel);
  const frozen = images.settings();
  expect(frozen.kernel).toBe("bilinear");
  expect(images.update({ kernel: "bilinear", maxLongEdge: 800, scale: 1 }).kernel).toBe("bilinear");
  expect(() => images.update({ kernel: "lanczos3", maxLongEdge: 800, scale: 1 })).toThrow();
  images.reset(); expect(images.settings().kernel).toBe("bilinear");
  kernel = "lanczos3";
  expect(images.settings().kernel).toBe("lanczos3");
  expect(frozen.kernel).toBe("bilinear");
});

test("guide writes require a complete tuple and keep previous captures frozen", () => {
  const images = new CuaImageSettings(); const original = images.settings();
  const guides = { grid: true, action: true };
  for (const input of [{ grid: true }, { ...guides, mode: "yolo" }, { ...guides, action: 1 }]) {
    expect(() => images.setGuides(input)).toThrow();
    expect(images.settings()).toEqual(original);
  }
  expect(images.setGuides(guides)).toMatchObject({ guides, version: 1 });
  expect(original.guides).toBeUndefined();
  const copy = images.settings(); copy.guides!.grid = false;
  expect(images.settings().guides).toEqual(guides);
});

test("hints remain session-local and do not rewrite frozen capture settings", () => {
  const images = new CuaImageSettings(); const another = new CuaImageSettings(); const frozen = images.settings();
  for (const value of ["false", 0, undefined]) {
    expect(() => images.setHints(value as unknown as boolean)).toThrow();
    expect(images.settings()).toEqual(frozen);
  }
  expect(images.setHints(false)).toMatchObject({ hints: false, version: 1 });
  images.update({ kernel: "lanczos3", maxLongEdge: 800, scale: 1 });
  expect(images.settings()).toMatchObject({ hints: false, version: 2 });
  expect(frozen.hints).toBeUndefined(); expect(another.settings()).toEqual(frozen);
});

test("native settings freeze captures, reject unsupported tuples and reset", () => {
  const images = new CuaImageSettings(); const first = images.settings();
  expect(first).toMatchObject({ kernel: "lanczos3", maxLongEdge: 1280, scale: 1, version: 0, route: "cua_native" });
  expect(images.update({ kernel: "lanczos3", maxLongEdge: 800, scale: 0.625 })).toMatchObject({ version: 1, scale: 0.625 });
  expect(first.scale).toBe(1);
  for (const input of [{ kernel: "mks2021", maxLongEdge: 500, scale: 1 }, { kernel: "lanczos3", maxLongEdge: 500, scale: 0 },
    { kernel: "lanczos3", maxLongEdge: 500, scale: 1, mode: "yolo" }, { kernel: "lanczos3", maxLongEdge: 800.5, scale: 1 },
    { kernel: "lanczos3", maxLongEdge: 500 }, null]) {
    expect(() => images.update(input)).toThrow();
    expect(images.settings()).toMatchObject({ version: 1, maxLongEdge: 800, scale: 0.625 });
  }
  expect(nativeImageCap(images.settings())).toBe(500);
  images.reset(); expect(images.settings()).toEqual(first);
});

test("concurrent settings stores preserve each capture's configuration", async () => {
  const first = new CuaImageSettings(); const second = new CuaImageSettings(); const frozen = first.settings();
  const replies = await Promise.all([
    Promise.resolve().then(() => first.update({ kernel: "lanczos3", maxLongEdge: 800, scale: 0.5 })),
    Promise.resolve().then(() => first.update({ kernel: "lanczos3", maxLongEdge: 600, scale: 0.75 })),
  ]);
  expect(replies.map(value => value.version)).toEqual([1, 2]);
  expect(first.settings()).toEqual(replies[1]); expect(second.settings()).toEqual(frozen);
  first.update({ kernel: "lanczos3", maxLongEdge: 4096, scale: 1 });
  expect(frozen).toMatchObject({ maxLongEdge: 1280, scale: 1, version: 0 });
  first.reset(); expect(first.settings()).toEqual(frozen); expect(second.settings()).toEqual(frozen);
});
