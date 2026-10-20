import { expect, test, vi } from "vitest";
import { computerSource } from "../src/computer-address.ts";
import { ComputerResources, requireComputerAddress } from "../src/computer-resources.ts";
import { ComputerSession, type Driver } from "../src/session.ts";

const cwd = "/synthetic-changes-fixture";

// LPT-837: a changes Read lists only what changed since the window's previous observation, with fresh hints.
test("a changes Read compares the window's UI with its previous observation", async () => {
  let text = "", serial = 0;
  const element = (index: number, role: string, label: string, value?: string) => ({ element_token: `s${serial}:${index}`, role, label, value, enabled: true,
    frame: { x: 100 + index * 50, y: 100, w: 40, h: 20 }, screenshot_frame: { x: 20 + index * 50, y: 10, w: 40, h: 20 } });
  const driver: Driver = {
    identity: vi.fn(async () => "life"), close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async name => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid: 42, window_id: 91 }] } };
      if (name === "get_window_state") {
        serial++;
        return { content: [], structuredContent: { pid: 42, window_id: 91, snapshot_id: `s${serial}`, window_bounds: { x: 80, y: 90, width: 500, height: 320 },
          elements_complete: true, elements: [element(0, "Button", "Save"), element(1, "Edit", "Text editor", text), element(2, "Button", "Close")] } };
      }
      throw Error(`Unexpected native call ${name}`);
    }),
  };
  const session = new ComputerSession(driver, () => "yolo");
  const resources = new ComputerResources(async () => session, async () => session.close());
  const ref = ((await session.windows()).details.state!.windows as { window_ref: string }[])[0].window_ref;
  const window = requireComputerAddress(computerSource("window", ref));

  const first = await resources.read(window, cwd, ["changes"]);
  expect(first!.details.changes).toEqual({ reason: expect.stringMatching(/full UI/) });
  expect(first!.details.captured).toEqual({ image: false, ui: true });

  const same = await resources.read(window, cwd, ["changes"]);
  expect(same!.details.changes).toMatchObject({ since: first!.details.observation_id, diff: { counts: { changed: 0, added: 0, removed: 0 } } });

  text = "hello";
  const typed = await resources.read(window, cwd, ["changes"]);
  const diff = typed!.details.changes!.diff!;
  expect(diff.counts).toEqual({ changed: 1, added: 0, removed: 0 });
  const editor = typed!.details.ui!.elements.find(e => e.name === "Text editor")!;
  // The listed hint is the new observation's and resolves to its element.
  expect(diff.changed[0]).toMatch(new RegExp(`^${editor.hint} Edit "Text editor": value="" .* → value="hello"`));
  expect(resources.grantsAuthority(requireComputerAddress(computerSource("observation", typed!.details.observation_id!)))).toBe(true);

  for (const views of [["changes", "image"], ["changes", "full"], ["changes", "ocr"]])
    await expect(resources.read(window, cwd, views)).rejects.toThrow();
  await expect(resources.read(requireComputerAddress(computerSource("observation", typed!.details.observation_id!)), cwd, ["changes"]))
    .rejects.toThrow(/window address/);
});
