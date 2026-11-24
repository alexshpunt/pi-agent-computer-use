// The tile page: one tile per window of every isolated session the host reports. Each session's stream hub
// (docs/session-streams.md) sends the window list, H.264 frames and the agent's activity; WebCodecs decodes the frames.
// The tiles fill the work area in justified rows (layout.js); windows that do not fit readably go to further layers,
// which the host's layer hotkeys switch. Only the shown layer's windows stream.
import { layoutLayers } from "./layout.js";
import { codecFromAnnexB, cursorInTile, maxDimensionFor, parseFrame, stableOrder, tileWindows } from "./stream.js";

const host = window.chrome?.webview;
const log = message => host?.postMessage({ type: "log", message: String(message).slice(0, 500) });
window.addEventListener("error", event => log(`error: ${event.message}`));
window.addEventListener("unhandledrejection", event => log(`rejection: ${event.reason}`));

const MAX_FPS = 10;
/** Paint passes per second: as often as tiles get frames, so no frame is lost and no pass is spent on nothing new. */
const PAINT_HZ = MAX_FPS;
const CAPTION = 28;
const GAP = 16;
/** The strip at the bottom of the work area that the footer (layers, hotkeys) keeps for itself. */
const FOOTER = 40;
const RECONNECT_MS = 2000;
const ACTIVITY_MS = 4000;
const area = document.getElementById("tiles");
const footer = document.getElementById("footer");
const sessions = new Map();
let workArea = { x: 0, y: 0, width: innerWidth, height: innerHeight };
let mode = "desktop";
let hotkeys = {};
/** The tiles per layer; `shown` indexes the layer on screen. `layoutKey` is what the layers were computed from. */
let layers = [];
let shown = 0;
let layoutKey = "";
let layoutQueued = false;
let paintQueued = false;
let lastPaint = 0;

/** A stable hue per session, so the agent's cursor and its tiles' accent share a colour. */
const hue = id => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

/** Numbers the tiles: a tile made again for the same window, such as one that closed and came back, is a new tile. */
let tileSerial = 0;

class Tile {
  constructor(session, window) {
    this.serial = ++tileSerial;
    this.session = session;
    this.window = window;
    this.element = document.createElement("div");
    this.element.className = "tile";
    this.element.style.setProperty("--accent", `hsl(${hue(session.info.session)} 70% 60%)`);
    this.element.innerHTML = `<div class="caption"><span class="agent"></span><span class="app"></span><span class="title"></span><span class="action"></span></div>
      <div class="content"><canvas></canvas><div class="cursor"><svg viewBox="0 0 16 22"><path d="M1 1 L1 18 L5.5 13.8 L8.6 21 L11.6 19.7 L8.6 12.6 L14.5 12.6 Z"/></svg></div></div>`;
    this.canvas = this.element.querySelector("canvas");
    this.context = this.canvas.getContext("2d", { alpha: false });
    this.cursor = this.element.querySelector(".cursor");
    this.element.querySelector(".agent").textContent = session.info.agentUser ?? session.info.session;
    // Placed and shown by the first layout.
    this.element.hidden = true;
    this.element.addEventListener("animationend", () => this.element.classList.remove("appear"));
    area.append(this.element);
    this.update(window);
  }

  update(window) {
    this.window = window;
    const app = (window.app ?? "").replace(/\.exe$/i, ""), title = window.title || app || "Window";
    this.element.querySelector(".app").textContent = app && app.toLowerCase() !== title.toLowerCase() ? app : "";
    this.element.querySelector(".title").textContent = title;
  }

  /** Show the tile at `rect`, or hide it when it is on another layer or has no room: hidden tiles do not stream. */
  place(rect) {
    const appearing = this.element.hidden && Boolean(rect);
    this.element.hidden = !rect;
    if (!rect) {
      if (this.maxDimension) { this.session.send({ type: "unsubscribe", window: this.window.id }); this.reset(); this.maxDimension = undefined; }
      return;
    }
    // A tile that comes into view fades in at its place; one already in view moves there.
    if (appearing) {
      this.element.classList.remove("appear");
      void this.element.offsetWidth;
      this.element.classList.add("appear");
    }
    this.rect = rect;
    Object.assign(this.element.style, { left: `${rect.x}px`, top: `${rect.y - CAPTION}px`, width: `${rect.width}px`, height: `${rect.height + CAPTION}px` });
    const width = Math.max(1, Math.round(rect.width * devicePixelRatio)), height = Math.max(1, Math.round(rect.height * devicePixelRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width; this.canvas.height = height;
      if (this.last) this.paint(this.last);
    }
    const maxDimension = maxDimensionFor(rect.width, rect.height, devicePixelRatio);
    if (maxDimension !== this.maxDimension) { this.maxDimension = maxDimension; this.subscribe(); }
    this.showActivity();
  }

  /** Subscribe on the session's current connection, or change the limits of the subscription. */
  subscribe() {
    if (document.hidden) return;
    if (this.maxDimension) this.session.send({ type: "subscribe", window: this.window.id, maxFps: MAX_FPS, maxDimension: this.maxDimension });
  }

  frame(header, payload) {
    if (!this.decoder || this.decoder.state === "closed") {
      if (!header.keyframe) return;
      const codec = codecFromAnnexB(payload);
      if (!codec) return;
      this.decoder = new VideoDecoder({ output: frame => this.draw(frame), error: error => this.decoderFailed(error) });
      this.decoder.configure({ codec, optimizeForLatency: true });
      this.waitForKeyframe = false;
    }
    // A decoder that falls behind skips to the next keyframe instead of showing ever older frames.
    if (!header.keyframe && (this.waitForKeyframe || this.decoder.decodeQueueSize > 6)) {
      if (!this.waitForKeyframe) { this.waitForKeyframe = true; this.session.send({ type: "keyframe", window: this.window.id }); }
      return;
    }
    if (header.keyframe) this.waitForKeyframe = false;
    this.decoder.decode(new EncodedVideoChunk({ type: header.keyframe ? "key" : "delta", timestamp: header.timestampUs ?? 0, data: payload }));
  }

  decoderFailed(error) {
    log(`decoder ${this.window.id}: ${error?.message ?? error}`);
    this.decoder = undefined;
    this.session.send({ type: "keyframe", window: this.window.id });
  }

  draw(frame) {
    if (this.last) this.last.close();
    this.last = frame;
    this.dirty = true;
    queuePaint();
  }

  paint(frame) { this.context.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height); }

  showActivity() {
    const activity = this.session.activity;
    const mine = activity && activity.window === this.window.id && Date.now() - activity.receivedAt < ACTIVITY_MS;
    // Window pixels to the tile's CSS pixels.
    const point = mine && this.rect ? cursorInTile(activity.point, this.window.bounds, this.rect.width / this.window.bounds.width) : undefined;
    this.cursor.style.display = point ? "block" : "none";
    if (point) this.cursor.style.transform = `translate(${point.x}px, ${point.y}px)`;
    this.element.querySelector(".action").textContent = mine && activity.action ? activity.action : "";
    this.element.classList.toggle("active", Boolean(mine));
  }

  /** The connection dropped: the next connection starts from a keyframe. */
  reset() {
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = undefined;
  }

  destroy() {
    this.reset();
    if (this.last) this.last.close();
    this.element.remove();
  }
}

class Session {
  constructor(info) {
    this.info = info;
    this.tiles = new Map();
    this.order = new Map();
    this.windows = [];
    this.connect();
  }

  connect() {
    if (this.closed) return;
    const ws = new WebSocket(`${this.info.url}?token=${encodeURIComponent(this.info.token)}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onmessage = event => {
      if (typeof event.data !== "string") { const { header, payload } = parseFrame(event.data); this.tiles.get(header.window)?.frame(header, payload); return; }
      this.message(JSON.parse(event.data));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      for (const tile of this.tiles.values()) tile.reset();
      if (!this.closed) this.retry = setTimeout(() => this.connect(), RECONNECT_MS);
    };
  }

  send(message) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  message(message) {
    if (message.type === "hello" || message.type === "windows") {
      this.setWindows(message.windows);
      if (message.type === "hello") {
        if (message.activity) this.setActivity(message.activity);
        for (const tile of this.tiles.values()) tile.subscribe();
      }
    } else if (message.type === "activity") this.setActivity(message);
    else if (message.type === "stream" && message.state === "ended" && message.reason !== "window closed") log(`stream ${message.window} ended: ${message.reason}`);
    else if (message.type === "error") log(`${this.info.session}: ${message.message}`);
  }

  setWindows(list) {
    this.windows = stableOrder(tileWindows(list), this.order);
    const ids = new Set(this.windows.map(w => w.id));
    for (const [id, tile] of this.tiles) if (!ids.has(id)) { tile.destroy(); this.tiles.delete(id); }
    for (const window of this.windows) {
      const tile = this.tiles.get(window.id);
      if (tile) tile.update(window); else this.tiles.set(window.id, new Tile(this, window));
    }
    queueLayout();
  }

  setActivity(activity) {
    this.activity = { ...activity, receivedAt: Date.now() };
    for (const tile of this.tiles.values()) tile.showActivity();
    renderFooter();
    clearTimeout(this.activityTimer);
    this.activityTimer = setTimeout(() => { for (const tile of this.tiles.values()) tile.showActivity(); renderFooter(); }, ACTIVITY_MS + 50);
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    clearTimeout(this.activityTimer);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
    for (const tile of this.tiles.values()) tile.destroy();
    this.tiles.clear();
  }
}

/**
 * Paint every tile with a new frame together, at most PAINT_HZ times a second: each paint is a composition of the
 * whole desktop-sized page, so one pass for all tiles costs far less than one per tile frame.
 */
function queuePaint() {
  if (paintQueued) return;
  paintQueued = true;
  setTimeout(() => requestAnimationFrame(() => {
    paintQueued = false;
    lastPaint = performance.now();
    for (const session of sessions.values()) for (const tile of session.tiles.values()) if (tile.dirty) {
      tile.dirty = false;
      tile.paint(tile.last);
      if (!tile.element.classList.contains("live")) {
        tile.element.classList.add("live");
        log(`live ${session.info.session} ${tile.window.title}: frame ${tile.last.displayWidth}x${tile.last.displayHeight} for a ${tile.canvas.width}x${tile.canvas.height} tile`);
      }
    }
  }), Math.max(0, 1000 / PAINT_HZ - (performance.now() - lastPaint)));
}

function queueLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => { layoutQueued = false; layout(); });
}

/** Sessions in the order they opened, so a new session's tiles go after the others'. */
const sessionOrder = (a, b) => (a.info.created ?? 0) - (b.info.created ?? 0) || (a.info.session < b.info.session ? -1 : 1);

/**
 * Compute the layers again when the tiles, a window's size or the work area changed; anything else, such as a new
 * title or a window raised to the front, keeps every tile in place. The shown layer stays the one that holds the
 * tiles shown before, if any are left.
 */
function layout() {
  const tiles = [...sessions.values()].sort(sessionOrder).flatMap(session => session.windows.map(w => session.tiles.get(w.id)));
  const key = JSON.stringify([workArea, devicePixelRatio, tiles.map(t => [t.serial, t.window.bounds.width, t.window.bounds.height])]);
  if (key !== layoutKey) {
    layoutKey = key;
    const before = new Set(layers[shown]?.tiles.keys() ?? []);
    // A window's own size is in device pixels; at its full size a tile shows it pixel for pixel. The footer keeps
    // its strip at the bottom.
    layers = layoutLayers(tiles.map(tile => ({ key: tile, width: tile.window.bounds.width / devicePixelRatio, height: tile.window.bounds.height / devicePixelRatio })),
      { ...workArea, height: Math.max(0, workArea.height - FOOTER) }, { caption: CAPTION, gap: GAP });
    const kept = layers.findIndex(layer => [...layer.tiles.keys()].some(tile => before.has(tile)));
    shown = kept >= 0 ? kept : Math.min(shown, Math.max(0, layers.length - 1));
    if (tiles.length) log(`layout: ${tiles.length} tiles in ${layers.length} layer(s) of ${layers.map(l => `${l.tiles.size} at ${Math.round(l.scale * 100)} %`).join(", ")}`);
  }
  show();
}

/** Place the shown layer's tiles and hide the rest. */
function show() {
  const current = layers[shown]?.tiles ?? new Map();
  for (const session of sessions.values()) for (const tile of session.tiles.values()) tile.place(current.get(tile));
  renderFooter();
}

/** Show the next (+1) or previous (-1) layer, from the host's layer hotkeys. */
function step(by) {
  if (layers.length < 2) return;
  shown = (shown + by + layers.length) % layers.length;
  log(`layer ${shown + 1} of ${layers.length}`);
  show();
}

/**
 * The footer under the tiles: one dot per layer, the shown one filled, a dot ringed in the agent's colour while an
 * agent acts in a window on that layer; and the hotkeys that switch layers and hide the overlay.
 */
function renderFooter() {
  const parts = [];
  if (layers.length > 1) {
    const now = Date.now();
    const dots = layers.map((layer, i) => {
      const busy = [...layer.tiles.keys()].find(tile => tile.session.activity?.window === tile.window.id && now - tile.session.activity.receivedAt < ACTIVITY_MS);
      return `<span class="dot${i === shown ? " shown" : ""}${busy ? " busy" : ""}"${busy ? ` style="--accent: ${busy.element.style.getPropertyValue("--accent")}"` : ""}></span>`;
    }).join("");
    const keys = [hotkeys.previousLayer, hotkeys.nextLayer].filter(Boolean).join(" / ");
    parts.push(`<span class="dots">${dots}</span><span>Layer ${shown + 1} of ${layers.length}</span>${keys ? `<span class="keys">${escapeHtml(keys)}</span>` : ""}`);
  }
  if (mode === "overlay" && hotkeys.overlay) parts.push(`<span><span class="keys">${escapeHtml(hotkeys.overlay)}</span> hides the agent sessions</span>`);
  footer.innerHTML = parts.join(`<span class="separator"></span>`);
  footer.hidden = !parts.length;
  footer.style.top = `${workArea.y + workArea.height - FOOTER + 4}px`;
  footer.style.left = `${workArea.x + workArea.width / 2}px`;
}

const escapeHtml = text => String(text).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

function setSessions(list) {
  const wanted = new Map(list.map(info => [info.session, info]));
  for (const [id, session] of sessions) {
    const info = wanted.get(id);
    if (!info || info.url !== session.info.url || info.token !== session.info.token) { session.close(); sessions.delete(id); }
  }
  for (const [id, info] of wanted) if (!sessions.has(id)) sessions.set(id, new Session(info));
  queueLayout();
}

host?.addEventListener("message", event => {
  const message = event.data;
  if (message.type === "sessions") { hotkeys = message.hotkeys ?? {}; setSessions(message.sessions); }
  else if (message.type === "layout") {
    // The host reports device pixels; the page lays out in CSS pixels.
    const r = message.workArea, scale = devicePixelRatio;
    workArea = { x: r.x / scale, y: r.y / scale, width: r.width / scale, height: r.height / scale };
    mode = message.mode;
    document.body.classList.toggle("overlay", mode === "overlay");
    queueLayout();
  } else if (message.type === "layer") step(message.step);
});
addEventListener("resize", queueLayout);
// The host hides the page while windows cover the whole desktop: nothing is captured, sent or decoded meanwhile.
document.addEventListener("visibilitychange", () => {
  for (const session of sessions.values()) for (const tile of session.tiles.values()) {
    if (document.hidden) { session.send({ type: "unsubscribe", window: tile.window.id }); tile.reset(); }
    else tile.subscribe();
  }
});
host?.postMessage({ type: "ready" });
