import { createSessionRelay, type SessionRelay, type SessionRelayKeys } from "./session-relay.ts";

// A private stdin pipe owns the worker. No credentials appear in argv, files or readiness output.
let input = "";
let initialized = false;
let stopping = false;
let starting: Promise<SessionRelay> | undefined;
let closing: Promise<void> | undefined;

function stop(code = 0): Promise<void> {
  stopping = true;
  if (code !== 0) process.exitCode = code;
  process.stdin.destroy();
  return closing ??= (async () => {
    try { await (await starting)?.close(); }
    catch { process.exitCode = 1; }
  })();
}

process.stdin.on("data", (chunk: Buffer) => {
  if (stopping) return;
  if (initialized) { if (chunk.toString().trim()) void stop(1); return; }
  input += chunk.toString("utf8");
  if (input.length > 1024) { void stop(1); return; }
  const end = input.indexOf("\n");
  if (end < 0) return;
  initialized = true;
  try {
    if (input.slice(end + 1).trim()) throw new Error("Invalid initialization.");
    const keys = JSON.parse(input.slice(0, end)) as SessionRelayKeys;
    input = "";
    starting = createSessionRelay(keys);
    void starting.then(async relay => {
      if (stopping) { await relay.close(); return; }
      process.stdout.write(JSON.stringify({ ports: relay.ports }) + "\n");
    }).catch(() => stop(1));
  } catch { void stop(1); }
});
process.stdin.on("end", () => { void stop(); });
process.stdin.on("error", () => { void stop(1); });
process.stdout.on("error", () => { void stop(1); });
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
process.stdin.resume();
