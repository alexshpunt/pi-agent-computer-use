import { afterAll, expect, test } from "vitest";
import { requireComputerAddress } from "../../src/computer-resources.ts";
import { waitCommand } from "../../src/computer-tools.ts";
import { presentComputerResult } from "../../src/provider.ts";
import { connectLive, serveFixture } from "./remote.ts";

// LPT-934 step 2: computer_browser and computer_wait on a Playwright browser of the configured machine.
const live = await connectLive();
const fixture = await serveFixture(live.runner);
afterAll(async () => { await live.close(); fixture.close(); });
const page = async (window: string, command: Record<string, unknown>) => {
  const started = Date.now();
  const result = await live.resources.browserAction(requireComputerAddress(window), live.cwd, command);
  const body = presentComputerResult(result);
  console.log(`${command.action}: ${result.details.status} in ${Date.now() - started} ms`);
  return { result, body };
};
const wait = async (window: string, params: Omit<Parameters<typeof waitCommand>[0], "window">) => {
  const started = Date.now();
  const result = await live.insert(window, waitCommand({ window, ...params }));
  console.log(`wait ${params.mode ?? "wait"}: ${(result.details.verification as { verdict?: string } | undefined)?.verdict} in ${Date.now() - started} ms`);
  return result.details.verification as { verdict: string; timed_out: boolean };
};

test("a browser window is navigated, tabbed, answered and checked by its address alone", async () => {
  const opened = await live.insert(live.machine, { action: "open_browser", url: `${fixture.base}/` });
  expect(opened.details.status, JSON.stringify(opened.content)).toBe("observed");
  const window = `computer:window/${opened.details.window_ref}`;
  expect((await page(window, { action: "navigate", url: `${fixture.base}/tabs` })).body).toContain("Tabs and dialogs");
  expect(await wait(window, { mode: "check", conditions: [{ url_contains: "/tabs" }, { target: { role: "heading", name: "Tabs and dialogs" }, is: "visible" }] })).toMatchObject({ verdict: "satisfied" });
  const evaluated = await page(window, { action: "evaluate", expression: "document.title" });
  expect(evaluated.body).toContain('Evaluation result: "Tabs and dialogs"');
  // A JavaScript dialog opened by page code is answered by computer_browser, and the page sees the answer.
  await page(window, { action: "evaluate", expression: "setTimeout(() => { document.title = 'answered ' + confirm('Proceed?') }, 200); 1" });
  await new Promise(resolve => setTimeout(resolve, 600));
  expect((await page(window, { action: "dialog", accept: true })).result.details.status).toBe("delivered");
  expect(await wait(window, { timeout_ms: 3000, conditions: [{ title: "answered true" }] })).toMatchObject({ verdict: "satisfied" });
  const tab = await page(window, { action: "new_tab", url: `${fixture.base}/` });
  expect(tab.body).toMatch(/Tab t2 \(active\)/);
  // Closing the active tab leaves no tab active until switch_tab, so page actions refuse until then.
  expect((await page(window, { action: "close_tab" })).body).toMatch(/Tab t1/);
  expect((await page(window, { action: "back" })).result.details.status).toBe("refused");
  expect((await page(window, { action: "switch_tab", tab: "t1" })).body).toMatch(/Tab t1 \(active\)/);
  expect((await page(window, { action: "back" })).body).toContain("Fixture home");
  expect(await wait(window, { timeout_ms: 500, conditions: [{ title: "Never" }] })).toMatchObject({ verdict: "unsatisfied", timed_out: true });
});
