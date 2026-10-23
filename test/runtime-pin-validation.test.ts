import { afterEach, expect, test, vi } from "vitest";

// Replace only the shipped pins file; every other read stays real.
let pinsText = "";
vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, readFile: vi.fn((file: Parameters<typeof original.readFile>[0], ...rest: unknown[]) =>
    String(file).endsWith("runtime-pins.json") ? Promise.resolve(pinsText)
      : (original.readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest)) };
});
const { readRuntimePins } = await import("../src/native-runtime.ts");

const hash = "0".repeat(64);
const valid = { format: 2, source: "a".repeat(40), version: "0.37.0", url: "https://example.invalid/release/",
  files: Object.fromEntries(["cua-driver.exe", "cua-cursor-theme.exe", "cua-driver-uia.exe", "LICENSE.md", "THIRD_PARTY_NOTICES.md"].map(name => [name, hash])) };
afterEach(() => { pinsText = ""; });

test("valid format-2 pins are accepted", async () => {
  pinsText = JSON.stringify(valid);
  await expect(readRuntimePins()).resolves.toEqual(valid);
});

test.each([
  ["an old format", { ...valid, format: 1 }],
  ["a short source", { ...valid, source: "abc" }],
  ["a plain HTTP URL", { ...valid, url: "http://example.invalid/release/" }],
  ["a URL without a trailing slash", { ...valid, url: "https://example.invalid/release" }],
  ["a missing companion", { ...valid, files: Object.fromEntries(Object.entries(valid.files).filter(([name]) => name !== "cua-driver-uia.exe")) }],
  ["an extra file", { ...valid, files: { ...valid.files, "extra.dll": hash } }],
  ["a malformed hash", { ...valid, files: { ...valid.files, "cua-driver.exe": "not-a-hash" } }],
])("pins with %s are refused before any download", async (_case, pins) => {
  pinsText = JSON.stringify(pins);
  await expect(readRuntimePins()).rejects.toThrow("native_runtime_pin_invalid");
});
