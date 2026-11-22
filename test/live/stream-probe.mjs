// A stand-in tile host for live checks: reads {hubs:[{session,url,token}], seconds, warmup, maxFps, maxDimension,
// include, record?: {title, file}} as JSON on stdin, subscribes to every window whose title matches `include`
// through each session's stream hub with the platform WebSocket, and prints one JSON summary line.
// Plain JavaScript on purpose: it runs as is on the machine that hosts the sessions.
import { writeFileSync } from "node:fs";

const config = JSON.parse(await new Promise(resolve => { let text = ""; process.stdin.on("data", c => { text += c; }); process.stdin.on("end", () => resolve(text)); }));
const include = new RegExp(config.include ?? ".");
const started = performance.now();
const measureFrom = started + (config.warmup ?? 3) * 1000;
const windows = new Map();
const activity = [];
const errors = [];
const recorded = [];
let recording;

for (const hub of config.hubs) {
  const ws = new WebSocket(`${hub.url}?token=${hub.token}`);
  ws.binaryType = "arraybuffer";
  ws.onerror = () => errors.push(`${hub.session}: socket error`);
  ws.onclose = event => { if (performance.now() - started < config.seconds * 1000) errors.push(`${hub.session}: closed ${event.code}`); };
  ws.onmessage = event => {
    if (typeof event.data !== "string") {
      const bytes = Buffer.from(event.data);
      const length = bytes.readUInt32BE(0);
      const header = JSON.parse(bytes.subarray(4, 4 + length).toString());
      const entry = windows.get(`${hub.session}/${header.window}`);
      if (!entry) return;
      const now = performance.now();
      entry.firstFrameMs ??= Math.round(now - entry.subscribedAt);
      entry.width = header.width; entry.height = header.height;
      entry.maxFrameDimension = Math.max(entry.maxFrameDimension ?? 0, header.width, header.height);
      if (header.keyframe) entry.keyframes++;
      if (now >= measureFrom) { entry.frames++; entry.bytes += bytes.length - 4 - length; entry.times.push(now); }
      if (recording === undefined && config.record && include.test(entry.title) && entry.title.includes(config.record.title) && header.keyframe) recording = entry.key;
      if (recording === entry.key && recorded.length < 300) recorded.push(bytes.subarray(4 + length));
      return;
    }
    const message = JSON.parse(event.data);
    if (message.type === "activity") activity.push({ session: hub.session, ...message });
    if (message.type === "stream" && message.state === "open") {
      const entry = windows.get(`${hub.session}/${message.window}`);
      if (entry) entry.negotiatedMaxDimension = message.maxDimension;
    }
    if (message.type === "error") errors.push(`${hub.session}: ${message.message}`);
    if (message.type !== "windows" && message.type !== "hello") return;
    for (const window of message.windows) {
      const key = `${hub.session}/${window.id}`;
      if (windows.has(key) || !include.test(window.title)) continue;
      windows.set(key, { key, session: hub.session, title: window.title, bounds: window.bounds, subscribedAt: performance.now(), frames: 0, keyframes: 0, bytes: 0, times: [] });
      ws.send(JSON.stringify({ type: "subscribe", window: window.id, maxFps: config.maxFps ?? 10, maxDimension: config.maxDimension ?? 0 }));
    }
  };
}

await new Promise(resolve => setTimeout(resolve, config.seconds * 1000));
const span = (performance.now() - measureFrom) / 1000;
if (config.record && recorded.length) writeFileSync(config.record.file, Buffer.concat(recorded));
const result = [...windows.values()].map(({ times, subscribedAt: _, ...entry }) => {
  const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
  return { ...entry, fps: +(entry.frames / span).toFixed(2), kbps: +(entry.bytes * 8 / span / 1000).toFixed(1),
    gapP50: Math.round(gaps[Math.floor(gaps.length / 2)] ?? 0), gapP95: Math.round(gaps[Math.floor(gaps.length * 0.95)] ?? 0) };
});
process.stdout.write(JSON.stringify({ seconds: +span.toFixed(1), windows: result, activity, errors, recorded: recorded.length }) + "\n");
process.exit(0);
