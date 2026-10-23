import { expect, test } from "vitest";
import { observationSource } from "../src/observation-source.ts";

const identity = { session_id: "agent", window_ref: "window", pid: 42, window_id: 91 };
const record = { desktop_id: "00112233-4455-6677-8899-aabbccddeeff", on_current_desktop: false,
  desktop_id_error: null, on_current_desktop_error: null, sampled_at_unix_ms: 42 };
const source = (virtual_desktop?: unknown) => observationSource("window", { virtual_desktop }, identity);

test("native desktop membership is sampled evidence, not part of window lifetime or input authority", () => {
  const result = source(record);
  expect(result.membership.virtual_desktop_id).toBe(record.desktop_id);
  expect(result.virtual_desktop).toEqual({ status: "sampled", ...record });
  expect(result.identity).toEqual(identity);
  expect(result.capabilities.input).toBe("window_observation");
});

test("one failed native membership query does not erase the other result", () => {
  const partial = { ...record, desktop_id: null, desktop_id_error: { code: "desktop_id_query_failed", hresult: -2147024891 } };
  expect(source(partial).virtual_desktop).toEqual({ status: "sampled", ...partial });
  const currentUnknown = { ...record, on_current_desktop: null,
    on_current_desktop_error: { code: "current_desktop_query_failed", hresult: null } };
  expect(source(currentUnknown).membership.virtual_desktop_id).toBe(record.desktop_id);
  expect(source(currentUnknown).virtual_desktop).toEqual({ status: "sampled", ...currentUnknown });
});

test("missing, malformed and zero desktop records never become current-desktop guesses", () => {
  expect(source().virtual_desktop).toEqual({ status: "unknown", reason: "not_reported" });
  for (const invalid of [null, {}, { ...record, desktop_id: "00000000-0000-0000-0000-000000000000" },
    { ...record, desktop_id: "primary" }, { ...record, on_current_desktop: null },
    { ...record, desktop_id_error: { code: "desktop_id_query_failed", hresult: null } },
    { ...record, sampled_at_unix_ms: -1 }, { ...record, on_current_desktop_error: { code: "invented", hresult: 0 } }]) {
    expect(source(invalid).membership.virtual_desktop_id).toBeNull();
    expect(source(invalid).virtual_desktop).toEqual({ status: "unknown", reason: "invalid_native_metadata" });
  }
});
