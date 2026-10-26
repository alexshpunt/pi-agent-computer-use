import { expect, test, vi } from "vitest";
import { checkedName, MachineHost } from "../src/machine-host.ts";
import { parseComputerViews } from "../src/computer-views.ts";

test.each(["../secret.txt", "a/b.png", "C:\\Users\\x.png", "..", ".hidden", "", "x".repeat(129)])("file name %j cannot leave the session folder", name => {
  expect(() => checkedName(name)).toThrow(/plain file name/);
});

test("plain names are kept as given", () => {
  expect(checkedName("Drawing (2) final-v1.png")).toBe("Drawing (2) final-v1.png");
});

test("a host whose folder was never used removes nothing on close", async () => {
  const run = vi.fn();
  await new MachineHost({ run, spawn: vi.fn() }, { set: vi.fn(), restore: vi.fn() }).removeFiles();
  expect(run).not.toHaveBeenCalled();
});

test("ocr combines only with pixel views", () => {
  expect(parseComputerViews(["ocr"])).toMatchObject({ kind: "overview", ocr: true });
  // The text of one part of a window comes from a viewport Read with ocr.
  expect(() => parseComputerViews(["region:1,2,30,40", "ocr"])).toThrow(/viewport/);
  expect(parseComputerViews(['capture:{"granularity":"image","maxLongEdge":3840}', "ocr"])).toMatchObject({ kind: "overview", ocr: true });
  expect(() => parseComputerViews(["state", "ocr"])).toThrow();
  expect(() => parseComputerViews(['capture:{"granularity":"ui"}', "ocr"])).toThrow(/pixels/);
});
