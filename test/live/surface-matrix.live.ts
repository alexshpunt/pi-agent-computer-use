import { afterAll, expect, test } from "vitest";
import { addresses, connectLive, nativeForm, openWindow, serveFixture, text, WINDOWS_POWERSHELL_PATH as POWERSHELL } from "./remote.ts";
import { computerSource } from "../../src/computer-address.ts";

// LPT-628: a live capability matrix of every execution surface on one Windows machine, with cross-surface checks.
// Surfaces: the machine's displays, a background host window, an owned browser, a Windows Sandbox and an isolated
// agent session. Each native surface gets its own disposable WinForms target with its own text, so an action that
// leaked into a neighbour would show up there. The host target only takes background input; foreground input
// would take the human's foreground.
const live = await connectLive();
const fixture = await serveFixture(live.runner);
const cleanup: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const step of cleanup.reverse()) await step().catch(() => undefined);
  await live.close(); fixture.close();
});
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const timed = async <T>(run: () => Promise<T>) => { const started = performance.now(); const value = await run(); return { value, ms: Math.round(performance.now() - started) }; };
type Element = { role?: string | null; name?: string | null; hint: string; value?: unknown };
const field = (elements: Element[]) => elements.find(e => e.role === "Edit");
/** A refusal is either a refused result or a request error; both send nothing. */
const outcome = (result: Promise<{ details: { status?: string } }>) =>
  result.then(r => String(r.details.status), (error: Error) => `error: ${error.message.slice(0, 120)}`);
const domainOf = (state: unknown) => [...new Set((JSON.parse(JSON.stringify(state)).windows as { source_identity?: { domain?: string } }[]).map(w => w.source_identity?.domain))];

test("every surface observes and acts only on itself, and refuses resources of the others", async () => {
  const matrix: Record<string, Record<string, unknown>> = {};
  const observe = async (window: string, views: string[]) => {
    const samples: number[] = [];
    let last;
    for (let i = 0; i < 3; i++) { const r = await timed(() => live.read(window, views)); samples.push(r.ms); last = r.value; }
    return { median: median(samples), last: last! };
  };

  // Displays: readonly pixels; any input into a display observation refuses.
  const displays = addresses(await live.read(live.machine), "display");
  for (const [index, display] of displays.entries()) {
    const seen = await observe(display, []);
    const id = seen.last.details.observation_id ?? seen.last.details.agent_image?.image_id;
    const input = await outcome(live.insert(`computer:observation/${id}`, { action: "click", x: 5, y: 5 }));
    matrix[`display ${index}`] = { observe_ms: seen.median, input };
    expect(input).not.toMatch(/delivered|unknown/);
  }

  // Native surfaces, each with its own target.
  const sandboxResult = await live.insert(live.machine, { action: "open_sandbox" });
  expect(sandboxResult.details.status, text(sandboxResult)).toBe("delivered");
  const sandbox = computerSource("sandbox", sandboxResult.details.sandbox_ref!);
  cleanup.push(() => live.insert(sandbox, { action: "close" }));
  const sessionResult = await live.insert(live.machine, { action: "open_session" });
  expect(sessionResult.details.status, text(sessionResult)).toBe("delivered");
  const session = computerSource("sandbox", sessionResult.details.sandbox_ref!);
  cleanup.push(() => live.insert(session, { action: "close" }));

  const surfaces = [
    { name: "host window", source: live.machine, domain: "windows-remote", delivery: "background" },
    { name: "sandbox", source: sandbox, domain: "windows-sandbox", delivery: "foreground" },
    { name: "session", source: session, domain: "windows-session", delivery: "foreground" },
  ] as const;
  const windows: Record<string, string> = {};
  const openMs: Record<string, number> = {};
  for (const surface of surfaces) {
    const title = `MATRIX ${surface.name}`;
    const opened = await timed(() => openWindow(live, surface.source, POWERSHELL, nativeForm(title), title));
    windows[surface.name] = opened.value;
    openMs[surface.name] = opened.ms;
    if (surface.name === "host window") {
      const pid = (JSON.parse(JSON.stringify((await live.search(live.machine, title)).details.state)).windows as { pid: number }[])[0].pid;
      cleanup.push(() => live.kill(pid));
    }
  }
  for (const surface of surfaces) {
    const window = windows[surface.name];
    const seen = await observe(window, ["image"]);
    expect(seen.last.details.source_identity?.domain).toBe(surface.domain);
    const view = await live.read(window, ["ui"]);
    const target = field(view.details.ui!.elements as Element[])!;
    const typed = await timed(() => live.write(`computer:observation/${view.details.observation_id}?hint=${encodeURIComponent(target.hint)}&delivery=${surface.delivery}`, `${surface.domain}-mark`));
    expect(typed.value.details.status, text(typed.value)).toBe("delivered");
    // Search on each surface lists only that surface's windows.
    expect(domainOf((await live.search(surface.source, "regex:.")).details.state)).toEqual([surface.domain]);
    matrix[surface.name] = { open_ms: openMs[surface.name], observe_ms: seen.median, type_ms: typed.ms, delivery: surface.delivery, domain: surface.domain };
  }

  // Owned browser: Playwright DOM actions on its own page.
  const browserResult = await live.insert(live.machine, { action: "open_browser", browser: "msedge", url: `${fixture.base}/input` });
  expect(browserResult.details.status, text(browserResult)).toBe("observed");
  const browser = `computer:window/${browserResult.details.window_ref}`;
  const dom = await observe(browser, ["dom"]);
  const before = (await fixture.journal()).length;
  const pressed = await timed(() => live.insert(`computer:observation/${dom.last.details.observation_id}`, { action: "press", key: "q" }));
  expect(pressed.value.details.status, text(pressed.value)).toBe("delivered");
  const keys = (await fixture.journal()).slice(before).filter(e => e.type === "keydown").map(e => e.key);
  expect(keys).toEqual(["q"]);
  matrix.browser = { observe_ms: dom.median, press_ms: pressed.ms, delivery: "playwright" };

  // Each target holds exactly its own text: no action leaked into a neighbour.
  for (const surface of surfaces) {
    const view = await live.read(windows[surface.name], ["ui"]);
    expect(field(view.details.ui!.elements as Element[])?.value, surface.name).toBe(`${surface.domain}-mark`);
  }

  // Cross-surface refusals.
  const refused = (value: string) => expect(value).not.toMatch(/observed|delivered|unknown/);
  const domOnGuest = await outcome(live.read(windows.sandbox, ["dom"]));
  const latestDom = await live.read(browser, ["dom"]);
  const nativeOnDom = await outcome(live.write(`computer:observation/${latestDom.details.observation_id}`, "x"));
  matrix.refusals = { dom_on_guest_window: domOnGuest, native_write_on_dom: nativeOnDom };
  refused(domOnGuest); refused(nativeOnDom);
  // A reference no open surface knows falls to the local host session, which refuses an unknown window. This
  // harness forbids the local session, so its guard error proves that no open surface resolved the reference.
  const unclaimed = (value: string) => expect(value).toMatch(/Live checks use only the remote machine/);
  // A second agent cannot use the first agent's window reference.
  const other = await connectLive();
  try {
    const foreign = await outcome(other.read(windows.session, ["image"]));
    matrix.refusals = { ...matrix.refusals, foreign_agent_ref: foreign };
    unclaimed(foreign);
  } finally { await other.close(); }
  // A closed sandbox's window reference is gone.
  await live.insert(sandbox, { action: "close" });
  const closed = await outcome(live.read(windows.sandbox, ["image"]));
  matrix.refusals = { ...matrix.refusals, closed_sandbox_ref: closed };
  unclaimed(closed);
  // The session kept working after its neighbour closed.
  expect((await live.read(windows.session, ["image"])).details.observation_id).toBeTruthy();

  console.log("MATRIX " + JSON.stringify(matrix, null, 1));
});
