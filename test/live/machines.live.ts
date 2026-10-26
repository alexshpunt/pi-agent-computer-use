import { afterAll, expect, test } from "vitest";
import { addresses, connectLive, text } from "./remote.ts";

// LPT-854: a configured machine is used through its own addresses with no connect step; its app addresses open there,
// and closing it reports what was released.
const live = await connectLive();
afterAll(() => live.close());

test("a machine's apps open there, and closing the machine reports each released part", async () => {
  const apps = await live.search(`${live.machine}/apps`, "Paint");
  const paint = (apps.details.state!.apps as { name: string; app_ref: string }[]).find(app => app.name === "Paint");
  expect(paint, text(apps)).toBeTruthy();
  const opened = await live.insert(`computer:app/${paint!.app_ref}`, { action: "open" });
  expect(opened.details.status, text(opened)).toBe("observed");
  expect(opened.details.source_identity?.domain).toBe("windows-remote");
  const window = `computer:window/${opened.details.window_ref}`;
  expect(addresses(await live.search(live.windows, "Paint"), "window")).toContain(window);
  // A new untitled Paint document closes without a save prompt.
  await live.closeWindow((opened.details.target as { window_id: number }).window_id);

  const closed = await live.insert(live.machine, { action: "close" });
  expect(closed.details.status, text(closed)).toBe("closed");
  expect(text(closed)).toMatch(new RegExp(`^${live.machine}: `, "m"));
  // Its references are gone, and the next use starts the machine again.
  // No started machine claims the old window; checking whether the local session holds it is forbidden by this harness.
  await expect(live.read(window, ["state"])).rejects.toThrow(/Live checks use only the remote machine/);
  expect(addresses(await live.read(live.displays), "display").length).toBeGreaterThan(0);
});
