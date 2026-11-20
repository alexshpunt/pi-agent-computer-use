import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { GrpcClient, ProtoWriter, decodeProto, type ProtoMessage } from "./grpc-lite.ts";
import { acceptWebSocket, connectWebSocket, type WsConnection } from "./ws-lite.ts";

/*
 * The host side of an isolated session's window streams. It runs next to the session relay (in Pi locally, in the
 * relay worker on an SSH host), so it imports no package. Tile hosts on this machine connect to one WebSocket:
 *
 *   ws://127.0.0.1:<port>/v1/stream?token=<viewer token>        (or Authorization: Bearer <viewer token>)
 *
 * Server to viewer, JSON text messages:
 *   {"type":"hello","version":1,"session":"is-…","windows":[Window…],"activity":Activity|null}
 *   {"type":"windows","windows":[Window…]}            whenever a window appears, closes, moves, resizes or retitles
 *   {"type":"stream","window":id,"state":"open"|"retrying"|"ended","codec":"h264","maxFps":n,"maxDimension":n,"reason"?:s}
 *   {"type":"activity", …Activity}                     the agent's latest observation or action in the session
 *   {"type":"error","message":s}
 * Window: {id, title, app, pid, bounds:{x,y,width,height}, state, kind, focused, onScreen, z}; bounds are session
 * desktop pixels. Activity: {window:id|null, pid, kind, action?, outcome?, point?:{x,y}, region?:{x,y,width,height},
 * at}; point and region use the same desktop pixels, so the agent cursor sits at point. An element action without
 * a point gets the centre of its region as point.
 * Server to viewer, binary messages, one H.264 access unit each (Annex B, SPS/PPS on keyframes):
 *   u32be header length | JSON {"window":id,"sequence":n,"keyframe":b,"width":n,"height":n,"timestampUs":n} | payload
 * Viewer to server, JSON text messages:
 *   {"type":"subscribe","window":id,"maxFps":1-60 (10),"maxDimension":0-8192 (0 = native)}  also updates the limits
 *   {"type":"unsubscribe","window":id}
 *   {"type":"keyframe","window":id}
 * A window is captured only while a viewer subscribes to it, at the highest rate and size any viewer asks for. The
 * first frame a viewer gets for a window is a keyframe. A viewer that falls behind skips to the next keyframe.
 *
 * Pi posts the agent's activity to POST /v1/activity with the same bearer token.
 */

export interface StreamHubOptions {
  session: string;
  /** Root token of the session's cua-spacesd. */
  spacesdToken: string;
  /** Token tile hosts present. */
  viewerToken: string;
  /** A fresh authenticated byte stream to the session's cua-spacesd. */
  connect(signal?: AbortSignal): Promise<Socket>;
}
export interface StreamHub { port: number; close(): Promise<void> }

interface Rect { x: number; y: number; width: number; height: number }
interface StreamWindow { id: string; epoch: number; title: string; app: string; pid: number; bounds: Rect; state: string; kind: string; focused: boolean; onScreen: boolean; z: number }
interface Activity { window: string | null; pid: number; kind: string; action?: string; outcome?: string; point?: { x: number; y: number }; region?: Rect; at: number }
interface Subscription { maxFps: number; maxDimension: number; needKeyframe: boolean }
interface Viewer { ws: WsConnection; subscriptions: Map<string, Subscription> }

const STATES = ["unspecified", "normal", "minimized", "maximized", "fullscreen", "hidden"];
const KINDS = ["unspecified", "standard", "dialog", "panel", "menu", "tooltip", "system", "phantom"];
const MAX_VIEWERS = 8;
/** A viewer with more queued than this skips to the next keyframe instead of growing its backlog. */
const MAX_VIEWER_BACKLOG = 4 * 1024 * 1024;
const RETRY_MS = 1000;
const STREAM = "/cua.env.v1.StreamService/";

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
  signal?.addEventListener("abort", done, { once: true });
});
const sameToken = (actual: string | undefined, expected: string) => typeof actual === "string" && actual.length === expected.length
  && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
const rect = (value: unknown): Rect | undefined => {
  const r = value as Rect | undefined;
  return r && typeof r === "object" && [r.x, r.y, r.width, r.height].every(finite) ? { x: r.x, y: r.y, width: r.width, height: r.height } : undefined;
};

function windowOf(message: ProtoMessage): StreamWindow | undefined {
  const ref = message.msg(1);
  const id = ref?.str(1);
  if (!ref || !id) return undefined;
  const app = message.msg(3);
  const bounds = message.msg(4);
  return { id, epoch: ref.uint(2), title: message.str(2), app: app?.str(1) ?? "", pid: app?.uint(3) ?? 0,
    bounds: { x: bounds?.double(1) ?? 0, y: bounds?.double(2) ?? 0, width: bounds?.double(3) ?? 0, height: bounds?.double(4) ?? 0 },
    state: STATES[message.uint(6)] ?? "unspecified", kind: KINDS[message.uint(7)] ?? "unspecified",
    focused: message.bool(8), onScreen: message.bool(9), z: message.uint(10) };
}

/** Start the hub on a free host loopback port. Nothing reaches the session until a viewer connects. */
export async function createStreamHub(options: StreamHubOptions): Promise<StreamHub> {
  const viewers = new Set<Viewer>();
  const windows = new Map<string, StreamWindow>();
  const media = new Map<string, Media>();
  const lifetime = new AbortController();
  let activity: Activity | null = null;
  let grpc: Promise<GrpcClient> | undefined;
  let watching: AbortController | undefined;
  let listChanged = false;

  const broadcast = (message: unknown) => { const text = JSON.stringify(message); for (const viewer of viewers) viewer.ws.send(text); };
  const list = () => [...windows.values()].sort((a, b) => a.z - b.z).map(({ epoch: _, ...window }) => window);
  const announceWindows = () => {
    if (listChanged) return;
    listChanged = true;
    setImmediate(() => { listChanged = false; broadcast({ type: "windows", windows: list() }); });
  };

  /** One HTTP/2 connection carries every RPC; a broken one is replaced on the next call. */
  const client = (): Promise<GrpcClient> => {
    const current = grpc ??= options.connect(lifetime.signal).then(socket => {
      const connection = new GrpcClient(socket, { token: options.spacesdToken });
      void connection.closed.then(() => { if (grpc === current) grpc = undefined; });
      return connection;
    });
    current.catch(() => { if (grpc === current) grpc = undefined; });
    return current;
  };
  const unary = async (method: string, request: ProtoWriter, timeoutMs = 10_000) =>
    decodeProto(await (await client()).unary(STREAM + method, request.finish(), { signal: lifetime.signal, timeoutMs }));

  /** Window list from WatchWindows, only while a viewer is connected. */
  const watch = async (signal: AbortSignal) => {
    const request = new ProtoWriter().message(2, new ProtoWriter().uint(1, 10));
    while (!signal.aborted) {
      try {
        await (await client()).serverStream("/cua.env.v1.WindowsService/WatchWindows", request.finish(), bytes => {
          const event = decodeProto(bytes);
          const snapshot = event.msg(1);
          if (snapshot) {
            windows.clear();
            for (const info of snapshot.msgs(1)) { const window = windowOf(info); if (window) windows.set(window.id, window); }
          }
          for (const field of [2, 3]) { const info = event.msg(field); const window = info && windowOf(info); if (window) windows.set(window.id, window); }
          const closed = event.msg(4)?.msg(1)?.str(1);
          if (closed) { windows.delete(closed); media.get(closed)?.end("window closed"); }
          if (snapshot || event.msg(2) || event.msg(3) || closed) announceWindows();
        }, { signal });
      } catch { /* The connection or the session restarted; the next snapshot replaces the list. */ }
      await sleep(RETRY_MS, signal);
    }
  };

  /** One media session per watched window, shared by every viewer subscribed to it. */
  class Media {
    readonly window: string;
    private sessionId?: string;
    private ws?: WsConnection;
    private applied?: { maxFps: number; maxDimension: number };
    private running?: Promise<void>;
    private readonly stop = new AbortController();
    private lastKeyframeRequest = 0;
    constructor(window: string) { this.window = window; }

    subscribers(): Subscription[] { return [...viewers].flatMap(viewer => viewer.subscriptions.get(this.window) ?? []); }
    limits() {
      const all = this.subscribers();
      return { maxFps: Math.max(...all.map(s => s.maxFps)), maxDimension: all.some(s => s.maxDimension === 0) ? 0 : Math.max(...all.map(s => s.maxDimension)) };
    }

    /** Open, retune or close to match the current subscribers. */
    update(): void {
      if (!this.subscribers().length) { this.end(); return; }
      this.running ??= this.run();
      const wanted = this.limits();
      if (this.sessionId && this.applied && (wanted.maxFps !== this.applied.maxFps || wanted.maxDimension !== this.applied.maxDimension)) {
        const id = this.sessionId;
        this.applied = wanted;
        void unary("SetPreferences", new ProtoWriter().string(1, id).uint(2, wanted.maxFps).uint(3, wanted.maxDimension || 8192)).catch(() => undefined);
      }
    }

    requestKeyframe(): void {
      const now = Date.now();
      if (!this.ws || !this.sessionId || now - this.lastKeyframeRequest < 500) return;
      this.lastKeyframeRequest = now;
      this.ws.send(JSON.stringify({ type: "request_keyframe", payload: { session_id: this.sessionId } }));
    }

    private async run(): Promise<void> {
      const signal = this.stop.signal;
      while (!signal.aborted && !lifetime.signal.aborted) {
        const target = windows.get(this.window);
        if (!target) { this.end("window closed"); return; }
        let reason = "stream failed";
        try {
          const limits = this.limits();
          // view_only: tiles only watch. max_dimension 0 means native to spacesd.
          const opened = await unary("OpenMedia", new ProtoWriter()
            .message(1, new ProtoWriter().message(2, new ProtoWriter().string(1, target.id).uint(2, target.epoch)))
            .packed(2, [1]).uint(3, limits.maxFps).uint(4, limits.maxDimension).uint(6, 1)
            .message(8, new ProtoWriter().uint(1, 60)));
          this.sessionId = opened.str(1);
          this.applied = limits;
          const path = opened.str(4);
          if (!this.sessionId || !path.startsWith("/media?")) throw new Error("spacesd returned no media path.");
          const socket = await options.connect(signal);
          const { ws } = await connectWebSocket(socket, { host: "127.0.0.1", path, protocols: ["rcdp.v2"], timeoutMs: 10_000 });
          this.ws = ws;
          for (const subscription of this.subscribers()) subscription.needKeyframe = true;
          broadcast({ type: "stream", window: this.window, state: "open", codec: "h264", maxFps: opened.uint(7), maxDimension: opened.uint(8) });
          this.update();
          let unsubscribed = () => {};
          reason = await new Promise<string>(resolve => {
            ws.on("message", (data: Buffer, binary: boolean) => {
              if (binary) { this.frame(ws, data); return; }
              let message: { type?: string; payload?: { event?: { kind?: string } }; direction?: string; message?: unknown };
              try { message = JSON.parse(data.toString("utf8")); } catch { return; }
              if (message.direction) message = message.message as typeof message;
              if (message?.type === "lifecycle" && message.payload?.event?.kind === "closed") resolve("window closed");
            });
            ws.on("close", (code: number) => resolve(`media socket closed (${code})`));
            unsubscribed = () => resolve("unsubscribed");
            // The last viewer may have left while the socket opened; the abort event has fired by then.
            if (signal.aborted) unsubscribed();
            else signal.addEventListener("abort", unsubscribed, { once: true });
          });
          // A stream that restarts many times must not pile up listeners on the subscription's signal.
          signal.removeEventListener("abort", unsubscribed);
          ws.close();
        } catch (error) { reason = error instanceof Error ? error.message : String(error); }
        this.ws = undefined;
        const id = this.sessionId;
        this.sessionId = undefined;
        if (id) void unary("CloseMedia", new ProtoWriter().string(1, id), 3000).catch(() => undefined);
        if (signal.aborted || reason === "window closed" || !windows.has(this.window)) { this.end(reason); return; }
        // A stream that cannot open or drops shows as such, instead of a tile that silently stays empty.
        broadcast({ type: "stream", window: this.window, state: "retrying", reason });
        await sleep(RETRY_MS, signal);
      }
    }

    private frame(ws: WsConnection, data: Buffer): void {
      // Audio packets start with "RAU2"; length-prefixed video headers start with 0x00.
      if (data.length < 8 || data[0] !== 0) return;
      const headerLength = data.readUInt32BE(0), payloadLength = data.readUInt32BE(4);
      if (8 + headerLength + payloadLength > data.length) return;
      let header: { direction?: string; message?: Record<string, unknown> } & Record<string, unknown>;
      try { header = JSON.parse(data.subarray(8, 8 + headerLength).toString("utf8")); } catch { return; }
      const descriptor = (header.direction ? header.message : header) as Record<string, unknown> | undefined;
      if (!descriptor || descriptor.codec !== "h264") return;
      ws.send(JSON.stringify({ type: "frame_ack", payload: { session_id: descriptor.session_id, sequence: descriptor.sequence } }));
      const keyframe = descriptor.keyframe === true;
      const out = Buffer.from(JSON.stringify({ window: this.window, sequence: descriptor.sequence, keyframe,
        width: descriptor.width_px, height: descriptor.height_px, timestampUs: descriptor.capture_timestamp_us }));
      const packet = Buffer.concat([Buffer.alloc(4), out, data.subarray(8 + headerLength, 8 + headerLength + payloadLength)]);
      packet.writeUInt32BE(out.length, 0);
      let wantKeyframe = false;
      for (const viewer of viewers) {
        const subscription = viewer.subscriptions.get(this.window);
        if (!subscription) continue;
        if (keyframe) subscription.needKeyframe = false;
        if (subscription.needKeyframe) { wantKeyframe = true; continue; }
        if (viewer.ws.bufferedAmount > MAX_VIEWER_BACKLOG) { subscription.needKeyframe = true; wantKeyframe = true; continue; }
        viewer.ws.send(packet);
      }
      if (wantKeyframe) this.requestKeyframe();
    }

    /** Stop streaming this window and tell its viewers why. */
    end(reason?: string): void {
      if (media.get(this.window) !== this) return;
      media.delete(this.window);
      this.stop.abort();
      if (reason) {
        for (const viewer of viewers) viewer.subscriptions.delete(this.window);
        broadcast({ type: "stream", window: this.window, state: "ended", reason });
      }
    }
  }

  const subscribe = (viewer: Viewer, message: Record<string, unknown>) => {
    const window = typeof message.window === "string" ? message.window : "";
    if (!["subscribe", "unsubscribe", "keyframe"].includes(message.type as string)) {
      viewer.ws.send(JSON.stringify({ type: "error", message: `Unknown request type ${String(message.type)}.` }));
      return;
    }
    if (message.type === "unsubscribe") { viewer.subscriptions.delete(window); media.get(window)?.update(); return; }
    if (!windows.has(window)) { viewer.ws.send(JSON.stringify({ type: "error", message: `No window ${window} in this session.` })); return; }
    if (message.type === "keyframe") {
      const subscription = viewer.subscriptions.get(window);
      if (subscription) { subscription.needKeyframe = true; media.get(window)?.requestKeyframe(); }
      return;
    }
    const maxFps = message.maxFps === undefined ? 10 : message.maxFps, maxDimension = message.maxDimension === undefined ? 0 : message.maxDimension;
    if (!Number.isInteger(maxFps) || (maxFps as number) < 1 || (maxFps as number) > 60 || !Number.isInteger(maxDimension) || (maxDimension as number) < 0 || (maxDimension as number) > 8192) {
      viewer.ws.send(JSON.stringify({ type: "error", message: "maxFps is 1-60 and maxDimension 0-8192." }));
      return;
    }
    const existing = viewer.subscriptions.get(window);
    viewer.subscriptions.set(window, { maxFps: maxFps as number, maxDimension: maxDimension as number, needKeyframe: existing?.needKeyframe ?? true });
    let stream = media.get(window);
    if (!stream) { stream = new Media(window); media.set(window, stream); }
    stream.update();
    if (!existing) stream.requestKeyframe();
  };

  const join = (ws: WsConnection) => {
    const viewer: Viewer = { ws, subscriptions: new Map() };
    viewers.add(viewer);
    ws.send(JSON.stringify({ type: "hello", version: 1, session: options.session, windows: list(), activity }));
    if (!watching) { watching = new AbortController(); void watch(watching.signal); }
    ws.on("message", (data: Buffer, binary: boolean) => {
      if (binary || data.length > 4096) return;
      try { subscribe(viewer, JSON.parse(data.toString("utf8"))); } catch { ws.send(JSON.stringify({ type: "error", message: "Invalid message." })); }
    });
    ws.on("close", () => {
      viewers.delete(viewer);
      for (const window of viewer.subscriptions.keys()) media.get(window)?.update();
      if (!viewers.size) {
        watching?.abort(); watching = undefined;
        for (const stream of [...media.values()]) stream.end();
        windows.clear();
      }
    });
  };

  /** The agent's latest window activity, matched to the spacesd window of the same process that holds it. */
  const report = (body: Record<string, unknown>): boolean => {
    const pid = body.pid, bounds = rect(body.bounds), point = body.point as { x: unknown; y: unknown } | undefined, region = rect(body.region);
    if (!Number.isSafeInteger(pid) || !bounds || typeof body.kind !== "string" || body.kind.length > 32
      || (point !== undefined && !(finite(point?.x) && finite(point?.y))) || (body.region !== undefined && !region)
      || [body.action, body.outcome].some(value => value !== undefined && (typeof value !== "string" || value.length > 64))) return false;
    const near = (a: Rect, b: Rect) => Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;
    const inside = (r: Rect, p: { x: number; y: number }) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
    const own = [...windows.values()].filter(window => window.pid === pid).sort((a, b) => a.z - b.z);
    // An element action has a region and no point: the agent cursor goes to the element's centre.
    const at = (point as { x: number; y: number } | undefined)
      ?? (region && body.kind === "action" ? { x: Math.round(region.x + region.width / 2), y: Math.round(region.y + region.height / 2) } : undefined);
    const match = own.find(window => near(window.bounds, bounds)) ?? (at && own.find(window => inside(window.bounds, at))) ?? own[0];
    activity = { window: match?.id ?? null, pid: pid as number, kind: body.kind, ...(body.action ? { action: body.action as string } : {}),
      ...(body.outcome ? { outcome: body.outcome as string } : {}), ...(at ? { point: { x: at.x, y: at.y } } : {}), ...(region ? { region } : {}), at: Date.now() };
    broadcast({ type: "activity", ...activity });
    return true;
  };

  const authorized = (req: IncomingMessage) => {
    const bearer = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const query = new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ?? undefined;
    return sameToken(bearer ?? query, options.viewerToken);
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number) => { res.writeHead(status).end(); };
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/v1/activity" || req.method !== "POST") { reply(404); return; }
    if (!authorized(req)) { reply(401); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 4096) req.destroy(); else chunks.push(chunk); });
    req.on("end", () => {
      let ok = false;
      try { ok = report(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { /* invalid JSON */ }
      reply(ok ? 204 : 400);
    });
  });
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const refuse = (status: string) => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/v1/stream") { refuse("404 Not Found"); return; }
    if (!authorized(req)) { refuse("401 Unauthorized"); return; }
    if (viewers.size >= MAX_VIEWERS || lifetime.signal.aborted) { refuse("503 Service Unavailable"); return; }
    const ws = acceptWebSocket(req, socket, head);
    if (ws) join(ws);
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });

  let closing: Promise<void> | undefined;
  return {
    port: (server.address() as AddressInfo).port,
    close: () => closing ??= (async () => {
      watching?.abort();
      for (const stream of [...media.values()]) stream.end();
      for (const viewer of viewers) viewer.ws.close(1001, "session closed");
      lifetime.abort();
      const connection = await grpc?.catch(() => undefined);
      connection?.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    })(),
  };
}
