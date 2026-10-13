import { expect, test } from "vitest";
import { parseComputerAddress, computerSource } from "../src/computer-address.ts";
import { parseComputerViews } from "../src/computer-views.ts";

test("window-state references have no pointer, hint, delivery or literal Write targeting options", () => {
  const source = computerSource("window-state", "state-1");
  expect(parseComputerAddress(source)).toEqual({ kind: "window-state", ref: "state-1", source });
  for (const suffix of ["?hint=1:a", "?delivery=foreground", "?delay_ms=0", "?window_ref=other", "#1"])
    expect(() => parseComputerAddress(source + suffix)).toThrow();
});

test("metadata-only state is an exclusive Read mode, never a capture or detail option", () => {
  expect(parseComputerViews(["state"])).toEqual({ kind: "state" });
  for (const views of [["state", "ui"], ["state", "image"], ["state", "backend:wgc"],
    ["state", 'capture:{"maxLongEdge":500}'], ["state", "region:0,0,10,10"]])
    expect(() => parseComputerViews(views)).toThrow();
});
