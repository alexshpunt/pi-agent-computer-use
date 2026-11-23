import { createServer, connect, type AddressInfo, type Socket } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { GuestInputLease, parseZone, zoneText, type InputLease, type ScreenZone } from "../src/input-lease.ts";
import { commandPoints, pointOutsideZone } from "../src/screen-zones.ts";
import { ComputerSession, type Driver } from "../src/session.ts";

// LPT-1820: each agent in the shared Windows Sandbox works in its own zone of the guest screen.

const left: ScreenZone = { x: 0, y: 0, width: 1281, height: 1636, index: 0, count: 2, screen: { width: 2563, height: 1636 } };
const topLeft: ScreenZone = { x: 0, y: 0, width: 1281, height: 818, index: 0, count: 3, screen: { width: 2563, height: 1636 } };

test("the guest's zone line parses, and malformed lines do not", () => {
  expect(parseZone("zone 1281 0 1282 1636 1 2 2563 1636")).toEqual({ x: 1281, y: 0, width: 1282, height: 1636, index: 1, count: 2, screen: { width: 2563, height: 1636 } });
  expect(parseZone("zone 0 0 0 1636 0 1 2563 1636")).toBeUndefined();
  expect(parseZone("zone 0 0 10 10 2 2 20 20")).toBeUndefined();
  expect(parseZone("full 4")).toBeUndefined();
  expect(zoneText(left)).toBe("Screen zone: the left half of the sandbox screen, 1281x1636 at 0,0 of 2563x1636 (shared with 1 other agent).");
  expect(zoneText({ ...topLeft, index: 3, count: 4, x: 1281, y: 818 })).toContain("the bottom-right quarter");
  expect(zoneText({ ...left, count: 1, index: 0 })).toContain("Screen zone: all of the sandbox screen, ");
});

test("every pointer position of a command counts, keys have none", () => {
  expect(commandPoints({ action: "drag", from_x: 1, from_y: 2, to_x: 3, to_y: 4, via: [{ x: 5, y: 6 }] })).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }]);
  expect(commandPoints({ action: "hold", keys: ["ctrl"], actions: [{ action: "click", x: 7, y: 8 }] })).toEqual([{ x: 7, y: 8 }]);
  expect(commandPoints({ action: "timeline", events: [{ at_ms: 0, type: "move", x: 9, y: 9 }, { at_ms: 1, type: "move_relative", dx: 5, dy: 5 }] })).toEqual([{ x: 9, y: 9 }]);
  expect(commandPoints({ action: "key", key: "Enter" })).toEqual([]);
});

test("a point is outside the zone by the window's place on the screen", () => {
  // A window at 1000,100 whose 400 px image shows 800 physical pixels: image x 200 is screen x 1400.
  const observed = { bounds: { x: 1000, y: 100, width: 800, height: 600 }, width: 400, frames: new Map([["t", { x: 1300, y: 150, width: 20, height: 20 }]]) };
  expect(pointOutsideZone({ action: "click", x: 100, y: 10 }, left, observed)).toBeUndefined();
  expect(pointOutsideZone({ action: "click", x: 200, y: 10 }, left, observed)).toEqual({ x: 1400, y: 120 });
  expect(pointOutsideZone({ action: "drag", from_x: 10, from_y: 10, to_x: 300, to_y: 10 }, left, observed)).toEqual({ x: 1600, y: 120 });
  expect(pointOutsideZone({ action: "click", element_token: "t" }, left, observed)).toEqual({ x: 1310, y: 160 });
  // CUA's proven inset and scale win over the uniform image scale.
  expect(pointOutsideZone({ action: "click", x: 200, y: 10 }, left, { ...observed, mapping: { offsetX: 1, offsetY: 1, scale: 1 } })).toBeUndefined();
  expect(pointOutsideZone({ action: "key", key: "a" }, left, observed)).toBeUndefined();
});

/** A sandbox guest with one launched app whose window lies at `bounds`. */
function guest(bounds = { x: 0, y: 0, width: 400, height: 300 }) {
  const sent: string[] = [];
  const driver: Driver = {
    identity: vi.fn(async window => `${window.pid}:${window.window_id}`),
    call: vi.fn<Driver["call"]>(async (name, args) => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: sent.includes("launch") ? [{ pid: 70, window_id: 700, title: "Calc", app_name: "Calc" }] : [] } };
      if (name === "list_apps") return { content: [], structuredContent: { apps: [{ name: "Calc", launch_path: "C:\\calc.exe" }] } };
      if (name === "launch_app") { sent.push("launch"); return { content: [{ type: "text", text: JSON.stringify({ pid: 70 }) }] }; }
      if (name === "get_window_state") return { content: [{ type: "image", mimeType: "image/png", data: "cG5n" }],
        structuredContent: { snapshot_id: "s1", screenshot_width: 400, screenshot_height: 300, window_bounds: bounds, elements: [] } };
      sent.push(`${name} ${String(args.x)},${String(args.y)}`);
      return { content: [], structuredContent: { effect: "unverifiable" } };
    }),
    close: vi.fn(async () => {}),
  };
  return { driver, sent };
}

function zonedLease(zone: { current: ScreenZone | undefined }): InputLease {
  return { claim: async () => true, acquire: async () => ({ waitedMs: 0, revoked: false, release: async () => undefined }),
    zone: async () => zone.current, close: () => {} };
}

test("input outside the agent's zone is refused and nothing is sent", async () => {
  const { driver, sent } = guest({ x: 1100, y: 0, width: 400, height: 300 });
  const zone = { current: left as ScreenZone | undefined };
  const session = new ComputerSession(driver, () => "yolo", undefined, undefined, undefined, undefined, { lease: zonedLease(zone), launchedOnly: true, zone: left });
  const opened = await session.open("Calc");
  const click = (x: number) => session.act({ window_ref: opened.details.window_ref!, observation_id: opened.details.observation_id!, action: "click", x, y: 10 });
  const refused = await click(300);
  expect(refused.details.status).toBe("refused");
  expect(refused.content[0]).toMatchObject({ text: expect.stringContaining("Screen point 1400,10 is outside this session's zone") });
  expect(sent.filter(line => line.startsWith("click"))).toEqual([]);
  expect((await click(100)).details.status).toBe("delivered");
  expect(sent.filter(line => line.startsWith("click"))).toEqual(["click 100,10"]);
});

test("a changed zone retires the observations and tells the agent its new zone", async () => {
  const { driver, sent } = guest();
  const zone = { current: left as ScreenZone | undefined };
  const session = new ComputerSession(driver, () => "yolo", undefined, undefined, undefined, undefined, { lease: zonedLease(zone), launchedOnly: true, zone: left });
  const opened = await session.open("Calc");
  zone.current = topLeft;
  const moved = await session.act({ window_ref: opened.details.window_ref!, observation_id: opened.details.observation_id!, action: "click", x: 10, y: 10 });
  expect(moved.details.status).toBe("refused");
  expect(moved.content[0]).toMatchObject({ text: expect.stringContaining("the top-left quarter") });
  expect(sent.filter(line => line.startsWith("click"))).toEqual([]);
  // The next look tells nothing new and gives a fresh observation to act on.
  const observed = await session.observe(opened.details.window_ref!);
  expect(observed.content[0]).not.toMatchObject({ text: expect.stringContaining("Screen zone") });
  expect((await session.act({ window_ref: observed.details.window_ref!, observation_id: observed.details.observation_id!, action: "click", x: 10, y: 10 })).details.status).toBe("delivered");
  // A fourth agent joins: the top-left quarter stays where it is, so nothing moved and nothing interrupts the agent.
  const again = await session.observe(opened.details.window_ref!);
  zone.current = { ...topLeft, count: 4 };
  const kept = await session.act({ window_ref: again.details.window_ref!, observation_id: again.details.observation_id!, action: "click", x: 10, y: 10 });
  expect(kept.details.status, JSON.stringify(kept.content)).toBe("delivered");
  const unchanged = await session.observe(opened.details.window_ref!);
  expect(unchanged.content[0]).not.toMatchObject({ text: expect.stringContaining("Screen zone") });

  zone.current = undefined;
  const lost = await session.act({ window_ref: unchanged.details.window_ref!, observation_id: unchanged.details.observation_id!, action: "click", x: 10, y: 10 });
  expect(lost.details.status).toBe("refused");
  expect(lost.content[0]).toMatchObject({ text: expect.stringContaining("lost its zone") });
});

test("a window read after a zone change says so", async () => {
  const { driver } = guest();
  const zone = { current: left as ScreenZone | undefined };
  const session = new ComputerSession(driver, () => "yolo", undefined, undefined, undefined, undefined, { lease: zonedLease(zone), launchedOnly: true, zone: left });
  const opened = await session.open("Calc");
  zone.current = topLeft;
  const observed = await session.observe(opened.details.window_ref!);
  expect(observed.details.status).toBe("observed");
  expect(observed.content[0]).toMatchObject({ text: expect.stringMatching(/^Agents joined or left the sandbox.*top-left quarter/) });
});

let server: ReturnType<typeof createServer> | undefined;
afterEach(() => { server?.close(); server = undefined; });

test("the lease client joins the zones, reads its zone and joins again after a lost connection", async () => {
  const lines: string[] = [];
  const sockets: Socket[] = [];
  let seats = 1;
  server = createServer(socket => {
    sockets.push(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        lines.push(line);
        if (line.startsWith("auth ")) socket.write("ok\n");
        else if (line === "join") socket.write(seats < 4 ? `zone 0 0 1281 1636 0 ${++seats} 2563 1636\n` : "full 4\n");
        else if (line === "zone") socket.write(`zone 0 0 1281 1636 0 ${seats} 2563 1636\n`);
        else if (line.startsWith("claim ")) socket.write("claimed\n");
      }
    });
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const lease = new GuestInputLease({ connect: async () => connect(port, "127.0.0.1"), token: "t".repeat(64), agent: "agent-1" });
  expect(await lease.join()).toMatchObject({ width: 1281, count: 2 });
  expect(await lease.claim(70)).toBe(true);
  expect(await lease.zone()).toMatchObject({ count: 2 });
  sockets[0].destroy();
  // After a lost connection the client connects again at once: it claims its processes again and joins again. A
  // request sent before that could still go out on the closing connection and fail.
  await vi.waitFor(() => expect(lines.filter(line => line === "join")).toHaveLength(2));
  expect(lines.slice(-3)).toEqual([`auth ${"t".repeat(64)} agent-1`, "claim 70", "join"]);
  expect(await lease.zone()).toMatchObject({ count: 3 });
  expect(lines.at(-1)).toBe("zone");
  seats = 4;
  expect(await lease.join()).toBe("full");
  // Closing leaves for good, so the guest frees the zone at once instead of keeping it for a reconnect.
  lease.close();
  await vi.waitFor(() => expect(lines.at(-1)).toBe("leave"));
});

// LPT-1830: zones are off unless the agent that started the sandbox turned them on.
test("a sandbox without zones answers off, and a reconnect does not join", async () => {
  const lines: string[] = [];
  const sockets: Socket[] = [];
  server = createServer(socket => {
    sockets.push(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        lines.push(line);
        if (line.startsWith("auth ")) socket.write("ok\n");
        else if (line === "join") socket.write("off\n");
        else if (line.startsWith("claim ")) socket.write("claimed\n");
      }
    });
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const lease = new GuestInputLease({ connect: async () => connect(port, "127.0.0.1"), token: "t".repeat(64), agent: "agent-1" });
  expect(await lease.join()).toBe("off");
  expect(await lease.claim(70)).toBe(true);
  sockets[0].destroy();
  // A request may still go out on the closing connection and fail; the next one connects again, without a join.
  expect(await lease.claim(71).catch(() => lease.claim(71))).toBe(true);
  expect(lines.filter(line => line.startsWith("auth "))).toHaveLength(2);
  expect(lines.filter(line => line === "join")).toHaveLength(1);
  lease.close();
});

test("a lease closed while it connects keeps no connection, and requests in flight end", async () => {
  let opened: Socket | undefined;
  server = createServer(socket => {
    socket.setEncoding("utf8");
    // Answers auth and nothing else, so a request after it stays in flight.
    socket.on("data", (chunk: string) => { if (chunk.startsWith("auth ")) socket.write("ok\n"); });
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  let release!: () => void, connecting = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lease = new GuestInputLease({ token: "t".repeat(64), agent: "agent-1",
    connect: async () => { connecting = true; await gate; opened = connect(port, "127.0.0.1"); return opened; } });
  const joining = lease.join();
  await vi.waitFor(() => expect(connecting).toBe(true));
  lease.close();
  release();
  await expect(joining).rejects.toThrow("closed");
  expect(opened?.destroyed).toBe(true);

  // A request waiting for its reply when the lease closes fails instead of waiting forever.
  const other = new GuestInputLease({ connect: async () => connect(port, "127.0.0.1"), token: "t".repeat(64), agent: "agent-2" });
  const waiting = other.zone();
  await new Promise(resolve => setTimeout(resolve, 50));
  other.close();
  await expect(waiting).rejects.toThrow("closed");
});
