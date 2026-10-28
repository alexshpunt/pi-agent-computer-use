import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { computerActionRenderer, computerReadRenderer, typedRenderers } from "../src/computer-renderers.ts";

// Plain theme: styling is not the contract, the words and the layout are.
const theme = { fg: (_: unknown, text: string) => text, bold: (text: string) => text, underline: (text: string) => text };
const describe = (source: string) => source.includes("w1") ? { machine: "zinpc", title: "Untitled - Notepad" } : undefined;
const ctx = (isError = false) => ({ isError, args: {}, lastComponent: undefined });
const action = (data: Record<string, unknown>, isError = false) => ({ content: [{ type: "text", text: "PRIVATE_AGENT_TEXT" }], isError,
  details: { metadata: { semanticAction: { kind: "computer-action", ...data } } } });
const draw = (component: { render(width: number): string[] }, width = 80) => component.render(width);
const result = (tool: string, data: Record<string, unknown>, options: { expanded?: boolean; isPartial?: boolean } = {}, width = 80, isError = false) =>
  draw(typedRenderers(tool, describe).renderResult(action(data, isError) as never, { expanded: false, isPartial: false, ...options }, theme as never, ctx(isError) as never), width);

test("a delivered action says where it ran and what changed in the UI, not the receipt text", () => {
  const lines = result("computer_click", { ok: true, effect: "applied", status: "delivered", machine: "zinpc", script: { window: "computer:zinpc/w1ab" },
    successor: { diff: { kind: "ui", changed: ["1:a Edit value=1"], added: [], removed: [], counts: { changed: 1, added: 0, removed: 0 }, waited_ms: 180 } } });
  expect(lines[0]).toBe("✓ delivered · zinpc");
  expect(lines.join("\n")).toMatch(/1 changed.*180 ms/);
  expect(lines.join("\n")).toContain("~ 1:a Edit value=1");
  expect(lines.join("\n")).not.toContain("PRIVATE_AGENT_TEXT");
});

test("an action that changed nothing says so in a note", () => {
  const lines = result("computer_click", { ok: true, status: "delivered", machine: "zinpc",
    successor: { diff: { kind: "ui", changed: [], added: [], removed: [], counts: { changed: 0, added: 0, removed: 0 }, waited_ms: 300 } } });
  // The fixture's wait time is the one fact worth checking; the sentence around it is wording.
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain("300 ms");
});

test("unknown warns that the action may have happened; refused and failed give their one-line reason", () => {
  const unknown = result("computer_type", { ok: false, effect: "unknown", status: "unknown", machine: "zinpc", script: { reason: "Driver returned unknown for type_text. Observe again." } }, {}, 200);
  expect(unknown[0]).toBe("? unknown · zinpc");
  // The reason from the receipt, then one caution line that the action may have happened.
  expect(unknown).toHaveLength(3);
  expect(unknown[1]).toContain("Driver returned unknown for type_text");
  const refused = result("computer_click", { ok: false, effect: "not-applied", status: "refused", error: { message: "4:a is not a ref of this window's latest Read." } });
  expect(refused[0]).toBe("✗ refused");
  expect(refused[1]).toContain("4:a is not a ref");
  const failed = draw(typedRenderers("computer_click", describe).renderResult({ content: [{ type: "text", text: 'Validation failed for tool "computer_click":\n  - x: must be number' }], isError: true } as never,
    { expanded: false, isPartial: false }, theme as never, ctx(true) as never), 100);
  expect(failed.join("\n")).toContain("✗ failed");
  expect(failed.join("\n")).toContain('Validation failed for tool "computer_click": x: must be number');
});

test("a resize that Windows settled within the allowed difference shows the measured size", () => {
  const lines = result("computer_window", { ok: true, status: "delivered", machine: "zinpc", state: { operation: "resize", mutation_attempted: true, postcondition_confirmed: true,
    requested_bounds: { width: 600, height: 450 }, observed: { bounds: { width: 601, height: 450 } } } });
  expect(lines[0]).toBe("✓ delivered · zinpc · resize · 601×450");
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain("601×450");
  expect(lines[1]).toContain("600×450");
});

test("while a call runs the card shows only the running state", () => {
  expect(result("computer_click", {}, { isPartial: true })).toEqual(["● running"]);
});

test("headings name the window by title, show literal input only by length, and drop options before clipping the target", () => {
  const heading = (args: Record<string, unknown>, width = 100) => draw(typedRenderers("computer_type", describe).renderCall(args, theme as never, { ...ctx(), expanded: false } as never), width);
  expect(heading({ window: "computer:zinpc/w1ab", target: "2:a", text: "PRIVATE_TYPED_TEXT", submit: true })[0]).toBe("computer_type “Untitled - Notepad” · 2:a · 18 chars · + Enter");
  const narrow = heading({ window: "computer:zinpc/w1ab", target: "2:a", text: "x", submit: true }, 40)[0];
  expect(visibleWidth(narrow)).toBeLessThanOrEqual(40);
  expect(narrow).toContain("computer_type “Untitled - Notepad”");
  const expanded = draw(typedRenderers("computer_type", describe).renderCall({ window: "computer:zinpc/w1ab", text: "PRIVATE_TYPED_TEXT", delay_ms: 0 }, theme as never, { ...ctx(), expanded: true } as never), 100).join("\n");
  expect(expanded).toContain("window=computer:zinpc/w1ab");
  expect(expanded).toContain("delay_ms=0");
  expect(expanded).not.toContain("PRIVATE_TYPED_TEXT");
});

test("app text is data: control sequences never reach the terminal and every line fits the width", () => {
  const lines = result("computer_click", { ok: false, effect: "not-applied", status: "refused", error: { message: "bad \u001b[2J target \u0007 测试 e\u0301 " + "long ".repeat(60) } }, {}, 24);
  expect(lines.join("\n")).not.toMatch(/[\u0000-\u0008\u001b]/);
  expect(lines.every(line => visibleWidth(line) <= 24)).toBe(true);
  expect(lines.join("\n")).toContain("测试");
});

test("a Read shows the listing or UI structure as rows, bounded, with the rest behind expand", () => {
  const elements = Array.from({ length: 9 }, (_, i) => ({ hint: `1:${"abcdefghi"[i]}`, role: "Button", name: `Button ${i}`, value: "PRIVATE_FIELD_VALUE", enabled: true }));
  const read = (expanded: boolean) => draw(computerReadRenderer(describe)({ content: [{ type: "text", text: "PRIVATE_AGENT_TEXT" }], details: { source: "computer:window/x", resolvedBy: "computer",
    computer: { status: "observed", machine: "zinpc", window_ref: "w1", agent_image: { output: { width: 500, height: 350 } }, ui: { collected: 9, truncated: false, elements } } } } as never,
    { expanded, isPartial: false }, theme as never, ctx() as never), 100);
  const compact = read(false);
  expect(compact[0]).toContain("✓ observed · zinpc");
  expect(compact[0]).toContain("image 500×350 · UI 9 elements");
  expect(compact).toHaveLength(1 + 6 + 1);
  expect(compact.at(-1)).toContain("3");
  expect(read(true).filter(line => line.includes("Button "))).toHaveLength(9);
  expect(compact.concat(read(true)).join("\n")).not.toMatch(/PRIVATE_/);
});

test("write, insert and delete renderers select only computer addresses and semantic computer results", () => {
  for (const tool of ["write", "insert", "delete"] as const) {
    const renderer = computerActionRenderer(tool, describe);
    expect(renderer.matches({ path: "computer:observation/owned" }, "call")).toBe(true);
    expect(renderer.matches({ path: "notes.txt" }, "call")).toBe(false);
    expect(renderer.matches({ path: ["computer:session"] }, "call")).toBe(false);
    expect(renderer.matches({ details: { metadata: { semanticAction: { kind: "computer-action" } } } }, "result")).toBe(true);
    for (const value of [undefined, { details: {} }, { details: { metadata: { semanticAction: { kind: "file-action" } } } }]) expect(renderer.matches(value, "result")).toBe(false);
  }
  const lines = draw(computerActionRenderer("write", describe).renderCall({ path: "computer:zinpc/o1ab", content: "PRIVATE_TYPED_TEXT" }, theme as never, { ...ctx(), expanded: false } as never));
  expect(lines[0]).toBe("write observation o1ab · zinpc");
  expect(lines.join("\n")).not.toContain("PRIVATE_TYPED_TEXT");
});
