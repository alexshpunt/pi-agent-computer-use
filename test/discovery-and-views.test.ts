import { expect, test, vi } from "vitest";
import { parseComputerViews } from "../src/computer-views.ts";
import { ComputerSession, textMatcher, type Driver, type DriverResult } from "../src/session.ts";

test("discovery queries match substrings or explicit regular expressions", () => {
  expect(textMatcher("paint")("Untitled - Paint")).toBe(true);
  expect(textMatcher("regex:.")("anything")).toBe(true);
  expect(textMatcher("regex:^untitled.*paint$")("Untitled - Paint")).toBe(true);
  expect(textMatcher("regex:^paint")("Untitled - Paint")).toBe(false);
  expect(textMatcher("regex:.")("")).toBe(false);
  expect(() => textMatcher("regex:(")).toThrow(/Invalid regular expression/);
});

test("Read views accept granularity and backend in either form and name conflicts", () => {
  expect(parseComputerViews(['capture:{"granularity":"image","maxLongEdge":320}', "backend:default"]))
    .toEqual({ kind: "overview", capture: { granularity: "image", maxLongEdge: 320, backend: "default" } });
  expect(parseComputerViews(["image", 'capture:{"maxLongEdge":320}'])).toEqual({ kind: "overview", capture: { granularity: "image", maxLongEdge: 320 } });
  expect(() => parseComputerViews(["backend:default", 'capture:{"maxLongEdge":320}', "ui"])).toThrow(/ui view collects no pixels, so backend:default/);
  expect(() => parseComputerViews(["image", 'capture:{"granularity":"ui"}'])).toThrow(/granularity is given twice/);
  expect(() => parseComputerViews(["image", "full"])).toThrow(/got image and full/);
  expect(() => parseComputerViews(['capture:{"size":1}'])).toThrow(/unsupported options: size/);
});

function appSession(apps: { name: string; launch_path: string }[]) {
  const call = vi.fn<Driver["call"]>(async (name): Promise<DriverResult> => {
    if (name === "list_apps") return { content: [], structuredContent: { apps } };
    if (name === "list_windows") return { content: [], structuredContent: { windows: [] } };
    if (name === "launch_app") throw new Error("launch stopped by the fixture");
    throw new Error(`Unexpected native call ${name}`);
  });
  return { call, session: new ComputerSession({ call, identity: vi.fn(async () => "life"), close: vi.fn(async () => {}) }) };
}

test("apps open by executable name only when no installed name matches, and misses suggest close names", async () => {
  const { call, session } = appSession([
    { name: "Notepad", launch_path: "shell:appsFolder\\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" },
    { name: "Paint", launch_path: "shell:appsFolder\\Microsoft.Paint_8wekyb3d8bbwe!App" },
    { name: "Calculator Pro", launch_path: "C:\\Tools\\calc2.exe" },
  ]);
  await session.open("calc2");
  expect(call).toHaveBeenCalledWith("launch_app", { launch_path: "C:\\Tools\\calc2.exe" }, undefined);
  const missed = await session.open("mspaint");
  expect(missed.details.status).toBe("refused");
  expect(missed.content[0]).toMatchObject({ text: expect.stringContaining("Did you mean: Paint?") });
  expect(call.mock.calls.filter(([name]) => name === "launch_app")).toHaveLength(1);
});
