import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { SessionRelayKeys } from "../src/session-relay.ts";

import { IsolatedSession } from "../src/isolated-session.ts";
import type { SandboxHost } from "../src/sandbox.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** A host where wxc-exec answers each lifecycle phase; `failAt` makes one phase fail. Every script is recorded. */
async function fakeHost(options: { installed?: boolean; failAt?: "provision" | "start"; failForward?: number; streamPort?: number } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-session-test-"));
  roots.push(root);
  const scripts: string[] = [];
  const relayKeys: SessionRelayKeys[] = [];
  let relayClosed = false;
  const forwarded: number[] = [], closedForwards: number[] = [];
  const phases: string[] = [];
  const host: SandboxHost = {
    async path(value, to) {
      if (to === "windows") return value.startsWith("/mnt/c/") ? "C:\\" + value.slice(7).replaceAll("/", "\\") : value;
      return path.join(root, value.replace(/^C:\\/, "").replaceAll("\\", "/"));
    },
    async powershell(script) {
      scripts.push(script);
      if (script.startsWith("$env:LOCALAPPDATA;") && script.includes("wxc-exec.exe")) return `C:\\Local\r\n${options.installed === false ? "False" : "True"}\r\n`;
      const phase = /--operation (\w+)/.exec(script)?.[1];
      if (phase && !script.includes("Start-Process")) {
        phases.push(phase);
        if (phase === options.failAt) return `{"error":{"code":"backend_error","message":"${phase} refused"}}`;
        if (phase === "provision") {
          await mkdir(path.join(root, "Users/A1/Shared"), { recursive: true });
          return `{"result":{"metadata":{"agentUserName":"A1","ephemeralWorkspacePath":"C:\\\\Users\\\\A1\\\\Shared"},"sandboxId":"iso:abc"}}`;
        }
        return `{"result":{}}`;
      }
      if (script.includes("--operation exec")) { phases.push("exec"); return "5151\n"; }
      return "";
    },
    mkdir: async dir => { await mkdir(dir, { recursive: true }); },
    writeFile: (file, content) => writeFile(file, content),
    readFile: file => readFile(file, "utf8").catch(() => ""),
    remove: dir => rm(dir, { recursive: true, force: true }),
    async reverseRelay(_workdir, keys) {
      relayKeys.push(keys);
      return { ports: [1001, 1002, 1003, 1004, 1005, 1006], streamPort: options.streamPort ?? 1007, close: async () => { relayClosed = true; } };
    },
    async forward(port) {
      forwarded.push(port);
      if (forwarded.length === options.failForward) throw new Error("Forwarding refused");
      // The stream hub's port stays as it is, so a test can serve it.
      return { port: port === options.streamPort ? port : port + 10_000, close: () => { closedForwards.push(port); } };
    },
  };
  return { host, scripts, phases, root, relayKeys, closedForwards, relayClosed: () => relayClosed };
}

test("a session provisions, starts its driver through the reverse relay, and close removes the agent user", async () => {
  const f = await fakeHost();
  const session = await IsolatedSession.open(f.host, "/mnt/c/runtime/cua-driver.exe");
  expect(f.phases).toEqual(["provision", "start", "exec"]);
  expect(session.endpoint).toMatchObject({ url: "http://127.0.0.1:11001/mcp", identityPort: 11003, domain: "windows-session" });
  // The driver config inside the session points its relay at the host's session-side ports.
  const config = JSON.parse(await readFile(path.join(f.root, "Users/A1/Shared/session.json"), "utf8"));
  expect(config).toMatchObject({ hostDriverPort: 1002, hostIdentityPort: 1004,
    relay: { session: session.ref, key: f.relayKeys[0].sessionKey } });
  expect(config.relay.key).not.toBe(session.endpoint?.relay?.key);
  expect(session.endpoint?.relay).toEqual({ session: session.ref, key: f.relayKeys[0].clientKey });
  expect(JSON.stringify(config)).not.toContain(f.relayKeys[0].clientKey);
  expect(await readFile(path.join(f.root, "Users/A1/Shared/session-start.ps1"), "utf8")).toContain("--no-overlay");
  // The session's stream service gets its own token and the stream relay port; tile hosts find the hub in stream.json.
  const keys = f.relayKeys[0];
  expect(config.stream).toEqual({ token: keys.stream!.spacesd, hostPort: 1006 });
  expect(JSON.stringify(config)).not.toContain(keys.stream!.viewer);
  const discovery = JSON.parse(await readFile(path.join(f.root, `Local/PiComputerUse/sessions/${session.ref}/stream.json`), "utf8"));
  expect(discovery).toEqual({ version: 1, session: session.ref, agentUser: "A1", url: "ws://127.0.0.1:1007/v1/stream", token: keys.stream!.viewer });
  await session.close();
  expect(f.phases).toEqual(["provision", "start", "exec", "stop", "deprovision"]);
  expect(f.scripts.at(-1)).toContain("Stop-Process -Id 5151");
  expect(f.relayClosed()).toBe(true);
  expect(f.closedForwards).toEqual([1001, 1003, 1007]);
});

test("the agent's window activity reaches the stream hub without images or typed text, latest first", async () => {
  const posts: { auth?: string; body: Record<string, unknown> }[] = [];
  const hub = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => { posts.push({ auth: request.headers.authorization, body: JSON.parse(body) }); response.writeHead(204).end(); });
  });
  await new Promise<void>(resolve => hub.listen(0, "127.0.0.1", resolve));
  const port = (hub.address() as AddressInfo).port;
  const f = await fakeHost({ streamPort: port });
  const session = await IsolatedSession.open(f.host, "/mnt/c/runtime/cua-driver.exe");
  try {
    const frame = (x: number) => ({ target: { pid: 7, window_id: 99 }, identity: "PiComputerUse." + "a".repeat(32) + ":7:1",
      bounds: { x: 10, y: 20, width: 300, height: 200 }, mark: { kind: "action" as const, point: { x, y: 50 } }, action: "click", outcome: "delivered" as const,
      typedText: "secret", image: { type: "image" as const, data: "AAAA", mimeType: "image/png" } });
    session.activity(frame(100)); session.activity(frame(110)); session.activity(frame(120));
    session.activity({ clear: true });
    for (let i = 0; i < 100 && posts.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
    // The first post went out at once; of the two queued behind it only the newest is sent.
    expect(posts.map(post => (post.body.point as { x: number }).x)).toEqual([100, 120]);
    expect(posts[0].auth).toBe(`Bearer ${f.relayKeys[0].stream!.viewer}`);
    expect(posts[0].body).toEqual({ pid: 7, bounds: { x: 10, y: 20, width: 300, height: 200 }, kind: "action", point: { x: 100, y: 50 }, action: "click", outcome: "delivered" });
  } finally { await session.close(); await new Promise<void>(resolve => hub.close(() => resolve())); }
});

test("a streaming session starts the machine's tile host without waiting for it, and names its state", async () => {
  const f = await fakeHost();
  const calls: { host: SandboxHost; local: string; sessions: string[] }[] = [];
  let finish!: (state: "started") => void;
  const session = await IsolatedSession.open(f.host, "/mnt/c/runtime/cua-driver.exe", undefined, { tileHost: (host, local) => {
    const sessions = path.join(f.root, "Local/PiComputerUse/sessions");
    calls.push({ host, local, sessions: readdirSync(sessions).filter(ref => existsSync(path.join(sessions, ref, "stream.json"))) });
    return new Promise(resolve => { finish = resolve; });
  } });
  try {
    expect(calls).toHaveLength(1);
    expect(calls[0].host).toBe(f.host);
    expect(calls[0].local).toBe("C:\\Local");
    // The tiles find the session through its stream.json, which exists before the host starts.
    expect(calls[0].sessions).toEqual([session.ref]);
    expect(session.describe("computer:sandbox/x")).toContain("Live tiles on the human's desktop: starting.");
    finish("started");
    await new Promise(resolve => setImmediate(resolve));
    expect(session.describe("computer:sandbox/x")).toContain("Live tiles on the human's desktop: shown under all windows");
  } finally { await session.close(); }

  const failing = await fakeHost();
  const broken = await IsolatedSession.open(failing.host, "/mnt/c/runtime/cua-driver.exe", undefined, { tileHost: async () => { throw new Error("csc is missing"); } });
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(broken.describe("computer:sandbox/y")).toContain("Live tiles on the human's desktop: unavailable (csc is missing).");
  } finally { await broken.close(); }
});

test("a failed second forward closes the first tunnel and relay before removing the session", async () => {
  const f = await fakeHost({ failForward: 2 });
  await expect(IsolatedSession.open(f.host, "/mnt/c/runtime/cua-driver.exe")).rejects.toBeInstanceOf(Error);
  expect(f.closedForwards).toEqual([1001]);
  expect(f.relayClosed()).toBe(true);
  expect(f.phases).toEqual(["provision", "start", "exec", "stop", "deprovision"]);
});

test("a machine without MXC refuses before provisioning anything", async () => {
  const f = await fakeHost({ installed: false });
  await expect(IsolatedSession.open(f.host, "/mnt/c/runtime/cua-driver.exe")).rejects.toThrow(/MXC is not installed.*Ask the user.*\/computer-setup mxc/);
  expect(f.phases).toEqual([]);
});

test("a refused provision reports Windows' reason; a failed start still removes the agent user", async () => {
  const refused = await fakeHost({ failAt: "provision" });
  await expect(IsolatedSession.open(refused.host, "/mnt/c/runtime/cua-driver.exe")).rejects.toThrow(/Windows refused an isolated session: .*provision refused/);
  expect(refused.phases).toEqual(["provision"]);
  const failed = await fakeHost({ failAt: "start" });
  await expect(IsolatedSession.open(failed.host, "/mnt/c/runtime/cua-driver.exe")).rejects.toThrow(/start refused/);
  expect(failed.phases).toEqual(["provision", "start", "stop", "deprovision"]);
});
