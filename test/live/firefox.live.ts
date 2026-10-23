import { afterAll, expect, test } from "vitest";
import { connectLive, serveFixture, text } from "./remote.ts";

// LPT-853: open_browser launches Playwright's own Firefox build (setup part firefox) with a disposable profile,
// binds its native window and serves the same DOM views and actions as Chrome and Edge; closing removes it.
const live = await connectLive();
const fixture = await serveFixture(live.runner);
afterAll(async () => { await live.close(); fixture.close(); });

test("Firefox opens, takes Playwright actions, shows native pixels and closes with the session", async () => {
  const opened = await live.insert(live.machine, { action: "open_browser", browser: "firefox", url: `${fixture.base}/input` });
  expect(opened.details.status, text(opened)).toBe("observed");
  const window = `computer:window/${opened.details.window_ref}`;

  const snapshot = await live.read(window, ["dom"]);
  expect(snapshot.details.status, text(snapshot)).toBe("observed");
  expect(snapshot.details.dom?.tabs.find(tab => tab.active)).toMatchObject({ title: "Input log" });
  const before = (await fixture.journal()).length;
  const pressed = await live.insert(`computer:observation/${snapshot.details.observation_id}`, { action: "press", key: "q" });
  expect(pressed.details.status, text(pressed)).toBe("delivered");
  expect((await fixture.journal()).slice(before).filter(event => event.type === "keydown").map(event => event.key)).toEqual(["q"]);

  // The same window is an ordinary native window for CUA.
  const native = await live.read(window, ["image"]);
  expect(native.details.agent_image, text(native)).toBeTruthy();

  const pid = (opened.details.state as { pid: number }).pid;
  await live.close();
  const left = await live.powershell(`@(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Count`);
  expect(Number(left.trim())).toBe(0);
});
