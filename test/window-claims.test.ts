import { expect, test, vi } from "vitest";
import { computerSource } from "../src/computer-address.ts";
import { ComputerResources } from "../src/computer-resources.ts";
import { windowCommand } from "../src/computer-tools.ts";
import { computerAction } from "../src/provider.ts";
import { ComputerSession, type Driver } from "../src/session.ts";

const cwd = "/synthetic-window-claims";

/** A native backend with one window; another agent may hold it. */
function backend(options: { claims?: boolean; heldBy?: string } = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const driver: Driver = {
    windowClaims: options.claims ?? true,
    holder: () => "Agent One, Pi process 41",
    identity: vi.fn(async () => "life-10-7") as Driver["identity"],
    close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async (name, args) => {
      calls.push({ name, args });
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid: 10, window_id: 7, title: "Game" }] } };
      if (name === "claim_window") return options.heldBy
        ? { content: [{ type: "text", text: `window_claimed: window 7 is held by ${options.heldBy}; nothing was sent.` }], isError: true,
          structuredContent: { status: "refused", effect: "refused", code: "window_claimed", window_id: 7, holder: options.heldBy } }
        : { content: [], structuredContent: { status: "claimed", pid: 10, window_id: 7, holder: args.holder } };
      if (name === "release_window") return { content: [], structuredContent: { status: "released", window_id: 7 } };
      throw new Error(`Unexpected native call ${name}`);
    }),
  };
  return { driver, calls };
}

function fixture(options: Parameters<typeof backend>[0] = {}) {
  const host = backend(options);
  const session = new ComputerSession(host.driver, () => "yolo");
  const resources = new ComputerResources(async () => session, async () => session.close());
  const window = async () => {
    const [game] = (await resources.search(resources.address("computer:machine/local/windows"), cwd, "Game")).details.state!.windows as { window_ref: string }[];
    return computerSource("window", game.window_ref);
  };
  const claim = (source: string, action: "claim" | "release") =>
    computerAction(resources, source, action, () => resources.address(source), address => resources.claim(address, cwd, action === "claim"));
  return { ...host, session, resources, window, claim };
}

// LPT-1847: an agent takes a window so other agents' input into it is refused, and gives it back.
test("claim holds the window under this session's name and release gives it back", async () => {
  const f = fixture();
  const window = await f.window();
  const claimed = await f.claim(window, "claim");
  expect(claimed.script.outcome).toBe("delivered");
  expect(claimed.summary).toMatch(/holds the window now/);
  expect(f.calls.find(call => call.name === "claim_window")?.args).toEqual({ pid: 10, window_id: 7, holder: "Agent One, Pi process 41" });
  const released = await f.claim(window, "release");
  expect(released.script.outcome).toBe("delivered");
  expect(f.calls.filter(call => call.name === "release_window").map(call => call.args)).toEqual([{ window_id: 7 }]);
  // Nothing is held any more.
  expect((await f.claim(window, "release")).summary).toMatch(/does not hold this window/);
});

test("a window another agent holds is refused with that agent's name", async () => {
  const f = fixture({ heldBy: "Agent Two, Pi process 52" });
  const result = await f.claim(await f.window(), "claim");
  expect(result.script.outcome).toBe("refused");
  expect(result.summary).toMatch(/Agent Two, Pi process 52 holds this window, so it was not taken/);
});

test("a runtime that cannot hold windows refuses the claim without a native call", async () => {
  const f = fixture({ claims: false });
  const result = await f.claim(await f.window(), "claim");
  expect(result.script.outcome).toBe("refused");
  expect(result.summary).toMatch(/cannot hold windows/);
  expect(f.calls.some(call => call.name === "claim_window")).toBe(false);
});

test("closing the session releases the windows it holds", async () => {
  const f = fixture();
  await f.claim(await f.window(), "claim");
  await f.session.close();
  expect(f.calls.filter(call => call.name === "release_window").map(call => call.args)).toEqual([{ window_id: 7 }]);
  expect(f.driver.close).toHaveBeenCalled();
});

test("claim and release take no coordinates, size or name", () => {
  expect(windowCommand({ window: "computer:game", action: "claim" })).toEqual({ action: "claim" });
  expect(windowCommand({ window: "computer:game", action: "release" })).toEqual({ action: "release" });
  expect(() => windowCommand({ window: "computer:game", action: "claim", as: "x" })).toThrow(/takes no coordinates, size or name/);
});
