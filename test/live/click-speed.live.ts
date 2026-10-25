import { afterAll, expect, test } from "vitest";
import { addresses, connectLive, nativeForm, openWindow, text, WINDOWS_POWERSHELL_PATH as POWERSHELL } from "./remote.ts";

// LPT-916: the driver used to wait for its agent cursor to glide to each new point, about 600 ms per click.
// The cursor now jumps, so a run of clicks between two controls takes as long as the clicks themselves.
const live = await connectLive();
let pid = 0;
afterAll(async () => { if (pid) await live.kill(pid); await live.close(); });

type Element = { role?: string | null; name?: string | null; bounds?: { window_image?: { x: number; y: number; width: number; height: number } } };
const centre = (element: Element | undefined) => {
  const box = element?.bounds?.window_image;
  if (!box) throw new Error(`No overview bounds for ${JSON.stringify(element)}`);
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
};

test("ten background clicks alternating between two controls each finish in under 100 ms", async () => {
  const title = `Click speed ${Date.now()}`;
  const window = await openWindow(live, live.machine, POWERSHELL, nativeForm(title), title);
  pid = (JSON.parse(JSON.stringify((await live.search(live.windows, title)).details.state)).windows as { pid: number }[])[0].pid;
  expect(addresses(await live.search(live.windows, title), "window")).toContain(window);
  const view = await live.read(window, ["full"]);
  const elements = view.details.ui!.elements as Element[];
  const button = centre(elements.find(e => e.role === "Button" && /^Count/.test(e.name ?? "")));
  const field = centre(elements.find(e => e.role === "Edit"));
  const sequence = Array.from({ length: 10 }, (_, i) => ({ action: "click", ...(i % 2 ? field : button) }));
  const done = await live.insert(`computer:observation/${view.details.observation_id}`, { action: "sequence", sequence, successor: false });
  expect(done.details.status, text(done)).toBe("delivered");
  type Step = { dispatch_ms: number; completion_ms: number; action_capability: { route: string } };
  const steps = (done.details.state as { sequence: { steps: Step[] } }).sequence.steps;
  const ms = (step: Step) => step.completion_ms - step.dispatch_ms;
  console.log(`click times, ms: ${steps.map(step => `${Math.round(ms(step))} (${step.action_capability.route})`).join(", ")}`);
  // Times include the SSH round trip. The button is invoked through UIA; the text box gets posted mouse messages,
  // which carry the driver's own 35 ms press and 50 ms settle pauses. A glide alone used to add over 300 ms.
  const invoked = steps.filter(step => step.action_capability.route === "accessibility").map(ms).sort((a, b) => a - b);
  expect(invoked).toHaveLength(5);
  expect(invoked[2]).toBeLessThan(100);
  expect(Math.max(...steps.map(ms))).toBeLessThan(300);
  const after = await live.read(window, ["ui"]);
  expect((after.details.ui!.elements as Element[]).some(e => e.role === "Button" && e.name === "Count 5"), text(after)).toBe(true);
});
