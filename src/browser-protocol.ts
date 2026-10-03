import readline from "node:readline";
import { BrowserSession, type BrowserAction, type BrowserBackend } from "./browser-session.ts";

/** Serve bounded browser operations on an owned stdio pipe. EOF immediately closes the owned backend. */
export function serveBrowserWorker(backend: BrowserBackend): void {
  const session = new BrowserSession(backend);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<unknown>>();
  let ending = false;
  const refused = (message: string) => ({
    content: [{ type: "text", text: message }], details: { status: "refused" }, isError: true,
  });

  input.on("line", line => {
    if (ending) return;
    const work = (async () => {
      let id: unknown;
      let result;
      try {
        if (line.length > 20_000) throw new Error("Browser request exceeds limit.");
        const request = JSON.parse(line);
        id = request.id;
        if (!Number.isSafeInteger(id) || (id as number) <= 0) throw new Error("Invalid request identity.");
        switch (request.operation) {
          case "open": result = await session.open(request.args.url); break;
          case "observe": result = await session.observe(request.args.page_ref); break;
          case "act": result = await session.act(request.args as BrowserAction); break;
          case "tabs": result = await session.list(); break;
          case "close": result = await session.close(); break;
          default: result = refused("Unknown browser operation.");
        }
      } catch (error) { result = refused(error instanceof Error ? error.message : String(error)); }
      if (!ending) process.stdout.write(JSON.stringify({ id, result }) + "\n");
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });

  async function shutdown() {
    if (ending) return;
    ending = true;
    input.close();
    try { await backend.close(); }
    catch (error) { process.stderr.write("Owned browser cleanup failed: " + String(error) + "\n"); process.exitCode = 1; }
    await Promise.allSettled(pending);
  }
  input.on("close", () => { void shutdown(); });
  process.stdout.on("error", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
  process.on("SIGINT", () => { void shutdown(); });
}
