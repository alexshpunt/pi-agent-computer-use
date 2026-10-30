import { StringEnum, Type, validateToolArguments } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { fillToolNames, IDE_TOOL_NAMES, STANDALONE_TOOL_NAMES } from "../src/tool-names.ts";

const schema = Type.Object({
  window: Type.String({ description: "Window address from {search}, {read} or a name." }),
  views: Type.Optional(Type.Array(Type.String(), { description: "Views of one {read}; {delete} releases it." })),
}, { additionalProperties: false });

test("tool names are filled per mode and the declared JSON keeps its shape", () => {
  for (const names of [IDE_TOOL_NAMES, STANDALONE_TOOL_NAMES]) {
    const filled = fillToolNames(schema, names);
    const expected = JSON.stringify(schema).replaceAll("{search}", names.search).replaceAll("{read}", names.read).replaceAll("{delete}", names.delete);
    expect(JSON.stringify(filled)).toBe(expected);
  }
  expect((fillToolNames(schema, STANDALONE_TOOL_NAMES).properties.window as { description?: string }).description).toBe("Window address from computer_search, computer_read or a name.");
});

test("a filled enum schema still accepts its values and rejects others", () => {
  const tool = { name: "t", description: "", parameters: fillToolNames(Type.Object({ mode: StringEnum(["wait", "check"] as const, { description: "{read}" }) }), IDE_TOOL_NAMES) };
  const call = (mode: string) => validateToolArguments(tool, { type: "toolCall", id: "1", name: "t", arguments: { mode } });
  expect(call("check")).toEqual({ mode: "check" });
  expect(() => call("bogus")).toThrow();
});
