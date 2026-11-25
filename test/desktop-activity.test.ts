import { describe, expect, it, vi } from "vitest";
import { DesktopActivity, type DesktopActivityMessage } from "../src/desktop-activity.ts";
import { VisualSettings } from "../src/native-visuals.ts";

const background = { kind: "type" as const, location: "desktop" as const, delivery: "unknown" as const };
function fixture() {
  const settings = new VisualSettings();
  const activity = new DesktopActivity(settings, () => "Editor agent");
  const send = vi.fn(async (_args: DesktopActivityMessage) => true);
  const connection = { send };
  activity.attach(connection);
  return { settings, activity, connection, send, messages: () => send.mock.calls.map(([message]) => message) };
}

describe("Windows desktop activity", () => {
  it("requires an explicit begin, forwards the three settings independently and never forwards typed results", async () => {
    const { settings, activity, connection, messages } = fixture();
    const result = { details: { status: "delivered" }, content: [{ type: "text", text: "SENSITIVE" }] };
    expect(await activity.run(background, undefined, async () => result)).toBe(result);
    expect(messages()).toEqual([]);
    expect(await activity.begin("Update the form")).toBe("begun");
    expect(messages()).toEqual([
      { operation: "configure", label: expect.stringContaining("Editor agent"), panel: false, outline: false, point: false },
      { operation: "begin", intent: "Update the form" },
    ]);
    settings.update({ activity_panel: true, activity_cursors: true });
    const privateAction = { ...background, typed_text: "SENSITIVE" };
    await activity.run(privateAction, undefined, async () => {
      expect(activity.id(connection)).toBe(1);
      return result;
    });
    expect(await activity.end("completed")).toBe("ended");
    expect(messages().slice(2)).toEqual([
      { operation: "configure", label: expect.stringContaining("Editor agent"), panel: true, outline: false, point: true },
      { operation: "action_start", id: 1, ...background },
      { operation: "action_end", id: 1, outcome: "completed" },
      { operation: "end", outcome: "completed" },
    ]);
    activity.dispose();
  });

  it("correlates parallel calls only with the owning native connection and never with browser or guest work", async () => {
    const { activity, connection, messages } = fixture();
    await activity.begin("Compare views");
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const work = (kind: "desktop" | "browser" | "separate_desktop", check: (id: number | undefined) => void, wait?: Promise<void>) =>
      activity.run({ ...background, location: kind }, undefined, async () => {
        check(activity.id(connection));
        expect(activity.id({ send: connection.send })).toBeUndefined();
        await wait;
        check(activity.id(connection));
        return undefined;
      });
    const first = work("desktop", id => expect(id).toBe(1), hold);
    await work("desktop", id => expect(id).toBe(2));
    await work("browser", id => expect(id).toBeUndefined());
    await work("separate_desktop", id => expect(id).toBeUndefined());
    release();
    await first;
    expect(messages().flatMap(message => message.operation === "action_end" ? [message.id] : [])).toEqual([2, 3, 4, 1]);
    activity.dispose();
  });

  it("ends an aborted action's session and does not reopen activity on a replacement connection", async () => {
    const { activity, connection, send, messages } = fixture();
    await activity.begin("Check the form");
    const controller = new AbortController();
    await activity.run(background, controller.signal, async () => { controller.abort(); return undefined; });
    expect(messages().slice(-2)).toEqual([
      { operation: "action_end", id: 1, outcome: "interrupted" },
      { operation: "end", outcome: "interrupted" },
    ]);
    await activity.begin("Check the preview");
    activity.detach(connection);
    const replacement = { send };
    activity.attach(replacement);
    send.mockClear();
    await activity.run(background, undefined, async () => { expect(activity.id(replacement)).toBeUndefined(); return undefined; });
    expect(messages()).toEqual([]);
    expect(await activity.end("completed")).toBe("inactive");
    activity.dispose();
  });

  it("turns a cue off without ending the session or turning off another cue", async () => {
    const { settings, activity, messages } = fixture();
    settings.update({ activity_panel: true, activity_outlines: true, activity_cursors: true });
    await activity.begin("Review layout");
    settings.update({ activity_outlines: false });
    expect(messages().at(-1)).toMatchObject({ operation: "configure", panel: true, outline: false, point: true });
    expect(activity.active).toBe(true);
    activity.dispose();
  });

  it("does not correlate or cancel a new session from a previous session's running action", async () => {
    const { activity, connection } = fixture();
    const controller = new AbortController();
    await activity.begin("Check the first page");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    const old = activity.run(background, controller.signal, async () => {
      expect(activity.id(connection)).toBe(1);
      entered();
      await held;
      expect(activity.id(connection)).toBeUndefined();
      return undefined;
    });
    await running;
    await activity.end("completed");
    expect(await activity.begin("Check the second page")).toBe("begun");
    controller.abort();
    release();
    await old;
    expect(activity.active).toBe(true);
    activity.dispose();
  });

  it("keeps native input usable when start telemetry fails or times out", async () => {
    const { activity, connection, send } = fixture();
    await activity.begin("Read the form");
    const action = vi.fn(async () => { expect(activity.id(connection)).toBeUndefined(); return undefined; });
    send.mockRejectedValueOnce(new Error("side channel failure"));
    await activity.run(background, undefined, action);
    send.mockImplementationOnce(() => new Promise(() => {}));
    await activity.run(background, undefined, action);
    expect(action).toHaveBeenCalledTimes(2);
    activity.dispose();
  });
});
