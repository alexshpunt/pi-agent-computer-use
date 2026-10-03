import type { BrowserOperation } from "./browser-client.ts";
import type { BrowserResult } from "./browser-session.ts";
import { VisionImages, type AgentImage, type VisionSettings } from "./vision-images.ts";

/** Parent-side image transforms; Windows input always receives original viewport CSS coordinates. */
export class BrowserImagePipeline {
  private frame?: AgentImage;
  private readonly images: VisionImages;
  constructor(images: VisionImages) { this.images = images; }

  /** Snapshot settings before dispatch and translate a point using the last actual returned image. */
  begin(operation: BrowserOperation, args: Record<string, unknown>): { args: Record<string, unknown>; configuration: VisionSettings } {
    const translated = { ...args };
    if (operation === "act") {
      for (const key of ["click", "move"]) {
        const target = args[key];
        if (!target || typeof target !== "object") continue;
        const point = target as { x: number; y: number };
        const frame = this.frame;
        if (!frame) throw new Error("Coordinate input needs a fresh agent image.");
        if (Object.keys(point).sort().join(",") !== "x,y" || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
          point.x < 0 || point.y < 0 || point.x >= frame.output.width || point.y >= frame.output.height)
          throw new Error("Point is outside the agent image bounds.");
        translated[key] = { x: frame.mapping.offsetX + point.x * frame.mapping.scaleX,
          y: frame.mapping.offsetY + point.y * frame.mapping.scaleY };
      }
    }
    if (operation !== "tabs") this.frame = undefined;
    return { args: translated, configuration: this.images.settings() };
  }

  /** Replace actual model-facing bytes, retaining only metadata and a separate bounded original resource. */
  async finish(result: BrowserResult, configuration: VisionSettings): Promise<BrowserResult> {
    if (result.isError) { this.frame = undefined; return result; }
    const image = result.content.find(block => block.type === "image");
    if (!image || image.type !== "image") {
      if (result.details.status !== "listed") this.frame = undefined;
      return result;
    }
    const processed = await this.images.process(image.data, configuration, result.details.image_region as { x: number; y: number } | undefined);
    const region = result.details.image_region as { width?: number; height?: number } | undefined;
    const css = (region ?? result.details.screenshot) as { width?: number; height?: number } | undefined;
    if (typeof css?.width === "number" && typeof css.height === "number" &&
      Number.isFinite(css.width) && Number.isFinite(css.height) && css.width > 0 && css.height > 0) {
      // Raster rounding can add a pixel. Input still addresses the reported CSS rectangle.
      processed.metadata.sourceCss = { width: css.width, height: css.height };
      processed.metadata.mapping.scaleX = css.width / processed.metadata.output.width;
      processed.metadata.mapping.scaleY = css.height / processed.metadata.output.height;
    }
    image.data = processed.png;
    this.frame = processed.metadata;
    result.details.agent_image = processed.metadata;
    for (const block of result.content) {
      if (block.type !== "text") continue;
      const boundary = block.text.indexOf("\n{");
      if (boundary >= 0) block.text = block.text.slice(0, boundary) + "\n" + JSON.stringify(result.details, null, 2);
    }
    return result;
  }

  /** Retire coordinate mapping when its worker/profile is released. Retained originals have separate lifetime. */
  reset(): void { this.frame = undefined; }
}
