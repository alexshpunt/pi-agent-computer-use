import assert from "node:assert/strict";
import { openForkArtifact } from "./check-cua-fork-artifact.mjs";

// Harmless qualification: exact bytes and advertised API only. No window, capture or input call.
const artifact = await openForkArtifact(process.argv[2] ?? "", process.argv[3]);
try {
  const { tools } = await artifact.client.listTools(undefined, { timeout: 15000 });
  const tool = tools.find(tool => tool.name === "semantic_action");
  assert.ok(tool, "Strict semantic API is missing.");
  const input = tool.inputSchema;
  assert.equal(input.additionalProperties, false);
  assert.deepEqual([...input.required].sort(), ["element_token", "operation", "pid", "window_id"]);
  assert.deepEqual(Object.keys(input.properties).sort(), ["element_token", "operation", "pid", "session", "value", "window_id"]);
  assert.deepEqual(input.properties.operation.enum, ["invoke", "select", "set_value"]);
  assert.equal(input.properties.element_token.pattern, "^s[0-9a-f]{8}:[0-9]+$");
  for (const key of ["value", "session"]) assert.equal(input.properties[key].type, "string");
  for (const key of ["pid", "window_id"]) assert.equal(input.properties[key].type, "integer");
  const success = tool.outputSchema?.anyOf?.find(schema => schema.properties?.operation);
  assert.ok(success, "Typed semantic completion schema is missing.");
  for (const key of ["operation", "pattern", "route", "effect", "delivery"]) assert.ok(success.required.includes(key));
  assert.deepEqual(success.properties.route.enum, ["accessibility"]);
  assert.deepEqual(success.properties.effect.enum, ["unverifiable"]);
  assert.deepEqual(success.properties.delivery.properties.mode.enum, ["background"]);
  assert.deepEqual(success.properties.pattern.enum, ["invoke", "selection_item", "value", "range_value"]);
  assert.ok(artifact.report.has_drag_via && artifact.report.has_key_hold && artifact.report.has_capture_bound_drag,
    "Earlier qualified pointer/key capabilities were lost.");
  for (const name of ["list_displays", "get_display_state"]) assert.ok(tools.some(tool => tool.name === name));
  console.log(JSON.stringify({ success: true, ...artifact.report, semantic_api: "strict_UIA", input_calls: 0, capture_calls: 0,
    output_schema_open_extensions: success.additionalProperties !== false,
    limits: "API and artifact checks only; application state, focus and desktop membership need live verification." }));
} finally { await artifact.close(); }
