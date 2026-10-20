import { afterAll, expect, test } from "vitest";
import { connectLive, serveFixture, text } from "./remote.ts";
import type { ComputerResult } from "../../src/session.ts";

// LPT-820: the agent's persistent Chrome profile keeps site data between computer sessions; a disposable one does not.
const fixture = await serveFixture((await connectLive()).runner);
afterAll(() => fixture.close());

const evaluate = async (live: Awaited<ReturnType<typeof connectLive>>, opened: ComputerResult, expression: string) => {
  const dom = await live.read(`computer:window/${opened.details.window_ref}`, ["dom"]);
  const result = await live.insert(`computer:observation/${dom.details.observation_id}`, { action: "evaluate", expression });
  return text(result);
};

test("site data written in the agent profile is still there in the next session", async () => {
  const marker = `pi-${Date.now()}`;
  const first = await connectLive();
  const opened = await first.insert(first.machine, { action: "open_browser", browser: "chrome", profile: "agent", url: `${fixture.base}/` });
  expect(opened.details.status, text(opened)).toBe("observed");
  expect(text(opened)).toMatch(/persistent profile/);
  await evaluate(first, opened, `localStorage.setItem("pi-marker", "${marker}")`);
  await first.close();

  const second = await connectLive();
  const again = await second.insert(second.machine, { action: "open_browser", browser: "chrome", profile: "agent", url: `${fixture.base}/` });
  expect(again.details.status, text(again)).toBe("observed");
  const stored = await evaluate(second, again, 'localStorage.getItem("pi-marker")');
  expect(stored).toContain(marker);
  const disposable = await second.insert(second.machine, { action: "open_browser", browser: "chrome", url: `${fixture.base}/` });
  expect(await evaluate(second, disposable, 'String(localStorage.getItem("pi-marker"))')).toContain("null");
  await second.close();
});
