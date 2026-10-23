import { afterAll, expect, test } from "vitest";
import { addresses, connectLive, text } from "./remote.ts";
import { computerSource } from "../../src/computer-address.ts";

// LPT-835: physical human input pauses foreground agent input for 10 s. Input from the host into a session-opened
// Windows Sandbox arrives in the guest as physical input, so the host plays the human and the guest runs the agent.
const live = await connectLive();
let sandbox: string | undefined;
afterAll(async () => { if (sandbox) await live.insert(sandbox, { action: "close" }).catch(() => undefined); await live.close(); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("human input pauses the guest's foreground input, stops a running timeline and spares background input", async () => {
  const opened = await live.insert(live.machine, { action: "open_sandbox" });
  expect(opened.details.status, text(opened)).toBe("delivered");
  sandbox = computerSource("sandbox", opened.details.sandbox_ref!);
  const cmd = await live.insert(sandbox, { action: "open", app: "Command Prompt" });
  expect(cmd.details.status, text(cmd)).toBe("observed");
  const guest = `computer:window/${cmd.details.window_ref}`;
  const observation = async () => (await live.read(guest, ["image"])).details.observation_id!;
  const key = async (delivery: "foreground" | "background") =>
    live.insert(`computer:observation/${await observation()}?delivery=${delivery}`, { action: "key", key: "a" });

  // The human: one click on the restored sandbox window on the host.
  const host = addresses(await live.search(live.windows, "Windows Sandbox"), "window")[0];
  const state = await live.read(host, ["state"]);
  expect((await live.insert(`computer:window-state/${state.details.window_state_id}`, { action: "restore" })).details.status).toBe("delivered");
  const human = async () => {
    const view = await live.read(host, ["image"]);
    const { width, height } = view.details.agent_image!.output as { width: number; height: number };
    const click = await live.insert(`computer:observation/${view.details.observation_id}?delivery=foreground`,
      { action: "click", x: Math.round(width / 2), y: Math.round(height * 0.8) });
    expect(click.details.status, text(click)).toBe("delivered");
  };

  await sleep(11_000);
  expect((await key("foreground")).details.status).toBe("delivered");

  await human();
  const paused = await key("foreground");
  expect(paused.details.status).toBe("refused");
  expect(text(paused)).toMatch(/human is using the computer: .*retry in \d+ ms/);
  const background = await key("background");
  expect(text(background)).not.toMatch(/human_takeover|human is using/);

  await sleep(11_000);
  expect((await key("foreground")).details.status).toBe("delivered");

  // A running foreground timeline stops at its next event once the human acts, and releases what it holds.
  const events = Array.from({ length: 16 }, (_, i) => ({ at_ms: i * 500, type: i % 2 ? "key_up" : "key_down", key: "b" }));
  const timeline = live.insert(`computer:observation/${await observation()}?delivery=foreground`, { action: "timeline", events });
  await sleep(2_500);
  await human();
  const stopped = await timeline;
  console.log(text(stopped).split("\n").slice(0, 3).join("\n"));
  expect(text(stopped)).toMatch(/human_takeover/);
  expect(text(stopped)).toMatch(/everything held released: true/);
  expect(text(stopped)).not.toMatch(/16\/16 events sent/);
});
