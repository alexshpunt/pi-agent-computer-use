import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpDriver } from "../src/driver.ts";
import type { BundledRuntime } from "../src/native-runtime.ts";

// A checked synthetic child proves adapter startup/admission, not native OS or app support.
async function fixture() {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp", "bundled-peer-"));
  await mkdir(path.join(root, "runtime"));
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  const files: Record<string, string> = {};
  for (const name of ["cua-driver", "cua-cursor-theme", "LICENSE.md", "THIRD_PARTY_NOTICES.md"]) {
    const bytes = name === "cua-driver" ? await readFile("test/fixtures/bundled-driver.mjs") : Buffer.from(name);
    files[name] = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path.join(root, "runtime", name), bytes, { mode: 0o755 });
  }
  const runtime: BundledRuntime = { root, command: path.join(root, "runtime", "cua-driver"), target: "linux-x64",
    source: "a".repeat(40), version: "0.34.0-dev.fixture", driverVersion: "0.34.0", files };
  return { runtime, log: path.join(root, "runtime", "calls.jsonl") };
}

test("bundled startup checks envelopes/schema, preserves Linux display environment and refuses missing native tools without a call", async () => {
  const { runtime, log } = await fixture();
  vi.stubEnv("DISPLAY", "owned-fixture:123");
  const transports: StdioClientTransport[] = [];
  const start = StdioClientTransport.prototype.start;
  const spy = vi.spyOn(StdioClientTransport.prototype, "start").mockImplementation(function (this: StdioClientTransport) {
    transports.push(this); return start.call(this);
  });
  const backend = new McpDriver({ command: runtime.command, bundled: runtime });
  try {
    const [result, unsupported] = await Promise.all([backend.call("list_apps", {}), backend.call("unavailable_tool", {})]);
    expect(result.structuredContent).toMatchObject({ environment: { display: "owned-fixture:123", envelopes: "1", telemetry: "false" } });
    expect(unsupported).toMatchObject({ isError: true,
      structuredContent: { code: "unsupported_native_capability", platform: "linux", attempted: false, fallback: false } });
    await backend.close();
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => call.tool).map(call => call.tool)).toEqual(["list_apps"]);
    expect(calls.filter(call => call.method).map(call => call.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    expect(calls[0].args).toEqual(["mcp", "--direct", "--embedded"]);
    expect(calls.at(-1)).toEqual({ eof: true });
  } finally {
    await backend.close(); await Promise.allSettled(transports.map(transport => transport.close()));
    spy.mockRestore(); vi.unstubAllEnvs(); await rm(runtime.root, { recursive: true, force: true });
  }
});

test("changed bundled bytes fail before a native child or any input request exists", async () => {
  const { runtime, log } = await fixture();
  await writeFile(runtime.command, "changed");
  const backend = new McpDriver({ command: runtime.command, bundled: runtime });
  try {
    await expect(backend.call("click", { x: 1, y: 1 })).rejects.toThrow("native_runtime_hash_mismatch");
    expect(await readFile(log, "utf8").catch(() => "")).toBe("");
  } finally { await backend.close(); await rm(runtime.root, { recursive: true, force: true }); }
});
