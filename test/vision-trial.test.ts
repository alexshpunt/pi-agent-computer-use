import sharp from "sharp";
import { expect, test } from "vitest";
import { VisionImages } from "../src/vision-images.ts";
import { VisionTrials } from "../src/vision-trial.ts";
import { VisionTrace } from "../src/vision-trace.ts";
import { startVisionServer } from "../src/vision-server.ts";

const settings = { kernel: "mitchell", maxLongEdge: 800, scale: 0.625 };
const answers = Array.from({ length: 12 }, (_, index) => ({ row: index + 1, text: "synthetic phrase 1234" }));

test("Apply compares twelve exact strings, changes settings and creates fresh light/dark samples", async () => {
  const images = new VisionImages();
  const trials = new VisionTrials(images, () => "synthetic phrase 1234");
  const first = await trials.create();
  expect(JSON.stringify(first)).not.toContain("synthetic phrase");
  expect(first.rows.map(row => row.background)).toEqual([...Array(6).fill("light"), ...Array(6).fill("dark")]);
  expect(first.rows.map(row => row.fontSize)).toEqual([28, 20, 16, 12, 10, 8, 28, 20, 16, 12, 10, 8]);
  expect(await sharp(trials.pixels(first.id)).metadata()).toMatchObject({ width: 980, height: 480, format: "png" });
  const completed = await trials.apply({ trial: first.id, settings, answers: [
    ...answers.slice(0, 9), { row: 10, text: "Synthetic phrase 1234" },
    { row: 11, text: "synthetic phrase 1234 " }, { row: 12, text: "" },
  ] });
  expect(completed.result.rows.map(row => row.status)).toEqual([...Array(9).fill("correct"), "wrong", "wrong", "wrong"]);
  expect(completed.next.id).not.toBe(first.id);
  expect(completed.next.configuration).toMatchObject({ ...settings, version: 1 });
  expect(trials.pixels(first.id)).toBeUndefined();
  await expect(trials.apply({ trial: first.id, settings, answers })).rejects.toThrow("expired");
  expect(trials.results()).toHaveLength(1);
  expect(JSON.stringify(trials.results())).not.toContain("synthetic phrase");
});

test("concurrent Apply cannot grade twice and completed samples stay bounded", async () => {
  const trials = new VisionTrials(new VisionImages(), () => "synthetic phrase 1234");
  let current = await trials.create();
  const first = trials.apply({ trial: current.id, settings, answers });
  await expect(trials.apply({ trial: current.id, settings, answers })).rejects.toThrow("already running");
  current = (await first).next;
  for (let index = 0; index < 17; index++) current = (await trials.apply({ trial: current.id, settings, answers })).next;
  expect(trials.results()).toHaveLength(16);
});

test("bad, incomplete or confidence fields cannot grade a trial or change settings", async () => {
  const images = new VisionImages(); const trials = new VisionTrials(images);
  const first = await trials.create(); const second = await trials.create();
  expect(second.id).not.toBe(first.id);
  expect(trials.pixels(second.id)?.equals(trials.pixels(first.id)!)).toBe(false);
  for (const value of [
    { trial: first.id, settings: { ...settings, mode: "yolo" }, answers },
    { trial: first.id, settings, answers: answers.slice(0, 6) },
    { trial: first.id, settings, answers: [answers[0], ...answers.slice(0, 11)] },
    { trial: first.id, settings, answers: [{ ...answers[0], status: "uncertain" }, ...answers.slice(1)] },
    { trial: first.id, settings, answers: [{ ...answers[0], text: "x".repeat(201) }, ...answers.slice(1)] },
  ]) await expect(trials.apply(value)).rejects.toThrow();
  expect(images.settings().version).toBe(0); expect(trials.results()).toEqual([]);
  expect(trials.pixels(first.id)).toBeDefined();
});

test("the private twelve-field form never returns answer strings and rejects foreign writes", async () => {
  const server = await startVisionServer(new VisionTrace("trial"), new VisionImages());
  const origin = new URL(server.url).origin;
  try {
    const html = await (await fetch(new URL("trial", server.url))).text();
    expect(html).toContain("Apply: check and new trial");
    expect(html).toContain('id="scale-number"');
    expect(html).not.toContain("Confidence");
    const first = await (await fetch(new URL("trial/new", server.url))).json();
    expect(first.id).toMatch(/^[a-f0-9]{32}$/);
    expect((await fetch(new URL("trial/pixels/" + first.id, server.url))).headers.get("content-type")).toBe("image/png");
    const url = new URL("trial/apply", server.url);
    const body = JSON.stringify({ trial: first.id, settings, answers });
    expect((await fetch(url, { method: "POST", headers: { Origin: "https://foreign.test", "Content-Type": "application/json" }, body })).status).toBe(403);
    const applied = await fetch(url, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body });
    expect(applied.status).toBe(200);
    const payload = await applied.json(); expect(payload.next.id).not.toBe(first.id);
    expect(payload.result.rows).toHaveLength(12);
    expect(payload.next.rows.every((row: { text?: string }) => row.text === undefined)).toBe(true);
    expect((await fetch(new URL("trial/pixels/" + first.id, server.url))).status).toBe(404);
  } finally { await server.close(); }
});
