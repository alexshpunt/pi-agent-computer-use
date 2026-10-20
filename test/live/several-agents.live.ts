import { afterAll, expect, test } from "vitest";
import { computerSource } from "../../src/computer-address.ts";
import { connectLive, text } from "./remote.ts";

// LPT-630: two independent agents (each its own resources, connection and drivers) work at the same time on one
// machine, each in its own isolated session with foreground input, without touching each other or the human.
const agents = [await connectLive(), await connectLive()];
afterAll(async () => { await Promise.all(agents.map(agent => agent.close())); });
const foreground = async () => (await agents[0].powershell(`Add-Type -Name F -Namespace PiLive -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();'; [PiLive.F]::GetForegroundWindow().ToInt64()`)).trim();
const editValue = async (agent: typeof agents[number], window: string) =>
  String((await agent.read(window, ["ui"])).details.ui!.elements.find(e => e.role === "Edit" || e.role === "Document")?.value ?? "");

test("two agents type at the same time in their own sessions, and one closing does not disturb the other", async () => {
  const human = await foreground();
  const sessions = await Promise.all(agents.map(async agent => {
    const opened = await agent.insert(agent.machine, { action: "open_session" });
    expect(opened.details.status, text(opened)).toBe("delivered");
    const address = computerSource("sandbox", opened.details.sandbox_ref!);
    const app = await agent.insert(address, { action: "open", path: "C:\\Windows\\System32\\notepad.exe" });
    expect(app.details.status, text(app)).toBe("observed");
    return { agent, address, window: `computer:window/${app.details.window_ref}` };
  }));

  // Both type foreground text at the same moment, several rounds each.
  await Promise.all(sessions.map(async ({ agent, window }, index) => {
    for (let round = 0; round < 3; round++) {
      const view = await agent.read(window, ["image"]);
      const typed = await agent.write(`computer:observation/${view.details.observation_id}?delivery=foreground`, `agent${index}-round${round} `);
      expect(typed.details.status, text(typed)).toBe("delivered");
    }
  }));
  for (const [index, { agent, window }] of sessions.entries()) {
    const value = await editValue(agent, window);
    expect(value).toBe(`agent${index}-round0 agent${index}-round1 agent${index}-round2 `);
  }
  expect(await foreground()).toBe(human);

  // The first agent closes its session while the second keeps typing.
  const [first, second] = sessions;
  const closing = first.agent.insert(first.address, { action: "close" });
  const view = await second.agent.read(second.window, ["image"]);
  const typed = await second.agent.write(`computer:observation/${view.details.observation_id}?delivery=foreground`, "still-here");
  expect(typed.details.status, text(typed)).toBe("delivered");
  expect((await closing).details.status).toBe("closed");
  expect(await editValue(second.agent, second.window)).toMatch(/still-here$/);
  // The closed session's window is gone for its agent; the other session still answers.
  await expect(first.agent.read(first.window, ["ui"])).rejects.toThrow();
  expect((await second.agent.insert(second.address, { action: "close" })).details.status).toBe("closed");
  expect(await foreground()).toBe(human);
});
