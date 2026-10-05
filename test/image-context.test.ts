import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
type AgentMessage = ContextEvent["messages"][number];
import { ImageContext } from "../src/image-context.ts";

const image = (n: number) => ({ type: "image" as const, mimeType: "image/png", data: Buffer.from(`synthetic-frame-${n}`).toString("base64") });
const frames = (n: number): AgentMessage[] => Array.from({ length: n }, (_, i) => ({ role: "user", content: [{ type: "text", text: `step ${i}` }, image(i)], timestamp: i }));

test("only the last three payloads survive, even inside one message; stored messages and tool pairs stay intact", async () => {
  const cwd = await mkdtemp(path.resolve(".tmp/image-context-unit-"));
  const budget = new ImageContext(cwd, "unit");
  try {
    const messages = frames(12);
    messages[11] = { role: "toolResult", toolCallId: "crop", toolName: "codemode", content: [image(11), image(12), image(13)], isError: false, timestamp: 11 };
    const before = JSON.stringify(messages);
    const { messages: limited, report } = await budget.apply(messages);
    expect(JSON.stringify(messages)).toBe(before);
    expect(limited).toHaveLength(messages.length);
    expect(limited.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "crop", toolName: "codemode", isError: false });
    expect(limited.flatMap(m => "content" in m && Array.isArray(m.content) ? m.content.filter(b => b.type === "image") : [])).toEqual([image(11), image(12), image(13)]);
    expect(report.active).toHaveLength(3);
    expect(report.evictedCount).toBe(11);
    expect(JSON.stringify(limited)).not.toContain(image(0).data);
    expect(JSON.stringify(limited)).toContain("pixels omitted");
    expect(report.resources).toHaveLength(12);
    expect(await readFile(report.resources[0].path)).toEqual(Buffer.from(image(2).data, "base64"));
    expect((await readdir(budget.directory)).length).toBeLessThanOrEqual(12);
    const replay = await budget.apply(messages);
    expect(replay.messages).toEqual(limited);
    expect(replay.report.active).toEqual(report.active);
  } finally { await budget.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("a text dump cannot smuggle omitted screenshot bytes back into the model request", async () => {
  const cwd = await mkdtemp(path.resolve(".tmp/image-context-unit-")); const budget = new ImageContext(cwd, "unit");
  try {
    const messages = frames(5);
    messages.push({ role: "toolResult", toolCallId: "dump", toolName: "codemode", content: [{ type: "text", text: JSON.stringify({ old: image(0), latest: image(4) }) }], isError: false, timestamp: 10 });
    const limited = await budget.apply(messages);
    const dump = limited.messages.at(-1);
    expect(JSON.stringify(dump)).not.toContain(image(0).data);
    expect(JSON.stringify(dump)).not.toContain(image(4).data);
    expect(JSON.stringify(dump)).toContain("encoded pixels omitted");
    expect(messages.at(-1)).not.toEqual(dump);
  } finally { await budget.close(); await rm(cwd, { recursive: true, force: true }); }
});
test("resource write failure cannot bypass the limit; a fresh instance rebuilds stable references after reload", async () => {
  const cwd = await mkdtemp(path.resolve(".tmp/image-context-unit-"));
  const budget = new ImageContext(cwd, "unit");
  try {
    const messages = frames(6);
    const before = await budget.apply(messages); await budget.close();
    const restored = await new ImageContext(cwd, "unit").apply(messages);
    expect(restored.messages).toEqual(before.messages);
    expect(restored.report).toEqual(before.report);
    const failed = await new ImageContext("/dev/null", "unit").apply(messages);
    expect(failed.report.imageCount).toBe(3); expect(failed.report.resources).toEqual([]);
    expect(JSON.stringify(failed.messages)).not.toContain(image(0).data);
    expect(JSON.stringify(failed.messages)).toContain("Resource evicted");
  } finally { await budget.close(); await rm(cwd, { recursive: true, force: true }); }
});
test("re-read is a new payload occurrence, duplicate hashes do not bypass the image count, and text-only context is unchanged", async () => {
  const cwd = await mkdtemp(path.resolve(".tmp/image-context-unit-")); const budget = new ImageContext(cwd, "unit");
  try {
    const messages = frames(5); messages.push({ role: "user", content: [image(0), image(0), image(0)], timestamp: 9 });
    const limited = await budget.apply(messages);
    expect(limited.report.active.map(i => i.hash)).toEqual(Array(3).fill(limited.report.active[0].hash));
    const text: AgentMessage[] = [{ role: "user", content: "No image", timestamp: 1 }];
    expect((await budget.apply(text)).messages).toEqual(text);
  } finally { await budget.close(); await rm(cwd, { recursive: true, force: true }); }
});
