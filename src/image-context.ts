import { createHash } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
type AgentMessage = ContextEvent["messages"][number];

const imageLimit = 3;
const archiveLimit = 12;
const archiveBytes = 48 * 1024 * 1024;
const imageBytes = 16 * 1024 * 1024;
const suffixes: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
interface Frame { hash: string; timestamp?: number; message: number; block: number }
/** Request-local image accounting. Resources are private and bounded, not a capture permission. */
export interface ImageContextReport {
  limit: number; imageCount: number; active: Frame[]; evictedCount: number; evicted: Frame[];
  resources: { hash: string; path: string; bytes: number }[];
}

/** Keep three image occurrences in each request without rewriting the stored transcript. */
export class ImageContext {
  readonly directory: string;
  constructor(cwd: string, sessionId: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error("Invalid image resource session ID");
    this.directory = path.join(cwd, ".tmp", "computer-vision", sessionId);
  }

  /** Older pixels become text references; tool pairs, thinking and timestamps are unchanged. */
  async apply(messages: AgentMessage[]): Promise<{ messages: AgentMessage[]; report: ImageContextReport }> {
    const frames: (Frame & { image: ImageContent })[] = [];
    messages.forEach((message, index) => {
      if (!("content" in message) || !Array.isArray(message.content)) return;
      message.content.forEach((block, position) => {
        if (block.type !== "image") return;
        frames.push({ image: block, hash: createHash("sha256").update(Buffer.from(block.data, "base64")).digest("hex"),
          timestamp: "timestamp" in message ? message.timestamp : undefined, message: index, block: position });
      });
    });
    // Retain the newest distinct resources. Duplicates still count separately in the model budget.
    const retained = new Map<string, { frame: typeof frames[number]; bytes: number; path: string }>();
    let bytes = 0;
    for (const frame of frames.slice().reverse()) {
      if (retained.has(frame.hash)) continue;
      const size = Buffer.byteLength(frame.image.data, "base64");
      const suffix = suffixes[frame.image.mimeType];
      if (!suffix || size > imageBytes || bytes + size > archiveBytes || retained.size === archiveLimit) continue;
      retained.set(frame.hash, { frame, bytes: size, path: path.join(this.directory, `${frame.hash}.${suffix}`) });
      bytes += size;
    }
    let resources = [...retained.values()].reverse();
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const names = new Set(resources.map(r => path.basename(r.path)));
      for (const name of await readdir(this.directory)) {
        if (/^[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(name) && !names.has(name)) await rm(path.join(this.directory, name));
      }
      for (const resource of resources) await writeFile(resource.path, Buffer.from(resource.frame.image.data, "base64"), { mode: 0o600 });
    } catch {
      // Resource failure must not turn off the model's budget. Never promise unreadable files.
      resources = []; retained.clear();
    }
    const cutoff = Math.max(0, frames.length - imageLimit);
    const removed = new Map<string, typeof frames[number]>();
    frames.slice(0, cutoff).forEach(frame => removed.set(`${frame.message}:${frame.block}`, frame));
    const encoded = new Map(frames.filter(frame => frame.image.data.length >= 16).map(frame => [frame.image.data, frame.hash]));
    const scrub = (text: string) => {
      for (const [data, hash] of encoded) if (text.includes(data)) text = text.replaceAll(data, `[Vision sha256:${hash}; encoded pixels omitted]`);
      return text;
    };
    const limited = messages.map((message, index) => {
      if (!("content" in message)) return message;
      if (typeof message.content === "string") {
        const content = scrub(message.content);
        return content === message.content ? message : { ...message, content } as AgentMessage;
      }
      if (!Array.isArray(message.content)) return message;
      let changed = false;
      const content = message.content.map((block, position) => {
        if (block.type === "text") {
          const text = scrub(block.text);
          if (text !== block.text) { changed = true; return { ...block, text }; }
        }
        const frame = removed.get(`${index}:${position}`);
        if (!frame) return block;
        changed = true;
        const resource = retained.get(frame.hash);
        return { type: "text" as const, text: `[Vision image sha256:${frame.hash}; timestamp:${frame.timestamp ?? "unknown"}; pixels omitted from model context. ${resource ? `Private resource: ${resource.path}` : "Resource evicted from bounded storage; observe again if needed."}]` };
      });
      return changed ? { ...message, content } as AgentMessage : message;
    });
    const summary = ({ image: _image, ...frame }: typeof frames[number]): Frame => frame;
    return { messages: limited, report: { limit: imageLimit, imageCount: Math.min(frames.length, imageLimit),
      active: frames.slice(cutoff).map(summary), evictedCount: cutoff, evicted: frames.slice(Math.max(0, cutoff - 100), cutoff).map(summary),
      resources: resources.map(r => ({ hash: r.frame.hash, bytes: r.bytes, path: r.path })) } };
  }

  /** Clear only this session's temporary resource directory on shutdown. Replay rebuilds it. */
  async close(): Promise<void> { await rm(this.directory, { recursive: true, force: true }); }
}
