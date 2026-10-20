import { expect, test, vi } from "vitest";
import { ComputerSession, type ComputerMode, type Driver, type DriverResult } from "../src/session.ts";
import { displayMode, type DisplayModes } from "../src/display-mode.ts";
import { MachineHost } from "../src/machine-host.ts";

const primary = { display_id: "\\\\.\\DISPLAY1", monitor_handle: "0x10001", monitor_device_paths: ["native-primary"],
  bounds: { x: 0, y: 0, width: 3840, height: 2560 }, work_area: { x: 0, y: 0, width: 3840, height: 2500 }, primary: true, scale_factor: 1.5, dpi: null };

function fixture() {
  let mode: ComputerMode = "yolo";
  let current = { width: 3840, height: 2560 };
  const modes = {
    set: vi.fn<DisplayModes["set"]>(async (_monitor, next) => { const previous = current; current = next; return { device: "\\\\.\\DISPLAY1", previous, current: next }; }),
    restore: vi.fn<DisplayModes["restore"]>(async (_device, next) => { current = next; }),
  };
  const driver = {
    selectedDisplays: true,
    call: vi.fn<Driver["call"]>(async (name): Promise<DriverResult> => {
      if (name === "list_displays") return { content: [], structuredContent: { platform: "windows", topology_id: "t1", displays: [primary] } };
      throw new Error(`Unexpected native call ${name}`);
    }), identity: vi.fn(async () => "unused"), close: vi.fn(async () => {}),
  };
  const session = new ComputerSession(driver, () => mode, undefined, undefined, undefined, undefined, new MachineHost({ run: vi.fn(), spawn: vi.fn() }, modes));
  const ref = async () => ((await session.displays()).details.state!.displays as { display_ref: string }[])[0].display_ref;
  return { session, modes, driver, ref, current: () => current, setMode(value: ComputerMode) { mode = value; } };
}

test("resizing a display changes its native monitor and closing the session restores the original mode once", async () => {
  const f = fixture();
  const first = await f.ref();
  expect((await f.session.resizeDisplay(first, { width: 2160, height: 1440 })).details.status).toBe("delivered");
  expect(f.modes.set).toHaveBeenLastCalledWith("0x10001", { width: 2160, height: 1440 }, undefined);
  // Old references describe the old geometry and stop working.
  expect((await f.session.resizeDisplay(first, { width: 1920, height: 1080 })).details.status).toBe("refused");
  expect((await f.session.resizeDisplay(await f.ref(), { width: 1920, height: 1080 })).details.status).toBe("delivered");
  await f.session.close();
  expect(f.modes.restore).toHaveBeenCalledExactlyOnceWith("\\\\.\\DISPLAY1", { width: 3840, height: 2560 });
  expect(f.current()).toEqual({ width: 3840, height: 2560 });
});

test("returning to the original mode needs no restore on close", async () => {
  const f = fixture();
  await f.session.resizeDisplay(await f.ref(), { width: 2160, height: 1440 });
  await f.session.resizeDisplay(await f.ref(), { width: 3840, height: 2560 });
  await f.session.close();
  expect(f.modes.restore).not.toHaveBeenCalled();
});

test("Safe mode, unknown displays and failed changes leave the display alone", async () => {
  const f = fixture();
  const ref = await f.ref();
  f.setMode("safe");
  expect((await f.session.resizeDisplay(ref, { width: 2160, height: 1440 })).details.status).toBe("refused");
  f.setMode("yolo");
  expect((await f.session.resizeDisplay("d-unknown", { width: 2160, height: 1440 })).details.status).toBe("refused");
  expect(f.modes.set).not.toHaveBeenCalled();
  f.modes.set.mockRejectedValueOnce(new Error("\\\\.\\DISPLAY1 has no 1234x777 mode. Supported: 1920x1080."));
  const refused = await f.session.resizeDisplay(ref, { width: 1234, height: 777 });
  expect(refused.details.status).toBe("refused");
  expect(refused.content[0]).toMatchObject({ text: expect.stringContaining("Supported: 1920x1080") });
  await f.session.close();
  expect(f.modes.restore).not.toHaveBeenCalled();
});

test("resize sizes are whole physical pixels within display limits", () => {
  expect(displayMode({ width: 2160, height: 1440 })).toEqual({ width: 2160, height: 1440 });
  for (const bad of [{ width: 2160.5, height: 1440 }, { width: 320, height: 240 }, { width: "1920", height: 1080 }, { width: 20000, height: 1440 }])
    expect(() => displayMode(bad)).toThrow();
});
