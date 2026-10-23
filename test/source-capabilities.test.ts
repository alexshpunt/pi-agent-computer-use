import { expect, test } from "vitest";
import { observationSource, sourceIdentity } from "../src/observation-source.ts";
import { actionCapability } from "../src/action-capability.ts";

test("source identity does not guess Windows session, desktop or monitor from window position", () => {
  const identity = { session_id: "agent-one", window_ref: "window-one", pid: 42, window_id: 91 };
  const source = observationSource("window", { window_bounds: { x: -500, y: 0, width: 400, height: 300 }, app_name: "chrome.exe" }, identity);
  expect(source.membership).toEqual({ windows_session_id: null, virtual_desktop_id: null, monitor_id: null });
  expect(sourceIdentity(identity)).toMatchObject({ domain: "windows-host", identity, membership: source.membership });
  expect(sourceIdentity({ ...identity, session_id: "agent-two" }).identity.session_id).not.toBe(source.identity.session_id);
});

test("delivery capability describes only the attempted native action, not all input to that app", () => {
  const supported = actionCapability("click", "click", "background", "delivered", { delivery: { mode: "background" }, route: "accessibility" });
  expect(supported).toMatchObject({ scope: "attempted_action_only", background: "delivered", foreground: "unknown", actual_delivery: "background" });
  const foreground = actionCapability("key", "press_key", "foreground", "delivered", { delivery: { mode: "foreground" }, route: "global_input" });
  expect(foreground).toMatchObject({ background: "unknown", foreground: "delivered" });
  const refused = actionCapability("key", "press_key", "background", "refused", { code: "background_unavailable", event_kind: "keystroke", escalation: { recommended: "foreground" } });
  expect(refused).toMatchObject({ background: "unavailable", foreground: "suggested", actual_delivery: "unknown", event_kind: "keystroke" });
});

test("missing or uncertain native delivery never becomes a capability guarantee", () => {
  for (const native of [{}, { route: "accessibility" }, { delivery: { mode: "background" } }])
    expect(actionCapability("click", "click", "background", "unknown", native)).toMatchObject({ background: "unknown", foreground: "unknown" });
  expect(actionCapability("hold", "hold_keys", "background", "refused", { code: "key_hold_unavailable" })).toMatchObject({ unsupported: true, background: "unknown" });
});
