import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ComputerSession } from "./session.ts";

/** Register bounded capture and explicit frame selection in the common computer-use family. */
export function registerSequenceTool(pi: ExtensionAPI, getSession: (cwd: string) => Promise<ComputerSession>): void {
  const capture = Type.Object({
    duration_ms: Type.Integer({ minimum: 1, maximum: 10000 }), fps: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
    max_frames: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })), timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 30000 })),
    maxLongEdge: Type.Optional(Type.Integer({ minimum: 64, maximum: 4096 })), scale: Type.Optional(Type.Number({ minimum: 0.05, maximum: 1 })),
    region: Type.Optional(Type.Object({ x: Type.Integer({ minimum: 0 }), y: Type.Integer({ minimum: 0 }),
      width: Type.Integer({ minimum: 1 }), height: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })),
  }, { additionalProperties: false });
  pi.registerTool({
    name: "computer_sequence", label: "Computer sequence",
    description: "Read-only bounded temporal capture from exactly one window_ref or display: primary using capture:{duration_ms,fps?,max_frames?,timeout_ms?,maxLongEdge?,scale?,region?}. Defaults: 4 FPS, 40 frames, 15s timeout, existing native image settings. Duration 1..10000ms; FPS 1..10 is a goal, not a promise. Window capture skips accessibility walks; browser windows use this same path. Safe denies display and unowned windows. No foregrounding or source fallback. Capture returns sequence metadata only, not images, and retires that source's old input/detail authority. Frames use monotonic native-call-completion times, not compositor timestamps. Geometry changes, skipped and pending slots and partial stop_reason are explicit. Crop region uses uncropped returned-image pixels at the frozen cap; resize clips it without expanding. Select stored frames with sequence_id and selection: all|first|last|endpoints|changed|{indexes:[...]}|{from,to} (inclusive, zero-based). Changed means exact byte/geometry changes, not semantic relevance. Selected frames are ordered frame objects with an image for explicit image(frame.image) forwarding or further processing in Codemode. No image is forwarded by Codemode automatically. Resources retain newest 3 sequences within 48MiB, disappear on close/reload, and recheck access/lifetime when read. Partial/cancelled captures are not success; no capture loop survives cancellation. Frames never ground input or detail: observe again before acting. Store only returned sequence_id/window_ref under short Codemode aliases, not whole frame payloads.",
    parameters: Type.Object({
      window_ref: Type.Optional(Type.String({ minLength: 1 })), display: Type.Optional(Type.Literal("primary")),
      capture: Type.Optional(capture), sequence_id: Type.Optional(Type.String({ minLength: 1 })),
      selection: Type.Optional(Type.Union([
        ...["all", "first", "last", "endpoints", "changed"].map(v => Type.Literal(v)),
        Type.Object({ indexes: Type.Array(Type.Integer({ minimum: 0, maximum: 39 }), { minItems: 1, maxItems: 40, uniqueItems: true }) }, { additionalProperties: false }),
        Type.Object({ from: Type.Integer({ minimum: 0, maximum: 39 }), to: Type.Integer({ minimum: 0, maximum: 39 }) }, { additionalProperties: false }),
      ])),
    }, { additionalProperties: false }),
    outputSchema: Type.Object({ status: Type.String(), text: Type.String(), sequence: Type.Optional(Type.Unknown()),
      frames: Type.Optional(Type.Array(Type.Unknown())) }, { additionalProperties: true }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      const selecting = params.sequence_id !== undefined;
      if (selecting ? params.selection === undefined || params.capture !== undefined || params.window_ref !== undefined || params.display !== undefined
        : params.selection !== undefined || params.capture === undefined || (params.window_ref !== undefined) === (params.display !== undefined)) {
        const text = "Choose source + capture, or sequence_id + selection; do not mix capture and retained-frame modes.";
        return { content: [{ type: "text" as const, text }], details: { status: "refused" }, isError: true, structuredContent: { status: "refused", text } };
      }
      const session = await getSession(ctx.cwd);
      const result = selecting ? await session.sequenceFrames(params.sequence_id!, params.selection!, signal)
        : await session.captureSequence({ window_ref: params.window_ref, display: params.display }, params.capture!, signal);
      const images = result.content.filter(block => block.type === "image");
      const frames = result.details.selected_frames?.map((metadata, i) => ({ ...metadata, image: images[i] }));
      return { ...result, structuredContent: JSON.parse(JSON.stringify({ ...result.details,
        text: result.content.filter(block => block.type === "text").map(block => block.text).join("\n"), ...(frames ? { frames } : {}) })) };
    },
  });
}
