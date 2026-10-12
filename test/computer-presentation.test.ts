import { expect, test } from "vitest";
import { presentComputerResult } from "../src/provider.ts";
import type { ComputerResult } from "../src/session.ts";

const resources = { appSource: (id: string) => `computer:app/${id}` };

test("coordinate scroll presentation exposes native wheel units and interrupted axis prefixes", () => {
  const result: ComputerResult = { isError: true, content: [{ type: "text", text: "Coordinate scroll interrupted. Never replay unknown input." }],
    details: { status: "unknown", mode: "yolo", state: { unit: "wheel_detents", delta_x: -1, delta_y: 2,
      pointer_attempted: true, pointer_delivered: true, attempted_axes: ["y", "x"], delivered_axes: ["y"],
      code: "cancelled", private_native_data: "x".repeat(20_000) } } };
  const before = JSON.stringify(result), summary = presentComputerResult(resources, result);
  expect(summary).toContain("delta_x=-1, delta_y=2; unit=wheel_detents");
  expect(summary).toContain("pointer_attempted=true, pointer_delivered=true");
  expect(summary).toContain('attempted_axes=["y","x"], delivered_axes=["y"]');
  expect(summary).toContain("cancelled");
  expect(summary).toContain("Never replay");
  expect(summary.length).toBeLessThan(1000);
  expect(JSON.stringify(result)).toBe(before);
});

test("action presentation keeps uncertainty and delivered prefixes without dumping native state", () => {
  const result: ComputerResult = { isError: true,
    content: [{ type: "text", text: 'Sequence refused: 1/2 steps delivered; 2 attempted. Never replay the completed prefix.\n{"large":"native dump"}' }],
    details: { status: "refused", mode: "yolo", state: { code: "background_unavailable", native_message: "Background delivery unavailable.",
      sequence: { completed: 1, attempted: 2, total: 2 }, private_native_data: "x".repeat(20_000) } } };
  const before = JSON.stringify(result);
  const text = presentComputerResult(resources, result);
  expect(text).toContain("1/2 steps delivered");
  expect(text).toContain("background_unavailable");
  expect(text).toContain("Background delivery unavailable");
  expect(text).toContain("Never replay");
  expect(text.length).toBeLessThan(1000);
  expect(JSON.stringify(result)).toBe(before);
});

test("native image presentation keeps local geometry but not annotation or hash payloads", () => {
  const result: ComputerResult = { content: [], details: { status: "observed", mode: "yolo", observation_id: "snapshot",
    agent_image: { route: "cua_window", coordinate_space: "window_image_pixels", output: { width: 395, height: 500, mimeType: "image/png", hash: "private hash" },
      configuration: { maxLongEdge: 500, scale: 1 }, annotation: { labels: Array(100).fill({ token: "native-private-token" }) } } } };
  const text = presentComputerResult(resources, result);
  expect(text).toContain("395x500");
  expect(text).toContain("window_image_pixels");
  expect(text).toContain("computer:observation/snapshot");
  expect(text).not.toContain("native-private-token");
  expect(text).not.toContain("private hash");
  expect(text.length).toBeLessThan(600);
  expect((result.details.agent_image!.annotation as { labels: unknown[] }).labels).toHaveLength(100);
});
