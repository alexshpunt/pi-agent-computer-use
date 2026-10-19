import { afterAll, expect, test } from "vitest";
import { addresses, connectLive, text } from "./remote.ts";

const live = await connectLive();
afterAll(() => live.close());

test("regular-expression Search lists the machine's windows", async () => {
  const all = await live.search(live.machine, "regex:.");
  expect(addresses(all, "window").length).toBeGreaterThan(0);
});

test("an executable name that is not installed suggests the display name", async () => {
  const missed = await live.insert(live.machine, { action: "open", app: "mspaint" });
  expect(missed.details.status).toBe("refused");
  expect(text(missed)).toMatch(/Did you mean: .*Paint/);
});

test("a display overview takes a per-Read size", async () => {
  const display = addresses(await live.read(live.machine), "display")[0];
  const small = await live.read(display, ['capture:{"maxLongEdge":320}']);
  expect(small.details.agent_image).toMatchObject({ output: { width: 320 } });
});

test("set_value on a delivery-preference address reaches the slider", async () => {
  const opened = await live.insert(live.machine, { action: "open", app: "Paint" });
  const window = `computer:window/${opened.details.window_ref}`;
  try {
    const view = await live.read(window, ["ui"]);
    const size = view.details.ui!.elements.find(element => element.role === "Slider" && element.name === "Size")!;
    const done = await live.insert(`computer:observation/${view.details.observation_id}?hint=${encodeURIComponent(size.hint)}&delivery=foreground`,
      { action: "set_value", text: "20" });
    // Paint's Size slider is read-only through UIA, so the driver itself answers; the adapter no longer refuses first.
    expect(text(done)).not.toMatch(/accessibility only/);
    expect(done.details.state).toMatchObject({ route: "accessibility", native_message: "semantic_element_read_only" });
  } finally {
    const view = await live.read(window, ["ui"]);
    await live.insert(`computer:observation/${view.details.observation_id}`, { action: "hotkey", keys: ["alt", "f4"], delivery_mode: "foreground" });
  }
});
