import { expect, test } from "vitest";
import { localRunner } from "../src/runner.ts";
import { prepareWindowsTsx } from "../src/windows-tsx.ts";

test("cancelling before loader preparation does not start an installer", async () => {
  let started = false;
  const runner = { ...localRunner(), run: async () => { started = true; return "file:///C:/loader.mjs"; } };
  await expect(prepareWindowsTsx(runner, AbortSignal.abort())).rejects.toThrow();
  expect(started).toBe(false);
});
