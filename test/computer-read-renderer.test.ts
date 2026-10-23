import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { computerReadRenderer } from "../src/computer-read-renderer.ts";

const theme = { fg: (_: unknown, text: string) => text, bold: (text: string) => text };
const context = { args: { path: "computer:observation/current" }, cwd: "/", isError: false };
const render = (text: string, computer: unknown, width = 79) =>
  computerReadRenderer({ content: [{ type: "text", text }, { type: "text", text: "PRIVATE_AGENT_GUIDE" }],
    details: { source: context.args.path, resolvedBy: "computer", computer } } as never,
    { expanded: false, isPartial: false }, theme as never, context as never).render(width);

test("a Playwright screenshot shows a short sanitized provenance line above Pi's enlarged image", () => {
  const lines = render("Computer observed (yolo)\nImage: 36x36 image/png", {
    status: "observed", state: { title: "Form\u001b[2J", url: "http://127.0.0.1:8123/form" },
    agent_image: { route: "playwright_screenshot", kind: "crop", output: { width: 36, height: 36 } },
  });
  expect(lines).toHaveLength(2);
  const output = lines.join("\n");
  for (const value of ["Playwright crop screenshot", "36x36 PNG", "page pixels, input=none", "http://127.0.0.1:8123/form"]) expect(output).toContain(value);
  expect(output).not.toContain("\u001b");
  expect(output).not.toContain("PRIVATE_");
  expect(lines.every(line => visibleWidth(line) <= 79)).toBe(true);
});
test("ordinary computer reads retain the standard source renderer", () => {
  const lines = render("ordinary window overview", { status: "observed", agent_image: { route: "cua_native" } });
  expect(lines.join("\n")).toContain("ordinary window overview");
  expect(lines.join("\n")).toMatch(/[╭┌]/);
});
