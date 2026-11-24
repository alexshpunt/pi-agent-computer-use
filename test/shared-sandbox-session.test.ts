import { createServer, connect, type AddressInfo, type Socket } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { GuestInputLease, type InputLease, type LeaseGrant } from "../src/input-lease.ts";
import { ComputerSession, type Driver, type SessionScope } from "../src/session.ts";

// LPT-1809: agents share one Windows Sandbox. Each sees only the apps it started, and their input takes turns.

/** One turn at a time, first come first served, like the guest service. */
function fifoLease(events: string[], agent: string, shared: { tail: Promise<void>; claims?: Map<number, string> }, waitedMs = 0): InputLease {
  return {
    claim: async pid => {
      const claims = shared.claims ??= new Map();
      if ((claims.get(pid) ?? agent) !== agent) return false;
      claims.set(pid, agent);
      return true;
    },
    acquire: async signal => {
      let done!: () => void;
      const mine = new Promise<void>(resolve => { done = resolve; });
      const before = shared.tail;
      shared.tail = before.then(() => mine);
      await new Promise<void>((resolve, reject) => {
        before.then(resolve);
        signal?.addEventListener("abort", () => { done(); reject(new Error("aborted")); }, { once: true });
      });
      events.push(`${agent} acquire`);
      return { waitedMs, revoked: false, release: async () => { events.push(`${agent} release`); done(); return undefined; } } satisfies LeaseGrant;
    },
    close: () => {},
  };
}

/** A guest with an existing app of another agent (pid 42); each launch starts a new process. */
function guest(events: string[], agent: string, launches: { next: number }, clickMs = 0) {
  const windows: { pid: number; window_id: number; title: string; app_name: string }[] = [{ pid: 42, window_id: 420, title: "Other agent", app_name: "Paint" }];
  const driver: Driver = {
    identity: vi.fn(async window => `${window.pid}:${window.window_id}`),
    call: vi.fn<Driver["call"]>(async (name, args) => {
      if (name === "list_windows") return { content: [], structuredContent: { windows } };
      if (name === "list_apps") return { content: [], structuredContent: { apps: [{ name: "Notepad", launch_path: "C:\\Windows\\notepad.exe" }] } };
      if (name === "launch_app") {
        const pid = launches.next++;
        windows.push({ pid, window_id: pid * 10, title: "Untitled", app_name: "Notepad" });
        return { content: [{ type: "text", text: JSON.stringify({ pid }) }] };
      }
      if (name === "get_window_state") return { content: [{ type: "image", mimeType: "image/png", data: "cG5n" }],
        structuredContent: { snapshot_id: "s1", screenshot_width: 400, screenshot_height: 300, elements: [] } };
      events.push(`${agent} ${name} start ${String(args.pid ?? (args.target as { pid?: number } | undefined)?.pid)}`);
      await new Promise(resolve => setTimeout(resolve, clickMs));
      events.push(`${agent} ${name} end`);
      return { content: [], structuredContent: { effect: "unverifiable" } };
    }),
    close: vi.fn(async () => {}),
  };
  return { driver, windows, session: (scope: SessionScope) => new ComputerSession(driver, () => "yolo", undefined, undefined, undefined, undefined, scope) };
}

const text = (result: { content: { type: string; text?: string }[] }) => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");

test("two agents in one sandbox never send input at the same time", async () => {
  const events: string[] = [], shared = { tail: Promise.resolve() }, launches = { next: 70 };
  const a = guest(events, "A", launches, 30), b = guest(events, "B", launches, 30);
  const agentA = a.session({ lease: fifoLease(events, "A", shared), launchedOnly: true });
  const agentB = b.session({ lease: fifoLease(events, "B", shared), launchedOnly: true });
  const [openedA, openedB] = [await agentA.open("Notepad"), await agentB.open("Notepad")];
  events.length = 0;
  const click = (session: ComputerSession, opened: typeof openedA) => session.act({ window_ref: opened.details.window_ref!,
    observation_id: opened.details.observation_id!, action: "click", x: 10, y: 10 });
  const results = await Promise.all([click(agentA, openedA), click(agentB, openedB)]);
  expect(results.map(result => result.details.status)).toEqual(["delivered", "delivered"]);
  expect(events).toEqual(["A acquire", "A click start 70", "A click end", "A release", "B acquire", "B click start 71", "B click end", "B release"]);
});

test("a result says how long the input waited for its turn", async () => {
  const events: string[] = [], launches = { next: 70 };
  const g = guest(events, "A", launches);
  const session = g.session({ lease: fifoLease(events, "A", { tail: Promise.resolve() }, 1500), launchedOnly: true });
  const opened = await session.open("Notepad");
  expect(opened.details.input_wait_ms).toBe(1500);
  const clicked = await session.act({ window_ref: opened.details.window_ref!, observation_id: opened.details.observation_id!, action: "click", x: 10, y: 10 });
  expect(clicked.details.input_wait_ms).toBe(1500);
  expect(text(clicked)).toContain("1.5 s");
});

test("a result whose input left a menu open says the turn stays with this session", async () => {
  const events: string[] = [], launches = { next: 70 };
  const g = guest(events, "A", launches);
  const lease = fifoLease(events, "A", { tail: Promise.resolve() });
  const session = g.session({ lease: { ...lease, acquire: async signal => {
    const grant = await lease.acquire(signal);
    return { ...grant, release: async () => { await grant.release(); return "menu"; } };
  } }, launchedOnly: true });
  const opened = await session.open("Notepad");
  const clicked = await session.act({ window_ref: opened.details.window_ref!, observation_id: opened.details.observation_id!, action: "click", x: 10, y: 10 });
  expect(clicked.details.status).toBe("delivered");
  expect(clicked.details.input_held).toBe("menu");
  expect(clicked.details.input_wait_ms).toBeUndefined();
  expect(text(clicked)).toMatch(/^The open menu keeps the shared sandbox's mouse and keyboard with this session.*15 s/);
});

test("cancelling while another agent holds the input sends nothing", async () => {
  const events: string[] = [], shared = { tail: Promise.resolve() }, launches = { next: 70 };
  const g = guest(events, "A", launches);
  const session = g.session({ lease: fifoLease(events, "A", shared), launchedOnly: true });
  const opened = await session.open("Notepad");
  const blocker = await fifoLease(events, "B", shared).acquire();
  events.length = 0;
  const stop = new AbortController();
  const pending = session.act({ window_ref: opened.details.window_ref!, observation_id: opened.details.observation_id!, action: "click", x: 10, y: 10 }, stop.signal);
  await new Promise(resolve => setTimeout(resolve, 50));
  stop.abort();
  const result = await pending;
  await blocker.release();
  expect(result.details.status).toBe("refused");
  expect(events.filter(event => event.includes("click"))).toEqual([]);
});

test("an agent sees and acts only on the windows of apps it started", async () => {
  const events: string[] = [], launches = { next: 70 };
  const g = guest(events, "A", launches);
  const session = g.session({ launchedOnly: true });
  expect(((await session.windows()).details.state!.windows as unknown[])).toEqual([]);
  await session.open("Notepad");
  // A second window of the same process, such as a dialog, belongs to the agent too.
  g.windows.push({ pid: 70, window_id: 701, title: "Save as", app_name: "Notepad" });
  const listed = (await session.windows()).details.state!.windows as { pid: number; window_id: number }[];
  expect(listed.map(window => `${window.pid}:${window.window_id}`).sort()).toEqual(["70:700", "70:701"]);
  expect((await session.displays()).details.status).toBe("refused");
  expect((await session.clipboardRead(false)).details.status).toBe("refused");
});

test("leaving the sandbox closes the apps this agent started and no other agent's", async () => {
  const events: string[] = [], launches = { next: 70 };
  const g = guest(events, "A", launches);
  const session = g.session({ lease: fifoLease(events, "A", { tail: Promise.resolve() }), launchedOnly: true });
  await session.open("Notepad");
  events.length = 0;
  await session.close();
  expect(events.filter(event => event.includes("kill_app start"))).toEqual(["A kill_app start 70"]);
});

test("a window an app opens in another agent's process is not given to this agent", async () => {
  const events: string[] = [], shared = { tail: Promise.resolve() }, launches = { next: 70 };
  const a = guest(events, "A", launches), b = guest(events, "B", launches);
  const agentA = a.session({ lease: fifoLease(events, "A", shared), launchedOnly: true });
  expect((await agentA.open("Notepad")).details.status).toBe("observed");
  // A single-instance app: B's launch opens a new window in A's process 70.
  b.windows.push({ pid: 70, window_id: 700, title: "Untitled", app_name: "Notepad" });
  vi.mocked(b.driver.call).mockImplementation(async name => {
    if (name === "list_windows") return { content: [], structuredContent: { windows: b.windows } };
    if (name === "list_apps") return { content: [], structuredContent: { apps: [{ name: "Notepad", launch_path: "C:\\Windows\\notepad.exe" }] } };
    if (name === "launch_app") { b.windows.push({ pid: 70, window_id: 702, title: "Second", app_name: "Notepad" }); return { content: [{ type: "text", text: JSON.stringify({ pid: 70 }) }] }; }
    return { content: [], structuredContent: {} };
  });
  const agentB = b.session({ lease: fifoLease(events, "B", shared), launchedOnly: true });
  const opened = await agentB.open("Notepad");
  expect(opened.details.status).toBe("unknown");
  expect(opened.details.window_ref).toBeUndefined();
  expect(((await agentB.windows()).details.state!.windows as unknown[])).toEqual([]);
});

let server: ReturnType<typeof createServer> | undefined;
afterEach(() => { server?.close(); server = undefined; });

test("the lease client speaks the guest lease protocol and gives up the turn when cancelled", async () => {
  const lines: string[] = [];
  let held: Socket | undefined;
  server = createServer(socket => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        lines.push(line);
        if (line.startsWith("auth ")) socket.write("ok\n");
        else if (line === "acquire" && !held) { held = socket; socket.write("granted 7 1\n"); }
        else if (line === "release") { held = undefined; socket.write("held menu\n"); }
      }
    });
    socket.on("close", () => { if (held === socket) held = undefined; lines.push("closed"); });
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const lease = new GuestInputLease({ connect: async () => connect(port, "127.0.0.1"), token: "t".repeat(64), agent: "agent-1" });
  const grant = await lease.acquire();
  expect(grant).toMatchObject({ waitedMs: 7, revoked: true });
  expect(await grant.release()).toBe("menu");
  // A request cancelled before it starts asks for nothing.
  await expect(lease.acquire(AbortSignal.abort())).rejects.toThrow();
  expect(lines).toEqual([`auth ${"t".repeat(64)} agent-1`, "acquire", "release"]);

  // Another session holds the turn: this acquire waits, and cancelling it closes the connection.
  held = {} as Socket;
  const stop = new AbortController();
  const waiting = lease.acquire(stop.signal);
  await vi.waitFor(() => expect(lines.at(-1)).toBe("acquire"));
  stop.abort();
  await expect(waiting).rejects.toThrow();
  await vi.waitFor(() => expect(lines.at(-1)).toBe("closed"));
  lease.close();
});
