import { expect, test } from "vitest";
import { preserveToolOmission, registerToolOmission } from "../src/responses-tools.ts";

const schema = { type: "object", properties: { at: { type: "string" }, app: { type: "string" }, path: { type: "string" } }, required: ["at"], additionalProperties: false };
const fn = (name: string, extra: Record<string, unknown> = {}) => ({ type: "function", name, description: `${name} tool`, parameters: structuredClone(schema), ...extra });
const ours = new Set(["computer_open", "computer_click"]);
const strictOf = (tools: unknown) => (tools as { name: string; strict?: unknown }[]).map(tool => [tool.name, tool.strict]);

test("Computer Use tools get strict:false when Pi sends them in payload.tools, and nothing else about them changes", () => {
  const payload = { model: "m", tools: [fn("computer_open"), fn("read"), fn("computer_click")] };
  const before = structuredClone(payload);
  const next = preserveToolOmission(payload, ours) as typeof payload;
  expect(strictOf(next.tools)).toEqual([["computer_open", false], ["read", undefined], ["computer_click", false]]);
  for (const [index, tool] of next.tools.entries()) expect({ ...tool, strict: undefined }).toEqual({ ...payload.tools[index], strict: undefined });
  expect(payload).toEqual(before);
});

test("the same holds when Pi sends them as additional_tools items of the input", () => {
  const payload = { model: "m", input: [{ role: "developer", content: "rules" }, { type: "additional_tools", role: "developer", tools: [fn("computer_open"), fn("bash")] }, { role: "user", content: "hi" }] };
  const before = structuredClone(payload);
  const next = preserveToolOmission(payload, ours) as typeof payload;
  expect(strictOf((next.input[1] as { tools: unknown }).tools)).toEqual([["computer_open", false], ["bash", undefined]]);
  expect(next.input[0]).toBe(payload.input[0]);
  expect(next.input[2]).toBe(payload.input[2]);
  expect(payload).toEqual(before);
});

test("explicit strictness, other tool kinds and tools of other extensions are left alone, and an untouched payload is returned as is", () => {
  const payload = { tools: [fn("computer_open", { strict: true }), fn("computer_click", { strict: false }), { type: "custom", name: "computer_open" }, { type: "web_search" }, fn("read")],
    input: [{ type: "additional_tools", tools: [fn("computer_open", { strict: true })] }] };
  expect(preserveToolOmission(payload, ours)).toBe(payload);
  expect(preserveToolOmission(payload, new Set())).toBe(payload);
  for (const odd of [undefined, null, "text", 3, [], { tools: "no", input: "no" }, { input: [null, "x", { type: "additional_tools" }] }]) expect(preserveToolOmission(odd, ours)).toBe(odd);
});

/** A stand-in for Pi: it keeps the handler the extension registers and reports the tools it knows. */
function piWith(tools: { name: string; namespace?: string }[]) {
  let handler: ((event: { payload: unknown }, context: { model?: { api: string } }) => unknown) | undefined;
  const pi = { on: (name: string, listener: typeof handler) => { if (name === "before_provider_request") handler = listener; },
    getAllTools: () => tools.map(tool => ({ name: tool.name, ...(tool.namespace ? { namespace: { name: tool.namespace, description: "" } } : {}) })) };
  registerToolOmission(pi as never, "computer");
  return (api: string | undefined, payload: unknown) => handler!({ payload }, api ? { model: { api } } : {});
}

test("only the Responses route is rewritten, and only for tools of the computer namespace", () => {
  const request = piWith([{ name: "computer_open", namespace: "computer" }, { name: "computer_click", namespace: "computer" }, { name: "read", namespace: "ide_read" }, { name: "bash" }]);
  const payload = { tools: [fn("computer_open"), fn("read"), fn("bash")] };
  expect(strictOf((request("openai-responses", payload) as typeof payload).tools)).toEqual([["computer_open", false], ["read", undefined], ["bash", undefined]]);
  for (const api of ["openai-completions", "anthropic-messages", "google-generative-ai", "openai-codex-responses", undefined]) expect(request(api, payload), String(api)).toBeUndefined();
});
