import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { McpDriver } from "../src/driver.ts";
import type { BundledRuntime } from "../src/native-runtime.ts";

test.each(["linux-x64", "darwin-x64", "darwin-arm64"] as const)("%s never starts a Windows identity peer or advertises Windows-only fork routes", async target => {
  const bundled: BundledRuntime = { target, root: "/missing-package", command: "/missing-package/runtime/cua-driver", source: "a".repeat(40), version: "0.34.0-dev.fixture", driverVersion: "0.34.0", files: {} };
  const backend = new McpDriver({ command: bundled.command, bundled });
  try {
    expect(backend.platform).toBe(target.startsWith("darwin") ? "macos" : "linux");
    expect(backend.windowLifetime).toBe(false);
    expect([backend.heldPaths, backend.heldKeys, backend.selectedDisplays, backend.captureBoundDrag, backend.semanticActions]).toEqual([false, false, false, false, false]);
    await expect(backend.identity({ pid: 42, window_id: 99 }, true)).resolves.toBeUndefined();
    expect(await backend.call("semantic_action", { operation: "invoke" })).toMatchObject({ isError: true, structuredContent: { code: "semantic_action_unavailable", attempted: false } });
  } finally { await backend.close(); }
});

test.each(["windows-held-paths", "windows-key-holds"] as const)("an unqualified %s executable cannot start a peer or dispatch input", async runtime => {
  const backend = new McpDriver({ command: process.execPath, runtime });
  try { await expect(backend.call("list_windows", {})).rejects.toThrow("artifact hash mismatch"); }
  finally { await backend.close(); }
});
test("older runtimes refuse key holds without starting an unqualified peer", async () => {
  for (const runtime of [undefined, "windows-held-paths"] as const) {
    const backend = new McpDriver({ command: process.execPath, runtime });
    try {
      expect(backend.heldKeys).toBe(false);
      expect(await backend.call("hold_keys", { keys: ["w"], duration_ms: 500 })).toMatchObject({
        isError: true, structuredContent: { effect: "refused", code: "key_hold_unavailable" },
      });
    } finally { await backend.close(); }
  }
});
test("older profiles refuse capture-bound drag before starting any native peer", async () => {
  for (const runtime of [undefined, "windows-held-paths", "windows-key-holds", "windows-selected-displays"] as const) {
    const backend = new McpDriver({ command: process.execPath, runtime });
    try {
      expect(backend.captureBoundDrag).toBe(false);
      expect(await backend.call("drag", { capture_id: "unqualified" })).toMatchObject({
        isError: true, structuredContent: { effect: "refused", code: "capture_bound_drag_unavailable" },
      });
    } finally { await backend.close(); }
  }
});
test("the qualified pin rejects an older peer before native dispatch", async () => {
  await mkdir(".tmp/native-zoom", {recursive:true});
  const cwd = await mkdtemp(path.resolve(".tmp/native-zoom/version-")); const log = path.join(cwd,"calls.jsonl");
  const backend = new McpDriver({command:process.execPath,args:[path.resolve("test/fixtures/detail-driver.mjs"),log,"0.33.1"]});
  try {
    await expect(backend.call("get_desktop_state",{max_image_dimension:500})).rejects.toThrow("requires cua-driver 0.33.2");
    expect(await readFile(log,"utf8").catch(()=>"")).toBe("");
  } finally { await backend.close(); await rm(cwd,{recursive:true,force:true}); }
});

test("older native runtimes refuse selected-display reads before starting any peer", async () => {
  for (const runtime of [undefined, "windows-held-paths", "windows-key-holds"] as const) {
    const backend = new McpDriver({ command: process.execPath, runtime });
    try {
      expect(backend.selectedDisplays).toBe(false);
      for (const name of ["list_displays", "get_display_state"]) expect(await backend.call(name, {})).toMatchObject({
        isError: true, structuredContent: { effect: "refused", code: "selected_display_unavailable" },
      });
    } finally { await backend.close(); }
  }
});

test.each(["windows-shell-desktops", "windows-single-png"] as const)("the %s profile preserves earlier qualified capabilities and rejects wrong bytes before any membership read", async runtime => {
  const backend = new McpDriver({ command: process.execPath, runtime });
  try {
    expect([backend.heldPaths, backend.heldKeys, backend.selectedDisplays, backend.captureBoundDrag]).toEqual([true, true, true, true]);
    await expect(backend.call("list_windows", {})).rejects.toThrow("artifact hash mismatch");
  } finally { await backend.close(); }
});
test("strict semantic qualification preserves earlier capabilities and rejects wrong bytes before UIA dispatch", async () => {
  const backend = new McpDriver({ command: process.execPath, runtime: "windows-semantic-actions" });
  try {
    expect([backend.heldPaths, backend.heldKeys, backend.selectedDisplays, backend.captureBoundDrag, backend.semanticActions]).toEqual([true, true, true, true, true]);
    await expect(backend.call("semantic_action", { operation: "invoke" })).rejects.toThrow("artifact hash mismatch");
  } finally { await backend.close(); }
});
test("the capture-bound drag profile preserves earlier capabilities but rejects wrong bytes before startup", async () => {
  const backend = new McpDriver({ command: process.execPath, runtime: "windows-capture-drag" });
  try {
    expect([backend.heldPaths, backend.heldKeys, backend.selectedDisplays, backend.captureBoundDrag]).toEqual([true, true, true, true]);
    await expect(backend.call("drag", { capture_id: "candidate" })).rejects.toThrow("artifact hash mismatch");
  } finally { await backend.close(); }
});
test("the exact selected-display profile preserves keys and paths but rejects wrong bytes before startup", async () => {
  const backend = new McpDriver({ command: process.execPath, runtime: "windows-selected-displays" });
  try {
    expect([backend.heldPaths, backend.heldKeys, backend.selectedDisplays]).toEqual([true, true, true]);
    await expect(backend.call("list_displays", {})).rejects.toThrow("artifact hash mismatch");
  } finally { await backend.close(); }
});