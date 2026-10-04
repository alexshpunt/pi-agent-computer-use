import { randomUUID } from "node:crypto";
import type { BrowserOperation } from "./browser-client.ts";
import type { BrowserResult } from "./browser-session.ts";
import { VisionImages, validateVisionSettings, type AgentImage, type ImageRectangle, type VisionSettings } from "./vision-images.ts";

/** Parent-side original-pixel crops and image-to-CSS input mapping for one owned focused surface. */
export class BrowserImagePipeline {
  private frame?: AgentImage;
  private root?: { metadata: AgentImage; tab: unknown; screenshot: unknown };
  private coordinatesReady = false;
  private readonly images: VisionImages;
  constructor(images: VisionImages) { this.images = images; }

  /** The owning tab of retained detail. No arbitrary resource IDs are accepted from the model. */
  get tab(): unknown { return this.root?.tab; }

  /** Snapshot settings before dispatch and translate points from the actual last returned image. */
  begin(operation: BrowserOperation, args: Record<string, unknown>): { args: Record<string, unknown>; configuration: VisionSettings } {
    const translated = { ...args };
    if (operation === "act") {
      for (const key of ["click", "move"]) {
        const target = args[key];
        if (!target || typeof target !== "object") continue;
        const point = target as { x: number; y: number }; const frame = this.frame;
        if (!frame || !this.coordinatesReady) throw new Error("Coordinate input needs a fresh agent image.");
        if (Object.keys(point).sort().join(",") !== "x,y" || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
          point.x < 0 || point.y < 0 || point.x >= frame.output.width || point.y >= frame.output.height)
          throw new Error("Point is outside the agent image bounds.");
        translated[key] = { x: frame.mapping.offsetX + point.x * frame.mapping.scaleX,
          y: frame.mapping.offsetY + point.y * frame.mapping.scaleY };
      }
      this.coordinatesReady = false;
      if (args.close_tab === true) this.reset();
    } else if (operation !== "tabs") this.reset();
    return { args: translated, configuration: this.images.settings() };
  }

  /** Process a fresh worker capture, retaining immutable CSS/raster geometry and observation identity. */
  async finish(result: BrowserResult, configuration: VisionSettings): Promise<BrowserResult> {
    if (result.isError) { this.reset(); return result; }
    const image = result.content.find(block => block.type === "image");
    if (!image || image.type !== "image") {
      if (result.details.status !== "listed") this.coordinatesReady = false;
      return result;
    }
    const region = result.details.image_region as ImageRectangle | undefined;
    const processed = await this.images.process(image.data, configuration, region);
    const frame = processed.metadata;
    const css = (region ?? result.details.screenshot) as { width?: number; height?: number } | undefined;
    const width = typeof css?.width === "number" && Number.isFinite(css.width) && css.width > 0 ? css.width : frame.source.width;
    const height = typeof css?.height === "number" && Number.isFinite(css.height) && css.height > 0 ? css.height : frame.source.height;
    frame.sourceCss = { width, height };
    frame.mapping = { offsetX: region?.x ?? 0, offsetY: region?.y ?? 0,
      scaleX: width / frame.output.width, scaleY: height / frame.output.height };
    frame.origin = { kind: "fresh_capture", observation: randomUUID(),
      raster: { x: 0, y: 0, width: frame.source.width, height: frame.source.height },
      css: { x: region?.x ?? 0, y: region?.y ?? 0, width, height }, inputReady: true };
    image.data = processed.png; this.frame = frame; this.coordinatesReady = true;
    this.root = { metadata: frame, tab: result.details.tab, screenshot: result.details.screenshot };
    result.details.agent_image = frame;
    for (const block of result.content) {
      if (block.type !== "text") continue;
      const boundary = block.text.indexOf("\n{");
      if (boundary >= 0) block.text = block.text.slice(0, boundary) + "\n" + JSON.stringify(result.details, null, 2);
    }
    return result;
  }

  /** Crop the last shown image in its pixel coordinates, always extracting the retained root PNG. */
  async crop(value: unknown): Promise<BrowserResult> {
    const root = this.root; const prior = this.frame;
    if (!root || !prior?.origin) throw new Error("No saved owned image; observe first.");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected crop rectangle.");
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some(key => !["x", "y", "width", "height", "maxLongEdge", "scale"].includes(key)))
      throw new Error("Unexpected crop options.");
    const { x, y, width, height } = input as unknown as ImageRectangle;
    if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 ||
      x + width > prior.output.width || y + height > prior.output.height)
      throw new Error("Crop rectangle is outside the last agent image bounds.");
    const current = this.images.settings();
    const configuration = { ...validateVisionSettings({ kernel: current.kernel,
      maxLongEdge: input.maxLongEdge ?? current.maxLongEdge, scale: input.scale ?? current.scale }), version: current.version };
    const base = prior.origin.raster;
    // Round outward for source-pixel coverage, never silently truncate an out-of-bounds request.
    const left = base.x + Math.floor(x * base.width / prior.output.width);
    const top = base.y + Math.floor(y * base.height / prior.output.height);
    const right = base.x + Math.min(base.width, Math.ceil((x + width) * base.width / prior.output.width));
    const bottom = base.y + Math.min(base.height, Math.ceil((y + height) * base.height / prior.output.height));
    const raster = { x: left, y: top, width: right - left, height: bottom - top };
    const processed = await this.images.crop(root.metadata.source.hash, raster, configuration);
    const original = root.metadata.origin!;
    const css = { x: original.css.x + raster.x * original.css.width / original.raster.width,
      y: original.css.y + raster.y * original.css.height / original.raster.height,
      width: raster.width * original.css.width / original.raster.width,
      height: raster.height * original.css.height / original.raster.height };
    const frame = processed.metadata;
    frame.sourceCss = { width: css.width, height: css.height };
    frame.mapping = { offsetX: css.x, offsetY: css.y, scaleX: css.width / frame.output.width, scaleY: css.height / frame.output.height };
    frame.origin = { kind: "saved_crop", observation: original.observation, raster, css, inputReady: this.coordinatesReady };
    this.frame = frame;
    return { content: [{ type: "image", data: processed.png, mimeType: "image/png" }],
      details: { status: "observed", tab: root.tab, screenshot: root.screenshot, agent_image: frame,
        saved_crop: true, ownership: "agent-only disposable browser" } };
  }

  /** Retire focus, coordinates and retained crop access when the owned worker/profile is released. */
  reset(): void { this.frame = undefined; this.root = undefined; this.coordinatesReady = false; }
}
