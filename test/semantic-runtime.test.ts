import { expect, test } from "vitest";
import { McpDriver } from "../src/driver.ts";

test("older profiles refuse semantic dispatch before starting a native peer", async () => {
  for (const runtime of [undefined, "windows-shell-desktops", "windows-single-png"] as const) {
    const backend = new McpDriver({ command: process.execPath, runtime });
    try {
      expect(backend.semanticActions).toBe(false);
      expect(await backend.call("semantic_action", { pid: 42, window_id: 91, element_token: "current", operation: "invoke" })).toMatchObject({
        isError: true, structuredContent: { status: "refused", code: "semantic_action_unavailable", attempted: false, fallback: false },
      });
    } finally { await backend.close(); }
  }
});
