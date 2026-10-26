import { afterAll, expect, test } from "vitest";
import { requireComputerAddress } from "../../src/computer-resources.ts";
import { clickPlan, pressPlan, typePlan } from "../../src/computer-tools.ts";
import { addresses, connectLive, nativeForm, openWindow, text, WINDOWS_POWERSHELL_PATH } from "./remote.ts";

const live = await connectLive();
afterAll(() => live.close());

test("regular-expression Search lists the machine's windows", async () => {
  const all = await live.search(live.windows, "regex:.");
  expect(addresses(all, "window").length).toBeGreaterThan(0);
});

test("an executable name that is not installed suggests the display name", async () => {
  const missed = await live.insert(live.machine, { action: "open", app: "mspaint" });
  expect(missed.details.status).toBe("refused");
  expect(text(missed)).toMatch(/Did you mean: .*Paint/);
});

test("a display overview takes a per-Read size", async () => {
  const display = addresses(await live.read(live.displays), "display")[0];
  const small = await live.read(display, ['capture:{"maxLongEdge":320}']);
  expect(small.details.agent_image).toMatchObject({ output: { width: 320 } });
});

test("computer_type replace reaches the slider through accessibility", async () => {
  const opened = await live.insert(live.machine, { action: "open", app: "Paint" });
  const window = `computer:window/${opened.details.window_ref}`;
  try {
    const view = await live.read(window, ["ui"]);
    const size = view.details.ui!.elements.find(element => element.role === "Slider" && element.name === "Size")!;
    const done = await live.resources.input(requireComputerAddress(window), live.cwd, typePlan({ window, target: size.hint, text: "20", replace: true }));
    // Paint's Size slider is read-only through UIA, so the driver itself answers; the adapter no longer refuses first.
    expect(text(done)).not.toMatch(/accessibility only/);
    expect(done.details.state).toMatchObject({ route: "accessibility", native_message: "semantic_element_read_only" });
  } finally {
    await live.resources.input(requireComputerAddress(window), live.cwd, pressPlan({ window, key: "alt+F4" }));
  }
});

// LPT-941: a refused region Read spends the window's observation; a point click then captures the window again.
test("a point click after a refused region Read captures the window again", async () => {
  const title = `pi-spent-${Date.now()}`;
  const window = await openWindow(live, live.machine, WINDOWS_POWERSHELL_PATH, nativeForm(title), title);
  try {
    const view = await live.read(window, ["image"]);
    await live.read(`computer:observation/${view.details.observation_id}`, ["region:5000,5000,10,10"]).catch(() => undefined);
    const clicked = await live.resources.input(requireComputerAddress(window), live.cwd, clickPlan({ window, x: 200, y: 250 }));
    // The click is real input; right after an app starts, Windows can still hand the foreground back to another window,
    // and the driver then answers unknown. What this checks is that the spent observation no longer refuses the click.
    expect(clicked.details.status, text(clicked)).not.toBe("refused");
    expect(text(clicked)).not.toMatch(/expired/);
  } finally {
    await live.resources.delete(`${window}?force=true`, live.cwd);
  }
});
