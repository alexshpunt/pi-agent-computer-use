import { readFile } from "node:fs/promises";
import { runnerFiles, type CommandRunner } from "./runner.ts";
import { createSessionRelay, type SessionRelay, type SessionRelayKeys } from "./session-relay.ts";

const STARTUP_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 5000;
const MAX_OUTPUT = 1024;

/** Local listeners stay in-process; an SSH host runs the same packaged code with stdin-owned lifetime. */
export async function startSessionRelay(runner: CommandRunner, workdir: string, keys: SessionRelayKeys, signal?: AbortSignal): Promise<SessionRelay> {
  signal?.throwIfAborted();
  if (!runner.ssh) {
    const relay = await createSessionRelay(keys);
    if (signal?.aborted) { await relay.close(); signal.throwIfAborted(); }
    return relay;
  }

  const files = runnerFiles(runner);
  const transfers = await Promise.allSettled(["relay-auth.ts", "session-relay.ts", "session-relay-worker.ts"].map(async name => {
    const source = await readFile(new URL(name, import.meta.url), "utf8");
    signal?.throwIfAborted();
    await files.write(files.join(workdir, name), source);
  }));
  // Startup owns every started write until it finishes, including after a sibling write fails.
  for (const transfer of transfers) if (transfer.status === "rejected") throw transfer.reason;
  signal?.throwIfAborted();
  const child = runner.spawn("node", ["--experimental-strip-types", files.join(workdir, "session-relay-worker.ts")]);
  let output = "";
  let ready = false;
  let failure: Error | undefined;
  let rejectStartup: (error: Error) => void;
  let closePromise: Promise<void> | undefined;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const fail = (error: Error) => {
    failure ??= error;
    rejectStartup(error);
    if (ready) child.stdin.end();
  };
  const close = (): Promise<void> => closePromise ??= (async () => {
    child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // An SSH kill is only a fallback. It does not prove the remote listener has exited.
          child.kill();
          reject(new Error("Relay worker shutdown is unconfirmed."));
        }, SHUTDOWN_TIMEOUT_MS);
      })]);
      if (result.code !== 0 || result.signal) throw new Error("Relay worker did not exit cleanly.");
      if (failure && ready) throw failure;
    } finally { clearTimeout(timer); }
  })();

  const startup = new Promise<SessionRelay["ports"]>((resolve, reject) => {
    rejectStartup = reject;
    child.stdout.on("data", (chunk: Buffer) => {
      if (ready) { if (chunk.toString().trim()) fail(new Error("Unexpected relay worker output.")); return; }
      output += chunk.toString("utf8");
      if (output.length > MAX_OUTPUT) { fail(new Error("Relay worker readiness is too large.")); return; }
      const end = output.indexOf("\n");
      if (end < 0) return;
      try {
        const result = JSON.parse(output.slice(0, end)) as { ports?: unknown };
        const ports = result.ports;
        if (output.slice(end + 1).trim() || !Array.isArray(ports) || ports.length !== 4
          || !ports.every(port => Number.isInteger(port) && port > 0 && port <= 65535) || new Set(ports).size !== 4)
          throw new Error("Invalid readiness.");
        ready = true;
        resolve(ports as SessionRelay["ports"]);
      } catch { fail(new Error("Invalid relay worker readiness.")); }
    });
    child.once("error", () => fail(new Error("Could not start relay worker.")));
    child.once("close", () => { if (!ready) fail(new Error("Relay worker exited before readiness.")); });
    child.stdin.on("error", () => fail(new Error("Relay worker input closed unexpectedly.")));
    child.stdout.on("error", () => fail(new Error("Relay worker output failed.")));
    // Node may emit experimental/module warnings. Never include raw diagnostics or secret input in errors.
    child.stderr.on("error", () => fail(new Error("Relay worker diagnostics stream failed.")));
    child.stderr.resume();
  });
  const abort = () => fail(new Error("Cancelled while starting relay worker."));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => fail(new Error("Relay worker did not become ready in time.")), STARTUP_TIMEOUT_MS);
  try {
    child.stdin.write(JSON.stringify(keys) + "\n");
    const ports = await startup;
    signal?.throwIfAborted();
    return { ports, close };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Relay startup failed and shutdown was not clean."); }
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
