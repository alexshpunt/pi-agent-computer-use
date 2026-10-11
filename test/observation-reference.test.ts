import { expect, test, vi } from "vitest";
import { ComputerSession, type Driver } from "../src/session.ts";

test("checking an issued observation never acquires another native snapshot or extends input authority", async () => {
  let alive = true; let mode: "yolo" | "safe" = "yolo";
  const driver: Driver = {
    identity: vi.fn(async () => alive ? "native-life" : undefined), close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async (name, args) => ({ content: [], structuredContent: name === "list_windows"
      ? { windows: [{ pid: 42, window_id: 91 }] }
      : name === "get_window_state"
        ? { pid: 42, window_id: args.window_id, snapshot_id: "native-snapshot", elements_complete: true,
          elements: [{ element_token: "native-snapshot:0", label: "Input", role: "Edit", enabled: true }] }
        : { effect: "confirmed" } })),
  };
  const session = new ComputerSession(driver, () => mode);
  const rows = (await session.windows()).details.state!.windows as { window_ref: string }[];
  const target = { window_ref: rows[0].window_ref };
  const read = await session.observe(target.window_ref, undefined, undefined, undefined, undefined, { granularity: "ui" });
  expect(read.details.status).toBe("observed");
  const id = read.details.observation_id!;
  const captures = () => vi.mocked(driver.call).mock.calls.filter(([name]) => name === "get_window_state");
  const checked = await session.checkObservation(target, id);
  expect(checked.details.status).toBe("observed");
  expect(checked.content.some(block => block.type === "image")).toBe(false);
  expect(captures()).toHaveLength(1);
  expect((await session.checkObservation(target, "not-issued")).details.status).toBe("refused");
  mode = "safe";
  expect((await session.checkObservation(target, id)).details.status).toBe("refused");
  mode = "yolo"; alive = false;
  expect((await session.checkObservation(target, id)).details.status).toBe("refused");
  expect(captures()).toHaveLength(1);
});
