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
    // Keys are real key presses, so the app behaves as for a person: a WinForms TextBox ignores ctrl+a. End clears the
    // selection replace left, and shift+Home selects the text again only if the chord arrives as a chord: a bare Home
    // would leave the caret at the start and Backspace would delete nothing.
    for (const key of ["End", "shift+Home", "Backspace"]) expect((await act(window, pressPlan({ window, key }))).result.details.status).toBe("delivered");
    // An empty field's value falls back to its name in conditions, so its aria line shows the emptiness: no ": value".
    const field_line = /textbox "Field".*$/m.exec(presentComputerResult(await live.read(window, ["aria"])))![0];
    expect(field_line).toMatch(/^textbox "Field" \[ref=[0-9a-z]+:[a-z]+\]$/);
    expect((await act(window, selectPlan({ window, target: "getByRole('list', { name: 'Pick' })", values: ["beta"] }))).result.details.status).toBe("delivered");
    expect(await holds(window, [{ target: "getByRole('option', { name: 'beta' })", is: "selected" }])).toBe("satisfied");
    expect((await act(window, scrollPlan({ window, target: "getByRole('list', { name: 'Pick' })", delta_y: 1 }))).result.details.status).not.toBe("unknown");
    const wheel = await act(window, scrollPlan({ window, x: centre.x, y: centre.y + 60, delta_y: 1 }));
    expect(wheel.result.details.status, wheel.body).toBe("delivered");
    expect((await act(window, hoverPlan({ window, target: button }))).result.details.status).toBe("delivered");
    expect((await act(window, dragPlan({ window, from: { x: centre.x, y: centre.y }, to: { x: centre.x + 40, y: centre.y } }))).result.details.status).toBe("delivered");
    const timeline = await act(window, timelinePlan({ window, events: [{ at_ms: 0, type: "move", x: centre.x, y: centre.y }, { at_ms: 50, type: "button_down" }, { at_ms: 100, type: "button_up" }] }));
    expect(timeline.result.details.status, timeline.body).toBe("delivered");
    expect(await holds(window, [{ target: "getByRole('button', { name: /^Count [45]$/ })", is: "exists" }])).toBe("satisfied");
  } finally { await deleteComputer(live.resources, window, { path: window }, live.cwd); }
});

// LPT-942: what the agent sees structurally is pressed structurally; without a pattern the same call uses the real pointer.
test("a ref is pressed through UI Automation without taking the foreground, and a ref without a pattern gets the real pointer", async () => {
  const title = `pi-route-${Date.now()}`;
  const window = await openWindow(live, live.machine, WINDOWS_POWERSHELL_PATH, nativeForm(title), title);
  try {
    const foreground = async () => ((await live.read(window, ["state"])).details.state?.state as { foreground_at_target: boolean }).foreground_at_target;
    const refOf = async (pattern: RegExp) => pattern.exec(presentComputerResult(await live.read(window, ["ui"])))![1];
    const button = await refOf(/^([0-9a-z]+:[a-z]+) \| Button \| Count 0/m);
    const structural = await act(window, clickPlan({ window, target: button }));
    expect(structural.result.details.status, structural.body).toBe("delivered");
    expect(structural.body).not.toContain("real pointer");
    expect(await holds(window, [{ target: "getByRole('button', { name: 'Count 1' })", is: "exists" }])).toBe("satisfied");
    // UI Automation pressed the button in the background: the window never came to the front.
    expect(await foreground()).toBe(false);
    const field = await refOf(/^([0-9a-z]+:[a-z]+) \| Edit \| Field/m);
    const real = await act(window, clickPlan({ window, target: field }));
    expect(real.result.details.status, real.body).not.toBe("refused");
    expect(real.body).toContain("No UI Automation pattern of the target carried this click, so this call used the real pointer.");
  } finally {
    await deleteComputer(live.resources, `${window}?force=true`, { path: `${window}?force=true` }, live.cwd);
  }
});

test("points of a native canvas draw strokes that the receipt shows as changed pixels", async () => {
  const opened = await live.insert(live.machine, { action: "open", app: "Paint" });
  expect(opened.details.status, JSON.stringify(opened.content)).toBe("observed");
  const window = `computer:window/${opened.details.window_ref}`;
  try {
    const image = await live.read(window, ["image"]);
    const size = image.details.state as { screenshot_width: number; screenshot_height: number };
    const middle = { x: Math.round(size.screenshot_width / 2), y: Math.round(size.screenshot_height * 0.6) };
    const stroke = await act(window, dragPlan({ window, from: { x: middle.x - 120, y: middle.y }, to: { x: middle.x + 120, y: middle.y + 40 }, via: [{ x: middle.x, y: middle.y - 60 }] }));
    expect(stroke.result.details.status, stroke.body).toBe("delivered");
    expect(stroke.body).toMatch(/Pixels changed in \d+ area/);
    const line = await act(window, timelinePlan({ window, events: [{ at_ms: 0, type: "move", x: middle.x - 100, y: middle.y + 80 }, { at_ms: 20, type: "button_down" },
      { at_ms: 60, type: "move", x: middle.x, y: middle.y + 100 }, { at_ms: 100, type: "move", x: middle.x + 100, y: middle.y + 80 }, { at_ms: 140, type: "button_up" }] }));
    expect(line.result.details.status, line.body).toBe("delivered");
    expect(line.body).toMatch(/Pixels changed in \d+ area/);
  } finally {
    // Paint asks about the unsaved drawing, so the window the session opened is ended without saving.
    await deleteComputer(live.resources, `${window}?force=true`, { path: `${window}?force=true` }, live.cwd);
  }
});

test("points of a browser page take clicks, wheel, drags, held keys and a pressure pen through Playwright", async () => {
  const opened = await live.insert(live.machine, { action: "open_browser", url: `${fixture.base}/input` });
  expect(opened.details.status, JSON.stringify(opened.content)).toBe("observed");
  const window = `computer:window/${opened.details.window_ref}`;
  const since = (await fixture.journal()).length;
  try {
    const delivered = async (plan: InputPlan) => { const { result, body } = await act(window, plan); expect(result.details.status, body).toBe("delivered"); };
    await delivered(clickPlan({ window, x: 200, y: 200, modifiers: ["shift"] }));
    await delivered(clickPlan({ window, x: 220, y: 200, count: 2 }));
    // The double click asked the pad for pointer lock; leave it so later moves are ordinary.
    await delivered(pressPlan({ window, key: "Escape" }));
    await delivered(scrollPlan({ window, x: 300, y: 300, delta_y: 2 }));
    await delivered(dragPlan({ window, from: { x: 100, y: 150 }, to: { x: 400, y: 260 }, via: [{ x: 250, y: 150 }], duration_ms: 300 }));
    await delivered(pressPlan({ window, key: "w", hold_ms: 400 }));
    await delivered(timelinePlan({ window, events: [{ at_ms: 0, type: "pen_down", x: 150, y: 400, pressure: 0.8, tilt_x: 20 }, { at_ms: 40, type: "pen_move", x: 200, y: 410, pressure: 0.8 },
      { at_ms: 80, type: "pen_move", x: 260, y: 420, pressure: 0.8 }, { at_ms: 120, type: "pen_up", x: 260, y: 420 }] }));
    const journal = (await fixture.journal()).slice(since);
    console.log(journal.map(entry => JSON.stringify(entry)).join("\n"));
    expect(journal).toContainEqual(expect.objectContaining({ type: "pointerdown", pointerType: "mouse", shift: true }));
    expect(journal.filter(entry => entry.type === "pointerdown" && entry.pointerType === "mouse").length).toBeGreaterThanOrEqual(4);
    expect(journal).toContainEqual(expect.objectContaining({ type: "wheel", deltaY: 200 }));
    expect(journal).toContainEqual(expect.objectContaining({ type: "pointermove", pointerType: "mouse", buttons: 1 }));
    const held = journal.filter(entry => entry.key === "w");
    expect(held.map(entry => entry.type)).toEqual(["keydown", "keyup"]);
    expect(journal).toContainEqual(expect.objectContaining({ type: "pointerdown", pointerType: "pen", pressure: 0.8, tiltX: 20 }));
  } finally { await deleteComputer(live.resources, window, { path: window }, live.cwd); }
});

test("the same vocabulary drives a browser page through Playwright by locator and page ref", async () => {
  const opened = await live.insert(live.machine, { action: "open_browser", url: `${fixture.base}/wait` });
  expect(opened.details.status, JSON.stringify(opened.content)).toBe("observed");
  const window = `computer:window/${opened.details.window_ref}`;
  try {
    expect((await act(window, typePlan({ window, target: "getByLabel('Name')", text: "Ada" }))).result.details.status).toBe("delivered");
    // A native Read and a DOM Read of one window keep each other: the browser's own Reload button stays a usable ref.
    const reload = /button "Reload" \[ref=([0-9a-z]+:[a-z]+)\]/.exec(presentComputerResult(await live.read(window, ["aria"])))![1];
    expect((await live.read(window, ["dom"])).details.status).toBe("observed");
    const reloaded = await act(window, clickPlan({ window, target: reload }));
    expect(reloaded.result.details.status, reloaded.body).toBe("delivered");
    expect((await act(window, typePlan({ window, target: "getByLabel('Name')", text: "Ada", replace: true }))).result.details.status).toBe("delivered");
    const dom = presentComputerResult(await live.read(window, ["dom"]));
    const save = /button "Save" \[ref=((?:f\d+)?e\d+)\]/.exec(dom)![1];
    const clicked = await act(window, clickPlan({ window, target: save }));
    expect(clicked.result.details.status, clicked.body).toBe("delivered");
    expect(await holds(window, [{ target: { text: "saved Ada" }, is: "visible" }])).toBe("satisfied");
    expect((await act(window, typePlan({ window, target: "getByLabel('Name')", text: "Grace", replace: true, submit: true }))).result.details.status).toBe("delivered");
    expect((await act(window, pressPlan({ window, key: "ctrl+a" }))).result.details.status).toBe("delivered");
    expect((await act(window, hoverPlan({ window, target: "getByRole('button', { name: 'Unlock later' })" }))).result.details.status).toBe("delivered");
    expect((await act(window, scrollPlan({ window, delta_y: 2 }))).result.details.status).toBe("delivered");
    const refused = await live.resources.input(requireComputerAddress(window), live.cwd, timelinePlan({ window, events: [{ at_ms: 0, type: "move_relative", dx: 5, dy: 0 }] })).catch((error: Error) => error.message);
    expect(String(refused)).toContain("move_relative needs native input");
  } finally { await deleteComputer(live.resources, window, { path: window }, live.cwd); }
});
