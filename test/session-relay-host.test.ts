import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { connectRelay } from "../src/relay-auth.ts";
import { localRunner, type CommandRunner } from "../src/runner.ts";
import { startSessionRelay } from "../src/session-relay-host.ts";

const keys = () => ({ session: "worker-test", clientKey: randomBytes(32).toString("hex"), sessionKey: randomBytes(32).toString("hex") });
const unreachable = (port: number) => new Promise<boolean>(resolve => {
  const socket = connect({ port, host: "127.0.0.1" });
  socket.once("connect", () => { socket.destroy(); resolve(false); });
  socket.once("error", () => { socket.destroy(); resolve(true); });
});

async function fixture(script?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-relay-worker-"));
  const children: ChildProcessWithoutNullStreams[] = [];
  const invocations: { file: string; args: readonly string[]; env?: Record<string, string> }[] = [];
  const local = localRunner();
  const runner: CommandRunner = {
    ...local, ssh: "fixture",
    spawn(file, args, env) {
      invocations.push({ file, args, env });
      const child = script === undefined ? local.spawn(file, args, env) : spawn(process.execPath, ["-e", script], { stdio: "pipe" });
      children.push(child); return child;
    },
  };
  const cleanup = async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close").catch(() => {}); child.kill(); await closed;
    }
    await rm(root, { recursive: true, force: true });
  };
  return { root, runner, children, invocations, cleanup };
}

test("local relay uses owned in-process listeners and close releases all ports", async () => {
  const k = keys(); const relay = await startSessionRelay(localRunner(), "unused", k);
  const sockets: Socket[] = [];
  try {
    const client = await connectRelay(relay.ports[0], { session: k.session, key: k.clientKey }, { channel: "driver", role: "client" }); sockets.push(client);
    const session = await connectRelay(relay.ports[1], { session: k.session, key: k.sessionKey }, { channel: "driver", role: "session" }); sockets.push(session);
    const reply = once(client, "data"); client.resume(); session.write("owned-response");
    expect(String((await reply)[0])).toBe("owned-response");
    await relay.close();
    expect(await Promise.all(relay.ports.map(unreachable))).toEqual([true, true, true, true]);
  } finally { sockets.forEach(s => s.destroy()); await relay.close(); }
});

test("remote worker receives credentials only on stdin and EOF closes listeners and process", async () => {
  const f = await fixture(); const k = keys();
  try {
    const relay = await startSessionRelay(f.runner, f.root, k);
    const session = await connectRelay(relay.ports[3], { session: k.session, key: k.sessionKey }, { channel: "identity", role: "session" });
    try {
      expect(f.invocations).toHaveLength(1);
      expect(JSON.stringify(f.invocations)).not.toContain(k.clientKey);
      expect(JSON.stringify(f.invocations)).not.toContain(k.sessionKey);
      for (const name of await readdir(f.root)) {
        const source = await readFile(path.join(f.root, name), "utf8");
        expect(source).not.toContain(k.clientKey); expect(source).not.toContain(k.sessionKey);
      }
      await relay.close();
      expect(f.children[0].exitCode).toBe(0);
      expect(await Promise.all(relay.ports.map(unreachable))).toEqual([true, true, true, true]);
    } finally { session.destroy(); await relay.close(); }
  } finally { await f.cleanup(); }
});

test("failed startup waits for every started worker transfer before cleanup can proceed", async () => {
  const f = await fixture();
  const transfers: { resolve(value: string): void; reject(error: Error): void }[] = [];
  let allStarted: () => void;
  const started = new Promise<void>(resolve => { allStarted = resolve; });
  const original = f.runner.run;
  f.runner.run = (file, args, options) => file !== "dd" ? original(file, args, options) : new Promise<string>((resolve, reject) => {
    transfers.push({ resolve, reject });
    if (transfers.length === 3) allStarted();
  });
  const outcome = startSessionRelay(f.runner, f.root, keys()).then(() => "ready", () => "rejected");
  try {
    await started;
    transfers[0].reject(new Error("Transfer fixture failure"));
    const state = await Promise.race([outcome, new Promise<string>(resolve => setTimeout(() => resolve("waiting"), 20))]);
    expect(state).toBe("waiting");
    transfers[1].resolve(""); transfers[2].resolve("");
    expect(await outcome).toBe("rejected");
    expect(f.children).toHaveLength(0);
  } finally {
    transfers.forEach(transfer => transfer.resolve(""));
    await outcome; await f.cleanup();
  }
});

test("an already cancelled startup launches no child or listeners", async () => {
  const f = await fixture(); const abort = new AbortController(); abort.abort();
  try {
    await expect(startSessionRelay(f.runner, f.root, keys(), abort.signal)).rejects.toBeInstanceOf(Error);
    expect(f.children).toHaveLength(0);
    expect(await readdir(f.root)).toEqual([]);
  } finally { await f.cleanup(); }
});

test("cancellation while the worker starts closes stdin and awaits process exit", async () => {
  const f = await fixture("process.stdin.resume(); process.stdin.on('end',()=>process.exit(0)); process.stdin.on('data',()=>{});");
  const abort = new AbortController();
  try {
    const opening = startSessionRelay(f.runner, f.root, keys(), abort.signal);
    // The runner is the real spawn boundary, so cancellation always occurs after the child exists.
    const waitSpawn = f.runner.spawn;
    f.runner.spawn = (...args) => { const child = waitSpawn(...args); queueMicrotask(() => abort.abort()); return child; };
    await expect(opening).rejects.toBeInstanceOf(Error);
    expect(f.children).toHaveLength(1);
    expect(f.children[0].exitCode).toBe(0);
  } finally { await f.cleanup(); }
});

test("EOF during asynchronous worker startup closes listeners that finish opening afterward", async () => {
  const f = await fixture(); const k = keys();
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    // Copy the real worker through the production launcher first, then close that owned instance.
    const prepared = await startSessionRelay(f.runner, f.root, k); await prepared.close();
    const preload = `import net from 'node:net'; const listen = net.Server.prototype.listen; net.Server.prototype.listen = function(...args) { setTimeout(() => listen.apply(this, args), 25); return this; };`;
    child = spawn(process.execPath, ["--experimental-strip-types", `--import=data:text/javascript,${encodeURIComponent(preload)}`, path.join(f.root, "session-relay-worker.ts")], { stdio: "pipe" });
    let output = ""; child.stdout.on("data", chunk => { output += chunk.toString(); }); child.stderr.resume();
    const closed = once(child, "close");
    child.stdin.end(JSON.stringify(k) + "\n");
    const [code, signal] = await closed;
    expect(code).toBe(0); expect(signal).toBeNull();
    expect(output).toBe("");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill(); await closed; }
    await f.cleanup();
  }
});

test("malformed credentials never produce readiness and the real worker exits", async () => {
  const f = await fixture();
  try {
    await expect(startSessionRelay(f.runner, f.root, { ...keys(), clientKey: "not-a-key" })).rejects.toBeInstanceOf(Error);
    expect(f.children).toHaveLength(1);
    expect(f.children[0].exitCode).toBe(1);
  } finally { await f.cleanup(); }
});

test("a missing worker executable is rejected without leaving a live child", async () => {
  const f = await fixture();
  f.runner.spawn = () => {
    const child = spawn(path.join(f.root, "missing-node"), [], { stdio: "pipe" });
    f.children.push(child); return child;
  };
  try {
    await expect(startSessionRelay(f.runner, f.root, keys())).rejects.toBeInstanceOf(Error);
    expect(f.children).toHaveLength(1);
    expect(f.children[0].exitCode).not.toBeNull();
  } finally { await f.cleanup(); }
});

test("a broken worker input pipe rejects startup and still waits for EOF cleanup", async () => {
  const f = await fixture();
  const original = f.runner.spawn;
  f.runner.spawn = (...args) => {
    const child = original(...args);
    queueMicrotask(() => child.stdin.destroy(new Error("fixture pipe error")));
    return child;
  };
  try {
    await expect(startSessionRelay(f.runner, f.root, keys())).rejects.toBeInstanceOf(Error);
    expect(f.children).toHaveLength(1);
    expect(f.children[0].exitCode).toBe(0);
  } finally { await f.cleanup(); }
});

test.each([
  "process.stdout.write('not-json\\n'); process.stdin.resume();",
  "process.stdout.write('x'.repeat(2048)); process.stdin.resume();",
  "process.stdout.write(JSON.stringify({ports:[1,2]})+'\\n'); process.stdin.resume();",
  "process.stdin.resume(); process.stdin.once('data',()=>process.exit(7));",
])("invalid startup output or early worker failure is rejected and reaped (%#)", async script => {
  const f = await fixture(script);
  try {
    await expect(startSessionRelay(f.runner, f.root, keys())).rejects.toBeInstanceOf(Error);
    expect(f.children[0].exitCode).not.toBeNull();
  } finally { await f.cleanup(); }
});
