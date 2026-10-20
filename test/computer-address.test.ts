import { describe, expect, it } from "vitest";
import { parseComputerAddress } from "../src/computer-address.ts";
import { parseComputerViews } from "../src/computer-views.ts";

describe("computer resource addresses", () => {
  it("leaves other resource owners alone", () => {
    for (const source of ["notes.txt", "window:123", "display:", "linear://team/issue/1"])
      expect(parseComputerAddress(source)).toBeUndefined();
  });

  it("keeps native discovery and observation identities separate", () => {
    expect(parseComputerAddress("computer:windows")).toEqual({ kind: "windows", source: "computer:windows" });
    expect(parseComputerAddress("computer:window/window-1")).toEqual({ kind: "window", ref: "window-1", source: "computer:window/window-1" });
    expect(parseComputerAddress("computer:observation/snapshot-1?hint=1:a&delivery=foreground&delay_ms=0")).toEqual({
      kind: "observation", ref: "snapshot-1", source: "computer:observation/snapshot-1?hint=1:a&delivery=foreground&delay_ms=0",
      hint: "1:a", delivery: "foreground", delayMs: 0,
    });
  });

  it("rejects identity overrides, ambiguous parameters and broadening paths", () => {
    for (const source of [
      "computer:", "computer:window/", "computer:window/../other", "computer://window/123",
      "computer:observation/snapshot?window_ref=other", "computer:observation/snapshot?hint=e1&hint=e2",
      "computer:window/window-1?delivery=foreground", "computer:observation/snapshot?delivery=automatic",
      "computer:observation/snapshot?delay_ms=1.5", "computer:observation/snapshot?delay_ms=201",
      "computer:observation/snapshot#e4", "computer:observation/%2Fother", "computer:observation/%00",
    ]) expect(() => parseComputerAddress(source), source).toThrow();
  });
});

describe("computer Read views", () => {
  it("keeps UI lines, pixels and native detail distinct", () => {
    expect(parseComputerViews()).toEqual({ kind: "overview", capture: {} });
    expect(parseComputerViews(["ui"])).toEqual({ kind: "overview", capture: { granularity: "ui" } });
    expect(parseComputerViews(["image", "backend:default"])).toEqual({ kind: "overview", capture: { granularity: "image", backend: "default" } });
    expect(parseComputerViews(["region:10,20,100,80"])).toEqual({ kind: "region", region: { x: 10, y: 20, width: 100, height: 80 } });
  });

  it("preserves bounded native capture and readonly frame selection options", () => {
    expect(parseComputerViews(['sequence:{"duration_ms":200,"fps":4,"max_frames":2}'])).toEqual({
      kind: "sequence", options: { duration_ms: 200, fps: 4, max_frames: 2 },
    });
    expect(parseComputerViews(["frames:endpoints"])).toEqual({ kind: "frames", selection: "endpoints" });
    expect(parseComputerViews(['frames:{"indexes":[0,2]}'])).toEqual({ kind: "frames", selection: { indexes: [0, 2] } });
    expect(parseComputerViews(['capture:{"max_elements":10,"hints":true}'])).toEqual({ kind: "overview", capture: { max_elements: 10, hints: true } });
    expect(parseComputerViews(["element:inspect,1:a"])).toEqual({ kind: "element", operation: "inspect", hint: "1:a" });
    for (const views of [['sequence:{"duration_ms":60001}'], ['sequence:{"duration_ms":200,"window_ref":"other"}'],
      ['frames:{"from":2,"to":1}'], ['frames:{"indexes":[0,0]}'], ["frames:last", "ui"], ['capture:{"backend":"unknown"}']])
      expect(() => parseComputerViews(views)).toThrow();
  });
  it("refuses ambiguous or invalid views rather than silently acquiring wider pixels", () => {
    for (const views of [["image", "ui"], ["region:0,0,0,10"], ["region:-1,0,10,10"],
      ["region:0,0,10,10", "full"], ["backend:unknown"], ["region:0,0,Infinity,10"], ["anchors"]])
      expect(() => parseComputerViews(views), views.join(",")).toThrow();
  });
});
