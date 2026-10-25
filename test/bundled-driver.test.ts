import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpDriver } from "../src/driver.ts";
import type { BundledRuntime } from "../src/native-runtime.ts";

// A checked synthetic child proves adapter startup/admission, not native OS or app support. cua-driver.exe is a
// shell launcher a Linux host runs directly; a local socket stands in for WSL interop.
async function fixture() {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp", "bundled-peer-"));
  await mkdir(path.join(root, "runtime"));
  // Node will not load an ES module named .exe, so the "driver" is a shell launcher for the fixture beside it.
  await writeFile(path.join(root, "runtime", "bundled-driver.mjs"), await readFile("test/fixtures/bundled-driver.mjs"));
  const launcher = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$(dirname "$0")/bundled-driver.mjs" "$@"\n`;
  const files: Record<string, string> = {};
  for (const name of ["cua-driver.exe", "cua-cursor-theme.exe", "cua-driver-uia.exe", "LICENSE.md", "THIRD_PARTY_NOTICES.md"]) {
    const bytes = name === "cua-driver.exe" ? Buffer.from(launcher) : Buffer.from(name);
    files[name] = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path.join(root, "runtime", name), bytes, { mode: 0o755 });
  }
  const runtime: BundledRuntime = { root, command: path.join(root, "runtime", "cua-driver.exe"), target: "win32-x64",
    source: "a".repeat(40), version: "0.34.0", driverVersion: "0.34.0", files };
  // Unix socket paths are short; keep this one out of the deep worktree path.
  const sockets = await mkdtemp(path.join(tmpdir(), "interop-"));
  const interop = path.join(sockets, "interop.sock");
  const socket: Server = createServer();
  await new Promise<void>(resolve => socket.listen(interop, resolve));
  const cleanup = async () => {
    await new Promise(resolve => socket.close(resolve));
    await rm(root, { recursive: true, force: true });
    await rm(sockets, { recursive: true, force: true });
  };
  return { runtime, interop, cleanup, log: path.join(root, "runtime", "calls.jsonl") };
}

test("bundled startup checks envelopes/schema, forwards interop and display environment and refuses missing native tools without a call", async () => {
  const { runtime, interop, cleanup, log } = await fixture();
  vi.stubEnv("DISPLAY", "owned-fixture:123");
  const transports: StdioClientTransport[] = [];
  const start = StdioClientTransport.prototype.start;
  const spy = vi.spyOn(StdioClientTransport.prototype, "start").mockImplementation(function (this: StdioClientTransport) {
    transports.push(this); return start.call(this);
  });
  const backend = new McpDriver({ command: runtime.command, bundled: runtime, interop });
  try {
    expect(backend.platform).toBe("windows");
    const [result, unsupported] = await Promise.all([backend.call("list_apps", {}), backend.call("unavailable_tool", {})]);
    expect(result.structuredContent).toMatchObject({ environment: { display: "owned-fixture:123", envelopes: "1", telemetry: "false" } });
    expect(unsupported).toMatchObject({ isError: true,
      structuredContent: { code: "unsupported_native_capability", platform: "windows", attempted: false, fallback: false } });
    await backend.close();
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => call.tool).map(call => call.tool)).toEqual(["set_agent_cursor_motion", "get_agent_cursor_state", "list_apps"]);
    expect(calls.filter(call => call.method).map(call => call.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call", "tools/call", "tools/call"]);
    expect(calls[0].args).toEqual(["mcp", "--direct", "--embedded"]);
    expect(calls.at(-1)).toEqual({ eof: true });
  } finally {
    await backend.close(); await Promise.allSettled(transports.map(transport => transport.close()));
    spy.mockRestore(); vi.unstubAllEnvs(); await cleanup();
  }
});

test("changed bundled bytes fail before a native child or any input request exists", async () => {
  const { runtime, interop, cleanup, log } = await fixture();
  await writeFile(runtime.command, "changed");
  const backend = new McpDriver({ command: runtime.command, bundled: runtime, interop });
  try {
    await expect(backend.call("click", { x: 1, y: 1 })).rejects.toThrow("native_runtime_hash_mismatch");
    expect(await readFile(log, "utf8").catch(() => "")).toBe("");
  } finally { await backend.close(); await cleanup(); }
});
