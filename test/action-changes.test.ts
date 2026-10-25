import { expect, test, vi } from "vitest";
import { computerSource } from "../src/computer-address.ts";
import { ComputerResources, requireComputerAddress } from "../src/computer-resources.ts";
import { presentComputerResult } from "../src/provider.ts";
import { ComputerSession, type Driver } from "../src/session.ts";

const cwd = "/synthetic-action-changes";
const address = requireComputerAddress;

// LPT-914: every action reports what changed in the window, like Playwright MCP's incremental snapshots.
async function fixture() {
  let count = 0, serial = 0;
  const element = (index: number, role: string, label: string) => ({ element_token: `s${serial}:${index}`, role, label, enabled: true, actions: role === "Button" ? ["invoke"] : [],
    frame: { x: 100 + index * 50, y: 100, w: 40, h: 20 }, screenshot_frame: { x: 20 + index * 50, y: 10, w: 40, h: 20 } });
  const driver: Driver = {
    identity: vi.fn(async () => "life"), close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async (name, args) => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid: 42, window_id: 91 }] } };
      if (name === "get_window_state") {
        serial++;
        return { content: [], structuredContent: { pid: 42, window_id: 91, snapshot_id: `s${serial}`, window_bounds: { x: 80, y: 90, width: 500, height: 320 },
          elements_complete: true, elements: [element(0, "Button", `Count ${count}`), element(1, "Text", "Status")] } };
      }
      // Clicking the button counts; clicking the status label does nothing.
      if (name === "click") { if (String((args as { element_token?: string }).element_token).endsWith(":0")) count++; return { content: [], structuredContent: { effect: "confirmed" } }; }
      throw Error(`Unexpected native call ${name}`);
    }),
  };
  const session = new ComputerSession(driver, () => "yolo");
  const resources = new ComputerResources(async () => session, async () => session.close());
  const ref = ((await session.windows()).details.state!.windows as { window_ref: string }[])[0].window_ref;
  const window = computerSource("window", ref);
  const read = async () => {
    const view = (await resources.read(address(window), cwd, ["ui"]))!;
    return { view, at: (index: number) => address(`${computerSource("observation", view.details.observation_id!)}?hint=${encodeURIComponent(view.details.ui!.elements[index].hint)}`) };
  };
  const walks = () => vi.mocked(driver.call).mock.calls.filter(([name]) => name === "get_window_state").length;
  return { resources, window, read, walks };
}

test("an action reports what it changed by default, and its successor is the current observation", async () => {
  const f = await fixture(), { at } = await f.read();
  const result = await f.resources.perform(at(0), cwd, JSON.stringify({ action: "click" }), "insert");
  const shown = presentComputerResult(result);
  expect(shown).toMatch(/Changes: 1 changed, 0 added, 0 removed\n~ \d+:a Button "Count 0" → "Count 1"/);
  expect(f.resources.grantsAuthority(address(computerSource("observation", result.details.successor!.observation_id!)))).toBe(true);
});

test("an action that changes nothing says so after looking again for a moment", async () => {
  const f = await fixture(), { at } = await f.read();
  const result = await f.resources.perform(at(1), cwd, JSON.stringify({ action: "click" }), "insert");
  expect(result.details.successor?.diff?.waited_ms).toBeGreaterThanOrEqual(300);
  expect(presentComputerResult(result)).toMatch(/Nothing changed in the UI within \d+ ms after the action\. Check that the target was right/);
});

test("successor false turns the change list off for one call", async () => {
  const f = await fixture(), { at } = await f.read();
  const before = f.walks();
  const result = await f.resources.perform(at(0), cwd, JSON.stringify({ action: "click", successor: false }), "insert");
  expect(result.details.status).toBe("delivered");
  expect(result.details.successor).toBeUndefined();
  expect(f.walks()).toBe(before);
});

test("a locator action on the window address compares with the walk that resolved its target", async () => {
  const f = await fixture();
  const result = await f.resources.perform(address(f.window), cwd, JSON.stringify({ action: "click", target: "getByRole('button', { name: /Count/ })" }), "insert");
  expect(result.details.successor?.diff?.changed).toEqual([expect.stringMatching(/Button "Count 0" → "Count 1"$/)]);
});

test("each batch step says what it changed, and the batch reports the change from its start", async () => {
  const f = await fixture(), { view } = await f.read();
  const result = await f.resources.perform(address(computerSource("observation", view.details.observation_id!)), cwd, JSON.stringify({ action: "batch", steps: [
    { action: "click", target: "getByRole('button', { name: /Count/ })" },
    { action: "click", target: "getByText('Status')" },
    { action: "click", target: "getByRole('button', { name: /Count/ })" },
  ] }), "insert");
  expect(result.details.batch?.steps.map(step => step.changes)).toEqual([{ changed: 1, added: 0, removed: 0 }, { changed: 0, added: 0, removed: 0 }, undefined]);
  expect(presentComputerResult(result)).toMatch(/Step 0: click → delivered; 1 changed, 0 added, 0 removed\nStep 1: click → delivered; nothing changed\n/);
  expect(result.details.successor?.diff?.changed).toEqual([expect.stringMatching(/Button "Count 0" → "Count 2"$/)]);
});
