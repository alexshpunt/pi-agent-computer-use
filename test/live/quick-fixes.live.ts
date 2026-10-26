import { afterAll, expect, test } from "vitest";
import { requireComputerAddress } from "../../src/computer-resources.ts";
import { pressPlan, typePlan } from "../../src/computer-tools.ts";
import { addresses, connectLive, text } from "./remote.ts";

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

test("computer_type replace with foreground reaches the slider through accessibility", async () => {
  const opened = await live.insert(live.machine, { action: "open", app: "Paint" });
  const window = `computer:window/${opened.details.window_ref}`;
  try {
    const view = await live.read(window, ["ui"]);
    const size = view.details.ui!.elements.find(element => element.role === "Slider" && element.name === "Size")!;
    const done = await live.resources.input(requireComputerAddress(window), live.cwd, typePlan({ window, target: size.hint, text: "20", replace: true, foreground: true }));
    // Paint's Size slider is read-only through UIA, so the driver itself answers; the adapter no longer refuses first.
    expect(text(done)).not.toMatch(/accessibility only/);
    expect(done.details.state).toMatchObject({ route: "accessibility", native_message: "semantic_element_read_only" });
  } finally {
    await live.resources.input(requireComputerAddress(window), live.cwd, pressPlan({ window, key: "alt+F4", foreground: true }));
  }
});
