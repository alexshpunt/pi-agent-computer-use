import { expect, test } from "vitest";
import sharp from "sharp";
import { annotateUi, createUiResource } from "../src/ui-resources.ts";
import { CuaImageSettings } from "../src/cua-image-settings.ts";

async function fixture(width = 500, height = 320) {
  const bytes = await sharp({ create: { width, height, channels: 3, background: "#eef4ff" } }).png().toBuffer();
  const image = { type: "image" as const, mimeType: "image/png", data: bytes.toString("base64") };
  const ui = createUiResource({ elements: [{ element_index: 1, element_token: "target", label: "Target", role: "Button", enabled: true,
    screenshot_frame: { x: 90, y: 90, w: 60, h: 40 } }] }, "window", "observation", 1);
  return { bytes, image, ui };
}

test.each([500, 800, 1024])("grid uses %ipx output coordinates without covering reported controls", async width => {
  const f = await fixture(width);
  const result = await annotateUi(f.image, f.ui, width, 320, false, undefined, f.ui.elements,
    { options: { grid: true, action: false } });
  expect(result.annotation.guides.grid).toMatchObject({ status: "shown", coordinate_space: "window_image_pixels" });
  expect(result.image.type).toBe("image");
  if (result.image.type !== "image") throw Error("Missing image");
  const marked = Buffer.from(result.image.data, "base64");
  expect(marked.equals(f.bytes)).toBe(false);
  expect(await sharp(marked).metadata()).toMatchObject({ width, height: 320 });
  const target = { left: 91, top: 91, width: 58, height: 38 };
  expect((await sharp(marked).extract(target).removeAlpha().raw().toBuffer()).equals(await sharp(f.bytes).extract(target).removeAlpha().raw().toBuffer())).toBe(true);
  expect(f.image.data).toBe(f.bytes.toString("base64"));
});

test("a completed action without proven geometry cannot claim a mark", async () => {
  const f = await fixture();
  const result = await annotateUi(f.image, f.ui, 500, 320, false, undefined, f.ui.elements,
    { options: { grid: false, action: true }, action: { reason: "Native geometry unavailable." } });
  expect(result.annotation.guides.action).toMatchObject({ status: "unavailable", reason: "Native geometry unavailable." });
});

test("turning guides off preserves raw bytes exactly and never mutates a previous annotation", async () => {
  const f = await fixture();
  const enabled = await annotateUi(f.image, f.ui, 500, 320, false, undefined, f.ui.elements,
    { options: { grid: true, action: true }, action: { region: { x: 90, y: 90, width: 60, height: 40 } } });
  const frozen = JSON.stringify(enabled.annotation);
  const off = await annotateUi(f.image, f.ui, 500, 320, false, undefined, f.ui.elements,
    { options: { grid: false, action: false } });
  expect(off.image).toEqual(f.image);
  expect(off.annotation.guides.grid.status).toBe("off");
  expect(JSON.stringify(enabled.annotation)).toBe(frozen);
});

test("omitted grid labels and partially hidden borders are explicit", async () => {
  const {imageGuides} = await import("../src/image-guides.ts");
  const result=imageGuides(500,320,{options:{grid:true,action:true},action:{region:{x:10,y:10,width:160,height:100}}},
    [{x:0,y:0,width:500,height:25},{x:0,y:295,width:500,height:25}]);
  expect(result.metadata.grid.omitted_labels).toBe(6);
  expect(result.metadata.action).toMatchObject({status:"shown",occluded:true});
});

test("fractional native projections are not reported as clipped by floating-point subtraction", async () => {
  const {imageGuides} = await import("../src/image-guides.ts");
  const region={x:124.48101265822785,y:104.22784810126582,width:8+1/3.16,height:8+1/3.16};
  const result=imageGuides(500,320,{options:{grid:false,action:true},action:{region}},[]);
  expect(result.metadata.action).toMatchObject({status:"shown",clipped:false});
});

test("a native title bar does not silently remove the entire X axis", async () => {
  const {imageGuides} = await import("../src/image-guides.ts");
  const result=imageGuides(500,320,{options:{grid:true,action:false}},[{x:0,y:0,width:500,height:25}]);
  expect(result.metadata.grid.labels).toContainEqual({text:"100",region:{x:103,y:302,width:27,height:16}});
  expect(result.metadata.grid.omitted_labels).toBe(0);
});

test("guide controls are strict, immutable and independent of native image sizing", () => {
  const store = new CuaImageSettings(); const original = store.settings();
  expect(store.setGuides({ grid: true, action: true })).toMatchObject({ guides: { grid: true, action: true }, version: 1 });
  expect(original.guides).toBeUndefined();
  const frozen = store.settings(); frozen.guides!.grid = false;
  expect(store.settings().guides!.grid).toBe(true);
  for (const input of [{ grid: "yes" }, { grid: true, mode: "yolo" }, { grid: true, region: true, action: true }, {}]) expect(() => store.setGuides(input)).toThrow();
  store.update({ kernel: "lanczos3", maxLongEdge: 800, scale: 1 });
  expect(store.settings()).toMatchObject({ guides: { grid: true, action: true }, maxLongEdge: 800 });
});
