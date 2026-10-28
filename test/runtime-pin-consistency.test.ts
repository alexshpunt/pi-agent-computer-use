import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { WINDOW_MANAGEMENT_RUNTIME } from "../src/driver.ts";

// A machine configured with a trusted command is checked against WINDOW_MANAGEMENT_RUNTIME; the bundled runtime against the pins file.
// If the two disagree, one of them refuses the driver the other one ships.
test("the fork runtime the driver accepts is the runtime the package pins", () => {
  const pins = JSON.parse(readFileSync(new URL("../src/runtime-pins.json", import.meta.url), "utf8")) as { source: string; version: string; files: Record<string, string> };
  expect(WINDOW_MANAGEMENT_RUNTIME).toEqual({ source: pins.source, version: pins.version, sha256: pins.files["cua-driver.exe"] });
});
