import { afterAll, expect, test } from "vitest";
import { displaySource, computerSource } from "../../src/computer-address.ts";
import { presentComputerResult } from "../../src/provider.ts";
import { addresses, connectLive, nativeForm, openWindow, text, WINDOWS_POWERSHELL_PATH } from "./remote.ts";

// LPT-924, LPT-929: sequences of a configured machine's windows and displays are captured there, their frames are
// read there, and every receipt names that machine.
const live = await connectLive();
const name = process.env.LIVE_MACHINE ?? "lab";
afterAll(() => live.close());

const images = (result: { content: { type: string }[] }) => result.content.filter(block => block.type === "image").length;

test("a window sequence on the machine returns its frames", async () => {
  const title = `pi-sequence-${Date.now()}`;
  const window = await openWindow(live, live.machine, WINDOWS_POWERSHELL_PATH, nativeForm(title), title);
  try {
    const captured = await live.read(window, ['sequence:{"duration_ms":1000,"fps":5,"maxLongEdge":320}']);
    expect(captured.details.status, text(captured)).toBe("observed");
    expect(captured.details.machine).toBe(name);
    const frames = await live.read(computerSource("sequence", captured.details.sequence!.sequence_id), ["frames:endpoints"]);
    expect(frames.details.status, text(frames)).toBe("observed");
    expect(frames.details.machine).toBe(name);
    expect(images(frames)).toBe(2);
    expect(presentComputerResult(frames)).toMatch(new RegExp(`^Computer observed \\(yolo\\) on ${name}\\n`));
  } finally {
    const state = await live.read(window, ["state"]).catch(() => undefined);
    const target = state?.details.target as { window_id?: number } | undefined;
    if (target?.window_id) await live.closeWindow(target.window_id);
  }
});

test("the machine's primary and listed displays are captured there, with readable frames", async () => {
  const primary = displaySource(name, "primary");
  const overview = await live.read(primary, ['capture:{"maxLongEdge":320}']);
  expect(overview.details.status, text(overview)).toBe("observed");
  expect(overview.details.machine).toBe(name);
  const listed = await live.read(live.displays);
  const [display] = addresses(listed, "display");
  expect(display).toMatch(new RegExp(`^computer:machine/${name}/display/d-`));
  for (const source of [primary, display]) {
    const captured = await live.read(source, ['sequence:{"duration_ms":600,"fps":5,"maxLongEdge":320}']);
    expect(captured.details.status, text(captured)).toBe("observed");
    expect(captured.details.machine).toBe(name);
    const frames = await live.read(computerSource("sequence", captured.details.sequence!.sequence_id), ["frames:last"]);
    expect(frames.details.status, text(frames)).toBe("observed");
    expect(images(frames)).toBe(1);
  }
  // A display reference of this machine is unknown on another one.
  if (name !== "local") {
    // This harness forbids the local session, so reaching it throws; a real local session refuses the unknown reference.
    const elsewhere = await live.read(display.replace(`:machine/${name}/`, ":machine/local/")).catch((error: Error) => error);
    expect(elsewhere instanceof Error ? elsewhere.message : elsewhere.details.status).toMatch(/Live checks use only the remote machine|refused/);
  }
});
