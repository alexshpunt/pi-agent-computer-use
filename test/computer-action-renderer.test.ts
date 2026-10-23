import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { computerActionRenderer } from "../src/computer-action-renderer.ts";

function render(summary: string, width = 80, guide = "") {
  const renderer = computerActionRenderer("insert");
  return renderer.renderResult!({ content: [{ type: "text", text: summary }, { type: "text", text: guide }], details: {
    metadata: { semanticAction: { kind: "computer-action", receipt: "PRIVATE_NATIVE_DIAGNOSTIC", error: { message: "PRIVATE_NATIVE_ERROR" } } },
  } } as never, { expanded: false, isPartial: false }, {} as never, {} as never).render(width);
}

test("computer renderers select only computer calls and semantic computer results", () => {
  for (const tool of ["write", "insert"] as const) {
    const renderer = computerActionRenderer(tool);
    expect(renderer.matches?.({ path: "computer:observation/owned" }, "call")).toBe(true);
    expect(renderer.matches?.({ path: "notes.txt" }, "call")).toBe(false);
    expect(renderer.matches?.({ path: ["computer:session"] }, "call")).toBe(false);
    expect(renderer.matches?.({ details: { metadata: { semanticAction: { kind: "computer-action" } } } }, "result")).toBe(true);
    for (const result of [undefined, { details: {} }, { details: { metadata: { semanticAction: { kind: "file-action" } } } }])
      expect(renderer.matches?.(result, "result")).toBe(false);
  }
});

test.each([
  "Computer refused\nDOM action: refused; trusted=false; atomic=false; effects=unverified\nAttempted steps: []; acknowledged: []\nIn flight: none; reason=dom_action_trusted_route_unavailable; cleanup=not_started",
  'Computer unknown\nDOM action: refused; effects=unverified\nAttempted steps: ["click","dblclick"]; acknowledged: ["click"]\nIn flight: dblclick; progress=unknown; cleanup=unconfirmed',
  'Computer delivered\nDOM action: dispatched; effects=unverified\nAttempted steps: ["click"]; acknowledged: ["click"]\nIn flight: none; cleanup=confirmed',
])("keeps the sanitized receipt, not private metadata, even when collapsed", summary => {
  const rendered = render(summary, 180).join("\n");
  for (const line of summary.split("\n")) expect(rendered).toContain(line);
  expect(rendered).not.toContain("PRIVATE_NATIVE");
  expect(rendered).not.toContain("edit failed");
});

test("wraps wide receipt text and never emits app-provided terminal controls", () => {
  const rendered = render("Computer refused\nDOM refusal: 测试 e\u0301 \u001b[2J unsafe", 18);
  expect(rendered.every(line => visibleWidth(line) <= 18)).toBe(true);
  expect(rendered.join("\n")).not.toContain("\u001b");
  expect(rendered.join("\n")).toContain("测试");
});

test("keeps model-only result envelopes and attached guides out of the terminal receipt", () => {
  const rendered = render('<system-result note="Internal reference"><uuid>PRIVATE_REFERENCE</uuid></system-result>\nComputer refused', 80, "PRIVATE_AGENT_GUIDE").join("\n");
  expect(rendered).toContain("Computer refused");
  expect(rendered).not.toContain("PRIVATE_");
  expect(rendered).not.toContain("system-result");
});
test("computer call headings omit literal input and native data", () => {
  const renderer = computerActionRenderer("write");
  const lines = renderer.renderCall!({ path: "computer:observation/owned", content: "PRIVATE_TYPED_TEXT" }, {} as never, {} as never).render(100);
  expect(lines.join("\n")).toContain("write computer:observation/owned");
  expect(lines.join("\n")).not.toContain("PRIVATE_TYPED_TEXT");
});
