import { expect, test } from "vitest";
import { parseComputerAddress } from "../src/computer-address.ts";
import { parseComputerViews } from "../src/computer-views.ts";

test("window-state addresses no longer exist: computer_window samples its own state", () => {
  for (const source of ["computer:window-state/state-1", "computer:window-state/state-1?hint=1:a"])
    expect(() => parseComputerAddress(source)).toThrow();
});

test("metadata-only state is an exclusive Read mode, never a capture or detail option", () => {
  expect(parseComputerViews(["state"])).toEqual({ kind: "state" });
  for (const views of [["state", "ui"], ["state", "image"], ["state", "capture:{\"maxLongEdge\":320}"],
    ["state", 'capture:{"maxLongEdge":500}'], ["state", "region:0,0,10,10"]])
    expect(() => parseComputerViews(views)).toThrow();
});
