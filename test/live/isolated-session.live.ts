import { afterAll, expect, test } from "vitest";
import { computerSource } from "../../src/computer-address.ts";
import { connectLive, text } from "./remote.ts";

// LPT-630: an isolated agent session (MXC isolation_session) on the configured machine: its own desktop, apps and
// input, operated through ordinary Search/Read/Insert, and removed again on close.
const live = await connectLive();
const opened: string[] = [];
afterAll(async () => { for (const session of opened) await live.insert(session, { action: "close" }).catch(() => undefined); await live.close(); });

test("an isolated session opens, runs an app with foreground input and closes without leaving its agent user", async () => {
  const started = performance.now();
  const result = await live.insert(live.machine, { action: "open_session" });
  expect(result.details.status, text(result)).toBe("delivered");
  console.log(`opened in ${Math.round(performance.now() - started)} ms`);
  const session = computerSource("sandbox", result.details.sandbox_ref!);
  opened.push(session);
  const user = /Agent user: (\S+)/.exec(text(result))![1];

  const app = await live.insert(session, { action: "open", path: "C:\\Windows\\System32\\notepad.exe" });
  expect(app.details.status, text(app)).toBe("observed");
  expect(app.details.source_identity?.domain).toBe("windows-session");
  const window = `computer:window/${app.details.window_ref}`;
  const view = await live.read(window, ["image"]);
  const typed = await live.write(`computer:observation/${view.details.observation_id}?delivery=foreground`, "isolated-ok");
  expect(typed.details.status, text(typed)).toBe("delivered");
  const after = await live.read(window, ["full"]);
  expect(after.details.ui!.elements.find(e => e.role === "Edit" || e.role === "Document")?.value).toBe("isolated-ok");

  // The human's own windows are not this session's.
  const listed = await live.search(session, "regex:.");
  expect(JSON.stringify(listed.details.state)).not.toMatch(/Visual Studio Code|Telegram/);

  const closed = await live.insert(session, { action: "close" });
  expect(closed.details.status, text(closed)).toBe("closed");
  opened.pop();
  const left = await live.runner.run("bash", ["-c", `ls -d /mnt/c/Users/${user} 2>/dev/null || true`]);
  expect(left.trim()).toBe("");
});
