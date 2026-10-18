import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { computerReadRenderer } from "../src/computer-read-renderer.ts";

const summary = ["Computer observed (yolo)", "Window: computer:window/w-d25eed74-8990-4c7b-af38-a94a05093400", "Observation: computer:observation/7e306cfb-9c61-4aaf-b4b4-2487ae3b9ec2",
  "Image: 39x38 image/png; cua_dom_crop; detail_image_pixels", "Source: now; input=none; paint freshness=unverified",
  "DOM native highlight: 7:a; atomic=false; input=none; paint=unverified", "Physical region: x821 y671 39x38; screen_physical_pixels",
  "WGC frame: x70 y61 1330x949; original pixels, scale=1, padding=0", "Raster scope: Chrome/155; DPR=1.5; native receipt=candidate_not_raster_qualified",
  "Qualification is separate; no input or nested-detail authority."].join("\n");
const theme = { fg: (_: unknown, text: string) => text, bold: (text: string) => text };
const context = { args: { path: "computer:observation/current" }, cwd: "/", isError: false };
const render = (text = summary, computer: unknown = { dom_native_detail: { operation: "highlight" } }, width = 79) =>
  computerReadRenderer({ content: [{ type: "text", text }, { type: "text", text: "PRIVATE_AGENT_GUIDE" }],
    details: { source: context.args.path, resolvedBy: "computer", computer: { ...computer as object, private: "PRIVATE_NATIVE" } } } as never,
    { expanded: false, isPartial: false }, theme as never, context as never).render(width);

test("native detail keeps its full sanitized receipt even when the tool card is collapsed", () => {
  const lines = render();
  const output = lines.join("\n");
  for (const value of ["atomic=false", "WGC frame:", "DPR=1.5", "candidate_not_raster_qualified", "no input or nested-detail authority"])
    expect(output).toContain(value);
  expect(output).not.toContain("more rows");
  expect(output).not.toContain("PRIVATE_");
  expect(lines.every(line => visibleWidth(line) <= 79)).toBe(true);
});
test("native-detail refusal phases stay readable without exposing private metadata or terminal controls", () => {
  const output = render("Computer refused\nNative DOM detail refused during final_geometry. Pixels withheld.\u001b[2J", {
    dom_native_detail_refusal: { phase: "final_geometry", pixels_withheld: true },
  }, 50).join("\n");
  expect(output).toContain("final_geometry"); expect(output).toContain("Pixels withheld");
  expect(output).not.toContain("PRIVATE_"); expect(output).not.toContain("\u001b");
});
test("a real native-detail receipt keeps all essential limits in four rows above Pi's enlarged image", () => {
  const detail = { operation: "crop", hint: "6:a", atomic: false, input_authority: false, paint_freshness: "unverified",
    physical_enclosing_rect: { x: 191, y: 416, width: 36, height: 36 }, frame_bounds: { x: 70, y: 61, width: 1330, height: 949 },
    crop: { width: 36, height: 36, scale: 1, padding: 0 }, native_qualification: "candidate_not_raster_qualified",
    qualification: { browser: { product: "Chrome/155.0.8059.40", revision: "PRIVATE_REVISION" }, dpr: 1.5 } };
  const lines = render(summary, { dom_native_detail: detail });
  expect(lines).toHaveLength(4);
  const output = lines.join("\n");
  for (const value of ["crop", "36x36 PNG", "6:a", "atomic=false", "191,416", "70,61", "1330x949", "scale=1", "pad=0", "DPR=1.5", "candidate_not_raster_qualified", "input=none", "paint=unverified", "no nested detail"])
    expect(output).toContain(value);
  expect(lines.every(line => visibleWidth(line) <= 79)).toBe(true);
  expect(output).not.toContain("PRIVATE_");
});
test("ordinary computer reads retain the standard source renderer", () => {
  const lines = render("ordinary window overview", { status: "observed" });
  expect(lines.join("\n")).toContain("ordinary window overview");
  expect(lines.join("\n")).toMatch(/[╭┌]/);
});
