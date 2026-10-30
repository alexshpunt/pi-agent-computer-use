import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { SessionRelayKeys } from "../src/session-relay.ts";

import { IsolatedSession } from "../src/isolated-session.ts";
import type { SandboxHost } from "../src/sandbox.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** A host where wxc-exec answers each lifecycle phase; `failAt` makes one phase fail. Every script is recorded. */
async function fakeHost(options: { installed?: boolean; failAt?: "provision" | "start"; failForward?: number } = {}) {
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
      if (script === "$env:LOCALAPPDATA") return "C:\\Local\n";
      if (script.startsWith("Test-Path")) return options.installed === false ? "False\n" : "True\n";
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
      return { ports: [1001, 1002, 1003, 1004], close: async () => { relayClosed = true; } };
    },
    async forward(port) {
      forwarded.push(port);
      if (forwarded.length === options.failForward) throw new Error("Forwarding refused");
      return { port: port + 10_000, close: () => { closedForwards.push(port); } };
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
  await session.close();
  expect(f.phases).toEqual(["provision", "start", "exec", "stop", "deprovision"]);
  expect(f.scripts.at(-1)).toContain("Stop-Process -Id 5151");
  expect(f.relayClosed()).toBe(true);
  expect(f.closedForwards).toEqual([1001, 1003]);
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
