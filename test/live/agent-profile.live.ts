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

test("an already-running agent profile is refused before Chromium is launched", async () => {
  const first = await connectLive();
  const second = await connectLive();
  try {
    const opened = await first.insert(first.machine, { action: "open_browser", browser: "msedge", profile: "agent", url: `${fixture.base}/` });
    expect(opened.details.status, text(opened)).toBe("observed");
    const duplicate = await second.insert(second.machine, { action: "open_browser", browser: "msedge", profile: "agent", url: `${fixture.base}/other` });
    expect(duplicate.details.status).toBe("refused");
    expect(text(duplicate)).toMatch(/profile is already in use/i);
    expect(await evaluate(first, opened, "location.pathname")).not.toContain("/other");
  } finally { await second.close(); await first.close(); }
});
test("agent Chromium uses a normal browser debugging connection", async () => {
  const live = await connectLive();
  try {
    const opened = await live.insert(live.machine, { action: "open_browser", browser: "msedge", profile: "agent", url: `${fixture.base}/` });
    expect(opened.details.status, text(opened)).toBe("observed");
    const pid = opened.details.target!.pid;
    const command = await live.powershell(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`);
    expect(command).toMatch(/--remote-debugging-port=[1-9]\d*/);
    expect(command).not.toContain("--remote-debugging-pipe");
    expect(await evaluate(live, opened, "String(navigator.webdriver)")).toContain("false");
  } finally { await live.close(); }
});
test("Safe opens its agent browser without a command-line debugging endpoint", async () => {
  const live = await connectLive(process.cwd(), "safe");
  try {
    const before = (await fixture.journal()).filter(entry => entry.type === "download-served").length;
    const url = `${fixture.base}/download/report.txt`;
    const opened = await live.insert(live.machine, { action: "open_browser", browser: "msedge", profile: "agent", url });
    expect(opened.details.status, text(opened)).toBe("observed");
    const pid = opened.details.target!.pid;
    const command = await live.powershell("(Get-CimInstance Win32_Process -Filter \"ProcessId=" + pid + "\").CommandLine");
    expect(command).not.toContain(url);
    expect((await fixture.journal()).filter(entry => entry.type === "download-served")).toHaveLength(before);
    expect(command).not.toMatch(/--remote-debugging-(port|pipe)/);
    const dom = await live.read("computer:window/" + opened.details.window_ref, ["dom"]);
    expect(dom.details.status).toBe("refused");
    const image = await live.read("computer:window/" + opened.details.window_ref, ["image"]);
    expect(image.details.status, text(image)).toBe("observed");
    const click = await live.insert(`computer:observation/${image.details.observation_id}`, { action: "click", x: 10, y: 10 });
    expect(click.details.status).toBe("refused");
  } finally { await live.close(); }
});
test("agent Chromium retains site data after its browser closes", async () => {
  const marker = `pi-${Date.now()}`;
  const first = await connectLive();
  try {
    const opened = await first.insert(first.machine, { action: "open_browser", browser: "msedge", profile: "agent", url: `${fixture.base}/` });
    expect(opened.details.status, text(opened)).toBe("observed");
    await evaluate(first, opened, `localStorage.setItem("pi-marker", "${marker}")`);
  } finally { await first.close(); }
  const second = await connectLive();
  try {
    const opened = await second.insert(second.machine, { action: "open_browser", browser: "msedge", profile: "agent", url: `${fixture.base}/` });
    expect(opened.details.status, text(opened)).toBe("observed");
    expect(await evaluate(second, opened, 'localStorage.getItem("pi-marker")')).toContain(marker);
    await evaluate(second, opened, 'localStorage.removeItem("pi-marker")');
  } finally { await second.close(); }
});
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
