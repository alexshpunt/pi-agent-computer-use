import { expect, test, vi } from "vitest";
import { ComputerSession, type Action, type Driver } from "../src/session.ts";
import { nativeInput, requestedInputTime, validateInput, type InputStep } from "../src/complete-input.ts";

const observed = { tokens: new Set(["field"]), width: 500, height: 350 };
const hold = (fields: Record<string, unknown> = {}) => ({ action: "hold", keys: ["w", "shift"], duration_ms: 500, ...fields }) as unknown as InputStep;

test("a bounded simultaneous hold uses one native call, not complete key presses", () => {
  const command = hold();
  expect(() => validateInput(command, observed)).not.toThrow();
  expect(nativeInput(command, { pid: 42, window_id: 100 }, "foreground")).toEqual({
    name: "hold_keys", args: { pid: 42, window_id: 100, delivery_mode: "foreground", keys: ["w", "shift"], duration_ms: 500 },
  });
  expect(requestedInputTime(command)).toBe(500);
});

test("the whole held-pointer request is grounded before any input and copied for admission", () => {
  const command = hold({ keys: ["shift"], actions: [
    { action: "click", x: 10, y: 20 },
    { action: "drag", from_x: 10, from_y: 20, via: [{ x: 50, y: 70 }], to_x: 100, to_y: 20, duration_ms: 200 },
  ] });
  expect(() => validateInput(command, observed)).not.toThrow();
  expect(nativeInput(command, { pid: 42, window_id: 100 }, "foreground").args.actions).toEqual((command as unknown as { actions: unknown }).actions);
});

test.each([
  { keys: [] }, { keys: ["w", "w"] }, { keys: ["hyper"] }, { duration_ms: 0 }, { duration_ms: 10001 },
  { duration_ms: 500, actions: [{ action: "drag", from_x: 1, from_y: 2, to_x: 3, to_y: 4, duration_ms: 501 }] },
  { actions: [{ action: "click", x: 500, y: 20 }] },
  { actions: [{ action: "click", element_token: "field" }] },
  { actions: [{ action: "key", key: "a" }] },
  { actions: [{ action: "drag", from_x: 1, from_y: 2, via: [{ x: 3, y: NaN }], to_x: 4, to_y: 5 }] },
  { actions: Array.from({ length: 33 }, () => ({ action: "click", x: 1, y: 2 })) },
  { actions: [{ action: "click", x: 1, y: 2, modifiers: ["ctrl"] }] },
])("malformed hold refuses all input: %j", fields => {
  expect(() => validateInput(hold(fields), observed)).toThrow();
});

test("holds cannot nest in the existing complete-step sequence", () => {
  expect(() => validateInput(hold(), observed, true)).toThrow();
});

async function fixture(heldKeys = true) {
  const driver: Driver = {
    heldKeys, heldPaths: true, identity: vi.fn(async () => "alive"), close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async name => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid: 42, window_id: 100 }] } };
      if (name === "get_window_state") return { content: [{ type: "image", mimeType: "image/png", data: "cG5n" }], structuredContent: {
        screenshot_width: 500, screenshot_height: 350, elements: [],
      } };
      return { content: [], structuredContent: { effect: "partial", summary: "Windows key hold: keys_released=false, held_ms=200, pointer_prefix=[(1, true, false)]." } };
    }),
  };
  const session = new ComputerSession(driver);
  const windows = await session.windows();
  const ref = (windows.details.state!.windows as { window_ref: string }[])[0].window_ref;
  const view = await session.observe(ref);
  expect(view.details.status).toBe("observed");
  const base = { window_ref: ref, observation_id: view.details.observation_id! };
  return { driver, session, base };
}

test("an old runtime refuses a key hold without consuming its overview or dispatching", async () => {
  const f = await fixture(false);
  f.driver.call = vi.fn(async () => ({ content: [], structuredContent: { effect: "unverifiable" } }));
  const result = await f.session.act({ ...f.base, ...hold() } as Action);
  expect(result.details.status).toBe("refused"); expect(f.driver.call).not.toHaveBeenCalled();
  expect((await f.session.act({ ...f.base, action: "key", key: "a" })).details.status).toBe("delivered");
});

test("a partial held gesture keeps release uncertainty visible and cannot replay its overview", async () => {
  const f = await fixture();
  f.driver.call = vi.fn(async () => ({ content: [], structuredContent: {
    effect: "partial", summary: "Windows key hold: keys_released=false, held_ms=200, pointer_prefix=[(1, true, false)].",
  } }));
  const command = { ...f.base, ...hold({ keys: ["shift"], actions: [{ action: "click", x: 10, y: 20 }] }), delivery_mode: "foreground" } as Action;
  const result = await f.session.act(command);
  expect(result.details.status).toBe("unknown");
  const message = result.content[0];
  expect(message.type).toBe("text");
  if (message.type === "text") expect(message.text.split("\n{")[0]).toContain("keys_released=false");
  expect((await f.session.act(command)).details.status).toBe("refused");
  expect(f.driver.call).toHaveBeenCalledTimes(1);
});

test("held pointer points cannot change during native admission", async () => {
  const f = await fixture();
  const command = { ...f.base, ...hold({ keys: ["shift"], actions: [{ action: "drag", from_x: 10, from_y: 20, via: [{ x: 50, y: 60 }], to_x: 70, to_y: 80, duration_ms: 200 }] }), delivery_mode: "foreground" } as Action;
  f.driver.identity = vi.fn(async () => {
    if (command.action !== "sequence") {
      command.keys![0] = "ctrl"; command.actions![0].via![0].x = 1000;
    }
    return "alive";
  });
  f.driver.call = vi.fn(async () => ({ content: [], structuredContent: { effect: "unverifiable" } }));
  await f.session.act(command);
  expect(f.driver.call).toHaveBeenCalledExactlyOnceWith("hold_keys", {
    pid: 42, window_id: 100, delivery_mode: "foreground", keys: ["shift"], duration_ms: 500,
    actions: [{ action: "drag", from_x: 10, from_y: 20, via: [{ x: 50, y: 60 }], to_x: 70, to_y: 80, duration_ms: 200 }],
  }, undefined);
});
