import { afterAll, expect, test } from "vitest";
import { requireComputerAddress, type InputPlan } from "../../src/computer-resources.ts";
import { clickPlan, dragPlan, hoverPlan, pressPlan, scrollPlan, selectPlan, timelinePlan, typePlan, waitCommand } from "../../src/computer-tools.ts";
import { presentComputerResult } from "../../src/provider.ts";
import { deleteComputer } from "../../src/provider.ts";
import { connectLive, nativeForm, openWindow, serveFixture, WINDOWS_POWERSHELL_PATH } from "./remote.ts";

// LPT-927: the typed input tools on a native WinForms window and on a Playwright browser page of the configured machine.
const live = await connectLive();
const fixture = await serveFixture(live.runner);
afterAll(async () => { await live.close(); fixture.close(); });
const timings: string[] = [];
const act = async (window: string, plan: InputPlan) => {
  const started = Date.now();
  const result = await live.resources.input(requireComputerAddress(window), live.cwd, plan);
  const body = presentComputerResult(result);
  timings.push(`${plan.label}${plan.target ? ` ${plan.target}` : plan.point ? ` ${plan.point.x},${plan.point.y}` : ""}: ${result.details.status} in ${Date.now() - started} ms`);
  console.log(timings.at(-1));
  return { result, body };
};
const holds = async (window: string, conditions: Parameters<typeof waitCommand>[0]["conditions"]) => {
  const result = await live.insert(window, waitCommand({ window, timeout_ms: 3000, conditions }));
  return (result.details.verification as { verdict?: string } | undefined)?.verdict;
};
afterAll(() => console.log(timings.join("\n")));

test("one action vocabulary drives a native window by locator, ref and point", async () => {
  const title = `pi-input-${Date.now()}`;
  const window = await openWindow(live, live.machine, WINDOWS_POWERSHELL_PATH, nativeForm(title), title);
  try {
    const button = "getByRole('button', { name: /^Count/ })";
    expect((await act(window, clickPlan({ window, target: button }))).result.details.status).toBe("delivered");
    expect(await holds(window, [{ target: "getByRole('button', { name: 'Count 1' })", is: "exists" }])).toBe("satisfied");
    // A full Read gives the button's place in the image; a later UI-only Read keeps that image as the space of points.
    const full = await live.read(window, ["full"]);
    const element = (full.details.ui as { elements: { hint: string; role: string; name?: string; bounds: { window_image?: { x: number; y: number; width: number; height: number } } }[] })
      .elements.find(item => /Count 1/.test(item.name ?? ""))!;
    const box = element.bounds.window_image!;
    const centre = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    const aria = await live.read(window, ["aria"]);
    const ref = /button "Count 1" \[ref=([0-9a-z]+:[a-z]+)\]/.exec(presentComputerResult(aria))![1];
    expect((await act(window, clickPlan({ window, target: ref }))).result.details.status).toBe("delivered");
    expect(await holds(window, [{ target: "getByRole('button', { name: 'Count 2' })", is: "exists" }])).toBe("satisfied");
    await live.read(window, ["aria"]);
    // The UI-only Read has no pixels, so the point click captures the window first and keeps the full Read's scale.
    expect((await act(window, clickPlan({ window, ...centre }))).result.details.status).toBe("delivered");
    expect(await holds(window, [{ target: "getByRole('button', { name: 'Count 3' })", is: "exists" }])).toBe("satisfied");
    const field = "getByRole('textbox', { name: 'Field' })";
    expect((await act(window, typePlan({ window, target: field, text: "hello" }))).result.details.status).toBe("delivered");
    expect(await holds(window, [{ target: field, value: "hello" }])).toBe("satisfied");
    expect((await act(window, typePlan({ window, target: field, text: "world", replace: true, submit: true }))).result.details.status).toBe("delivered");
    expect(await holds(window, [{ target: field, value: "world" }])).toBe("satisfied");
    expect((await act(window, pressPlan({ window, key: "ctrl+a" }))).result.details.status).toBe("delivered");
    expect((await act(window, pressPlan({ window, key: "Backspace" }))).result.details.status).toBe("delivered");
    // An empty field's value falls back to its name in conditions, so its aria line shows the emptiness: no ": value".
    expect(presentComputerResult(await live.read(window, ["aria"]))).toMatch(/textbox "Field" \[ref=/);
    expect((await act(window, selectPlan({ window, target: "getByRole('list', { name: 'Pick' })", values: ["beta"] }))).result.details.status).toBe("delivered");
    expect(await holds(window, [{ target: "getByRole('option', { name: 'beta' })", is: "selected" }])).toBe("satisfied");
    expect((await act(window, scrollPlan({ window, target: "getByRole('list', { name: 'Pick' })", delta_y: 1 }))).result.details.status).not.toBe("unknown");
    expect((await act(window, scrollPlan({ window, x: centre.x, y: centre.y + 60, delta_y: 1 }))).result.details.status).toBe("delivered");
    expect((await act(window, hoverPlan({ window, target: button }))).result.details.status).toBe("delivered");
    expect((await act(window, dragPlan({ window, from: { x: centre.x, y: centre.y }, to: { x: centre.x + 40, y: centre.y } }))).result.details.status).toBe("delivered");
    const timeline = await act(window, timelinePlan({ window, events: [{ at_ms: 0, type: "move", x: centre.x, y: centre.y }, { at_ms: 50, type: "button_down" }, { at_ms: 100, type: "button_up" }] }));
    expect(timeline.result.details.status, timeline.body).toBe("delivered");
    expect(await holds(window, [{ target: "getByRole('button', { name: /^Count [45]$/ })", is: "exists" }])).toBe("satisfied");
  } finally { await deleteComputer(live.resources, window, { path: window }, live.cwd); }
});

test("the same vocabulary drives a browser page through Playwright by locator and page ref", async () => {
  const opened = await live.insert(live.machine, { action: "open_browser", url: `${fixture.base}/wait` });
  expect(opened.details.status, JSON.stringify(opened.content)).toBe("observed");
  const window = `computer:window/${opened.details.window_ref}`;
  try {
    expect((await act(window, typePlan({ window, target: "getByLabel('Name')", text: "Ada" }))).result.details.status).toBe("delivered");
    const dom = presentComputerResult(await live.read(window, ["dom"]));
    const save = /button "Save" \[ref=(e\d+)\]/.exec(dom)![1];
    const clicked = await act(window, clickPlan({ window, target: save }));
    expect(clicked.result.details.status, clicked.body).toBe("delivered");
    expect(await holds(window, [{ target: { text: "saved Ada" }, is: "visible" }])).toBe("satisfied");
    expect((await act(window, typePlan({ window, target: "getByLabel('Name')", text: "Grace", replace: true, submit: true }))).result.details.status).toBe("delivered");
    expect((await act(window, pressPlan({ window, key: "ctrl+a" }))).result.details.status).toBe("delivered");
    expect((await act(window, hoverPlan({ window, target: "getByRole('button', { name: 'Unlock later' })" }))).result.details.status).toBe("delivered");
    expect((await act(window, scrollPlan({ window, delta_y: 2 }))).result.details.status).toBe("delivered");
    const refused = await live.resources.input(requireComputerAddress(window), live.cwd, timelinePlan({ window, events: [{ at_ms: 0, type: "key_down", key: "a" }, { at_ms: 10, type: "key_up", key: "a" }] })).catch((error: Error) => error.message);
    expect(String(refused)).toContain("timeline on browser pages");
  } finally { await deleteComputer(live.resources, window, { path: window }, live.cwd); }
});
