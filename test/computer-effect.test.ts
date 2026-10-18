import { expect, test } from "vitest";
import { computerEffect } from "../src/provider.ts";
import type { ComputerResult } from "../src/session.ts";

function result(status: ComputerResult["details"]["status"], completed = 0): ComputerResult {
  return { content: [], isError: status === "refused" || status === "unknown",
    details: { status, mode: "yolo", state: { sequence: { completed } } } };
}

test("a later refusal never erases the already-delivered sequence prefix", () => {
  expect(computerEffect(result("refused", 1))).toBe("unknown");
  expect(computerEffect(result("refused", 0))).toBe("not-applied");
  expect(computerEffect(result("unknown", 2))).toBe("unknown");
  expect(computerEffect(result("delivered", 2))).toBe("applied");
});
