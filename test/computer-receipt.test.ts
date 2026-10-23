import { expect, test } from "vitest";
import { computerReceipt } from "../src/provider.ts";
import { ComputerRequestError } from "../src/computer-resources.ts";
import type { ComputerResult } from "../src/session.ts";

// Scripts branch on these fields without try/catch, so each outcome must keep its meaning.
const result = (details: Partial<ComputerResult["details"]>, text = "summary"): ComputerResult =>
  ({ content: [{ type: "text", text }], details: { mode: "yolo", status: "delivered", ...details } as ComputerResult["details"] });
const source = "computer:observation/a";

test("a request rejected before dispatch is refused at validation and applied nothing", () => {
  const receipt = computerReceipt(source, "click", { error: new ComputerRequestError("Observation reference expired."), inputConsumed: true });
  expect(receipt).toMatchObject({ outcome: "refused", effect: "not-applied", stage: "validation", input_consumed: true, observation: null });
});

test("an unexpected failure after validation stays unknown, never refused", () => {
  expect(computerReceipt(source, "click", { error: new Error("transport lost"), inputConsumed: true }))
    .toMatchObject({ outcome: "unknown", effect: "unknown", stage: "target" });
});

test("a refusal after an earlier sequence step was delivered keeps the effect unknown", () => {
  const refused = result({ status: "refused", state: { sequence: { completed: 1, steps: [{ index: 0, action: "click", status: "delivered" }, { index: 1, action: "type_text", status: "refused" }] } } });
  const receipt = computerReceipt(source, "sequence", { result: refused, inputConsumed: true, text: "t" });
  expect(receipt).toMatchObject({ outcome: "refused", effect: "unknown" });
  expect(receipt.steps).toEqual([{ index: 0, action: "click", status: "delivered" }, { index: 1, action: "type_text", status: "refused" }]);
});

test("a delivered browser action reports the new observation and page; delivery never verifies the application", () => {
  const delivered = result({ window_ref: "w-1", observation_id: "next", dom: { url: "http://x/", title: "T", snapshot: "", tabs: [], active: "t1", events: [], truncated: false } });
  expect(computerReceipt(source, "click", { result: delivered, inputConsumed: true, text: "t" })).toMatchObject({
    outcome: "delivered", effect: "applied", window: "computer:window/w-1", observation: "computer:observation/next",
    application_effect: "unverified", page: { url: "http://x/", tab: "t1", dialog: null },
  });
});
