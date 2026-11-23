import { afterAll, expect, test } from "vitest";
import { computerSource } from "../../src/computer-address.ts";
import { requireComputerAddress } from "../../src/computer-resources.ts";
import { clickPlan, dragPlan } from "../../src/computer-tools.ts";
import { presentComputerResult } from "../../src/provider.ts";
import type { ComputerResult } from "../../src/session.ts";
import { addresses, connectLive, openWindow, text, WINDOWS_POWERSHELL_PATH } from "./remote.ts";
import { connect } from "node:net";
import { once } from "node:events";
import { connectWebSocket } from "../../src/ws-lite.ts";
import { runnerHost } from "../../src/sandbox.ts";

// LPT-1809: several agents on one machine work in the one shared Windows Sandbox. Each opens its own form, they click
// and drag at the same time, a menu one agent opened survives another agent's click, and agents never see each other's windows.
// The guest scripts are copied into the sandbox when it starts, and agents join a running one: to check a change to
// scripts/sandbox, wait until the shared sandbox has stopped (10 minutes after its last agent) or stop it with wsb stop.
// A sandbox started from another machine runs that machine's prepared remote runtime, so agents with LIVE_MACHINE=local
// are refused ("runs another computer-use runtime") until it stops; the same holds the other way round.
// Five: without screen zones (off by default, LPT-1830) the sandbox takes more agents than the four zones allow.
const AGENTS = 5;
const agents = await Promise.all(Array.from({ length: AGENTS }, () => connectLive()));
afterAll(async () => { await Promise.all(agents.map(agent => agent.close())); });

/**
 * A WinForms window with a native Edit menu (Mark counts), a Count button and a Pad that counts left-to-right drags of at
 * least 100 px, at its own place on the guest screen.
 */
function form(title: string, index: number): string[] {
  const script = `Add-Type -AssemblyName System.Windows.Forms
$f = New-Object Windows.Forms.Form; $f.Text = '${title}'; $f.Width = 420; $f.Height = 330
$f.StartPosition = 'Manual'; $f.Left = 40 + ${index % 2} * 480; $f.Top = 40 + ${Math.floor(index / 2)} * 360
$state = @{ count = 0; menu = 0; drag = 0; down = $null }
$l = New-Object Windows.Forms.Label; $l.Left = 10; $l.Top = 110; $l.Width = 380; $l.Text = 'count:0 menu:0 drag:0'
$show = { $l.Text = "count:$($state.count) menu:$($state.menu) drag:$($state.drag)" }
$b = New-Object Windows.Forms.Button; $b.Left = 10; $b.Top = 20; $b.Width = 380; $b.Height = 80; $b.Text = 'Count'
$b.Add_Click({ $state.count++; & $show })
$p = New-Object Windows.Forms.Panel; $p.Left = 10; $p.Top = 140; $p.Width = 380; $p.Height = 110; $p.BackColor = 'LightSteelBlue'; $p.AccessibleName = 'Pad'
$p.Add_MouseDown({ param($s, $e) $state.down = $e.X })
$p.Add_MouseUp({ param($s, $e) if ($state.down -ne $null -and $e.X - $state.down -ge 100) { $state.drag++ }; $state.down = $null; & $show })
$menu = New-Object Windows.Forms.MainMenu; $edit = $menu.MenuItems.Add('&Edit')
[void]$edit.MenuItems.Add('&Mark', { $state.menu++; & $show })
$f.Menu = $menu; $f.Controls.AddRange(@($b, $l, $p)); [void]$f.ShowDialog()`;
  return ["-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

type Element = { name?: string; role: string; bounds: { window_image?: { x: number; y: number; width: number; height: number } } };
type Agent = { live: (typeof agents)[number]; sandbox: string; window: string; title: string };

async function center(agent: Agent, find: (element: Element) => boolean): Promise<{ x: number; y: number }> {
  const view = await agent.live.read(agent.window, ["full"]);
  const element = ((view.details.ui as { elements: Element[] }).elements).find(find);
  if (!element?.bounds.window_image) throw new Error(`${agent.title} has no such element: ${presentComputerResult(view)}`);
  const box = element.bounds.window_image;
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}
const click = (agent: Agent, point: { x: number; y: number }) =>
  agent.live.resources.input(requireComputerAddress(agent.window), agent.live.cwd, clickPlan({ window: agent.window, ...point }));
const drag = (agent: Agent, from: { x: number; y: number }, to: { x: number; y: number }) =>
  agent.live.resources.input(requireComputerAddress(agent.window), agent.live.cwd, dragPlan({ window: agent.window, from, to }));
/** The form's label, which names the Count clicks, Mark commands and Pad drags it received. */
async function state(agent: Agent): Promise<string> {
  const view = await agent.live.read(agent.window, ["ui"]);
  const label = ((view.details.ui as { elements: Element[] }).elements).find(element => /^count:\d+ menu:\d+ drag:\d+$/.test(element.name ?? ""));
  if (!label) throw new Error(`${agent.title} shows no state label: ${presentComputerResult(view)}`);
  return label.name!;
}
const waited = (result: ComputerResult) => result.details.input_wait_ms ?? 0;
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, median: sorted[Math.floor((sorted.length - 1) / 2)], p95: sorted[Math.floor((sorted.length - 1) * 0.95)], max: sorted.at(-1) };
};

test("agents share one sandbox, see only their own windows and never interleave input", async () => {
  // All agents ask at once: one starts the sandbox, the others wait for it and attach.
  const started = Date.now();
  const opened = await Promise.all(agents.map(live => live.insert(live.machine, { action: "open_sandbox" })));
  console.log(`open_sandbox for ${AGENTS} agents: ${Date.now() - started} ms`);
  for (const result of opened) expect(result.details.status, text(result)).toBe("delivered");
  const ids = opened.map(result => /Sandbox id: (\S+)/.exec(text(result))?.[1]);
  expect(new Set(ids).size, ids.join(", ")).toBe(1);

  const team: Agent[] = [];
  for (const [index, live] of agents.entries()) {
    const sandbox = computerSource("sandbox", opened[index].details.sandbox_ref!);
    const title = `pi-shared-${index}-${Date.now()}`;
    team.push({ live, sandbox, title, window: await openWindow(live, sandbox, WINDOWS_POWERSHELL_PATH, form(title, index), title) });
  }
  // No agent finds another agent's window.
  for (const agent of team) {
    const found = addresses(await agent.live.search(agent.sandbox, "pi-shared"), "window");
    expect(found, agent.title).toEqual([agent.window]);
  }

  // Each agent's tiles: the stream its hub serves the tile host lists only that agent's form. stream.json names a port on
  // the sandbox machine's loopback; with LIVE_MACHINE naming another machine, it is this process's hub behind a reverse
  // SSH tunnel (LPT-1830), reached here through a forward to that machine.
  for (const agent of team) {
    const ref = agent.sandbox.split("/").pop()!;
    const file = JSON.parse(await agent.live.powershell(`Get-Content -Raw (Join-Path $env:LOCALAPPDATA 'PiComputerUse\\sessions\\${ref}\\stream.json')`)) as { url: string; token: string };
    const url = new URL(file.url);
    const tunnel = await runnerHost(agent.live.runner).forward(Number(url.port));
    const socket = connect(tunnel.port, "127.0.0.1"); await once(socket, "connect");
    const { ws } = await connectWebSocket(socket, { host: "127.0.0.1", path: `${url.pathname}?token=${file.token}` });
    const titles = await new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${agent.title}: no window list from its tile stream`)), 15_000);
      ws.on("message", (data: Buffer, binary: boolean) => {
        const message = binary ? undefined : JSON.parse(data.toString()) as { type: string; windows?: { title: string }[] };
        if (message?.type === "windows" || (message?.type === "hello" && message.windows?.length)) { clearTimeout(timer); resolve(message.windows!.map(window => window.title)); }
      });
    });
    ws.close(); tunnel.close();
    expect(titles, agent.title).toEqual([agent.title]);
  }

  // Everyone drags across its own Pad at the same time: a press, move or release of another agent in between would break a drag.
  const DRAGS = 5;
  const dragWaits: number[] = [];
  await Promise.all(team.map(async agent => {
    const pad = await center(agent, element => element.name === "Pad");
    for (let round = 0; round < DRAGS; round++) {
      const result = await drag(agent, { x: pad.x - 140, y: pad.y }, { x: pad.x + 140, y: pad.y });
      expect(result.details.status, presentComputerResult(result)).toBe("delivered");
      dragWaits.push(waited(result));
    }
  }));
  for (const agent of team) expect(await state(agent), agent.title).toBe(`count:0 menu:0 drag:${DRAGS}`);
  console.log(`concurrent drags: wait ${JSON.stringify(stats(dragWaits))} ms`);

  // Everyone clicks its own Count button at the same time.
  const ROUNDS = 10;
  const waits: number[] = [], elapsed: number[] = [];
  await Promise.all(team.map(async agent => {
    const point = await center(agent, element => element.role === "Button" && element.name === "Count");
    for (let round = 0; round < ROUNDS; round++) {
      const before = Date.now();
      const result = await click(agent, point);
      elapsed.push(Date.now() - before);
      const state = result.details.state as Record<string, unknown> | undefined;
      console.log(`${agent.title} click ${round}: ${before % 100000} +${Date.now() - before} ms waited ${waited(result)} ${JSON.stringify({ route: state?.route, effect: state?.effect, path: state?.path, code: state?.code, focus: state?.focus_return })}`);
      expect(result.details.status, presentComputerResult(result)).toBe("delivered");
      waits.push(waited(result));
    }
  }));
  for (const agent of team) expect(await state(agent), agent.title).toBe(`count:${ROUNDS} menu:0 drag:${DRAGS}`);
  console.log(`concurrent clicks: wait ${JSON.stringify(stats(waits))} ms; tool call ${JSON.stringify(stats(elapsed))} ms`);

  // Agent 0 opens its Edit menu and thinks; agent 1's click waits for agent 0's next action, which picks Mark.
  const [first, second] = team;
  const editMenu = await center(first, element => element.role === "MenuItem" && element.name === "Edit");
  const countButton = await center(second, element => element.role === "Button" && element.name === "Count");
  const menuOpened = await click(first, editMenu);
  expect(menuOpened.details.status).toBe("delivered");
  // The result tells agent 0 that its open menu keeps the turn.
  expect(menuOpened.details.input_held, presentComputerResult(menuOpened)).toBe("menu");
  const blocked = click(second, countButton);
  await new Promise(resolve => setTimeout(resolve, 2000));
  const open = await first.live.read(first.window, ["image"]);
  const mark = await first.live.insert(`computer:observation/${open.details.observation_id}?delivery=foreground`, { action: "key", key: "m" });
  expect(mark.details.status, text(mark)).toBe("delivered");
  const late = await blocked;
  expect(late.details.status, presentComputerResult(late)).toBe("delivered");
  expect(waited(late)).toBeGreaterThanOrEqual(1500);
  expect(await state(first)).toBe(`count:${ROUNDS} menu:1 drag:${DRAGS}`);
  expect(await state(second)).toBe(`count:${ROUNDS + 1} menu:0 drag:${DRAGS}`);
  console.log(`a click behind an open menu waited ${waited(late)} ms`);

  // A click cancelled while it waits leaves the line: 15 s later agent 0's menu is still open, and its next key picks Mark.
  expect((await click(first, editMenu)).details.input_held).toBe("menu");
  const stop = new AbortController();
  const cancelled = second.live.resources.input(requireComputerAddress(second.window), second.live.cwd, clickPlan({ window: second.window, ...countButton }), stop.signal);
  await new Promise(resolve => setTimeout(resolve, 1000));
  stop.abort();
  expect((await cancelled).details.status, presentComputerResult(await cancelled)).toBe("refused");
  await new Promise(resolve => setTimeout(resolve, 16_000));
  const stillOpen = await first.live.read(first.window, ["image"]);
  expect((await first.live.insert(`computer:observation/${stillOpen.details.observation_id}?delivery=foreground`, { action: "key", key: "m" })).details.status).toBe("delivered");
  expect(await state(first)).toBe(`count:${ROUNDS} menu:2 drag:${DRAGS}`);
  expect(await state(second)).toBe(`count:${ROUNDS + 1} menu:0 drag:${DRAGS}`);

  // An agent that leaves its menu open does not block the others forever: after 15 s its menu is cancelled.
  const reopened = await click(first, editMenu);
  expect(reopened.details.status, presentComputerResult(reopened)).toBe("delivered");
  const revoking = await click(second, countButton);
  expect(revoking.details.status, presentComputerResult(revoking)).toBe("delivered");
  expect(waited(revoking)).toBeGreaterThanOrEqual(14_000);
  expect(presentComputerResult(revoking)).toMatch(/cancelled first/);
  expect(await state(first)).toBe(`count:${ROUNDS} menu:2 drag:${DRAGS}`);
  expect(await state(second)).toBe(`count:${ROUNDS + 2} menu:0 drag:${DRAGS}`);

  // One agent leaving keeps the sandbox for the others. Zones are off by default (LPT-1830): no agent got one, and
  // nothing interrupts the others when an agent leaves.
  expect(opened.some(result => text(result).includes("Screen zone"))).toBe(false);
  expect((await first.live.insert(first.sandbox, { action: "close" })).details.status).toBe("closed");
  const after = await click(second, countButton);
  expect(after.details.status, presentComputerResult(after)).toBe("delivered");
  expect(await state(second)).toBe(`count:${ROUNDS + 3} menu:0 drag:${DRAGS}`);
});
