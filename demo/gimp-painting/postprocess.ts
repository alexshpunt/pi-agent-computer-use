// Turn a demo recording into a sped-up video, a short animated preview and a reference/painting comparison.
// Run it on its own to redo the outputs of an earlier run:
//   node demo/gimp-painting/postprocess.ts --ssh zinpc-benchmark --remote-dir 'C:\Users\user\pi-gimp-demo\<run>' --out .tmp/gimp-demo/<run>
import { parseArgs } from "node:util";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";
import { findFfmpeg, remote, shQuote, wslPath, type Remote } from "./remote.ts";

export interface PostprocessOptions {
  /** Length of the full sped-up video in seconds. */
  videoSeconds: number;
  /** Length of the animated preview in seconds. */
  previewSeconds: number;
  /** Width of the reference picture-in-picture in the videos, in recording pixels; 0 leaves it out. */
  pipWidth: number;
}

export const DEFAULT_POSTPROCESS: PostprocessOptions = { videoSeconds: 120, previewSeconds: 30, pipWidth: 360 };

/**
 * Encode `timelapse.mp4` and `preview.webp` from `recording.mkv` in the run's Windows folder with the machine's ffmpeg,
 * copy them to `out`, and build `comparison.png` there from the reference and the exported painting.
 */
export async function postprocess(machine: Remote, remoteDir: string, out: string, options: PostprocessOptions = DEFAULT_POSTPROCESS): Promise<void> {
  await mkdir(out, { recursive: true });
  const ffmpeg = await findFfmpeg(machine);
  const ffmpegWsl = await wslPath(machine, ffmpeg);
  const ffprobeWsl = ffmpegWsl.replace(/ffmpeg\.exe$/i, "ffprobe.exe");
  const dir = await wslPath(machine, remoteDir);
  const run = (args: string, timeoutMs = 3_600_000) => machine.bash(`cd ${shQuote(dir)} && ${shQuote(ffmpegWsl)} -hide_banner -loglevel error -y ${args} </dev/null`, timeoutMs);

  const duration = Number((await machine.bash(`cd ${shQuote(dir)} && ${shQuote(ffprobeWsl)} -v error -show_entries format=duration -of csv=p=0 recording.mkv </dev/null`)).trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`recording.mkv in ${remoteDir} has no readable duration.`);
  const speed = (seconds: number) => Math.max(1, duration / seconds);
  // The reference in a white frame in the bottom-right corner, so viewers see the target next to the painting.
  const pip = (input: string, scale: number) => options.pipWidth > 0
    ? `[1:v]scale=${Math.round(options.pipWidth * scale)}:-1,pad=iw+${Math.max(2, Math.round(6 * scale))}*2:ih+${Math.max(2, Math.round(6 * scale))}*2:(ow-iw)/2:(oh-ih)/2:white[pip];[${input}][pip]overlay=W-w-${Math.round(24 * scale)}:H-h-${Math.round(24 * scale)}`
    : `[${input}]null`;
  const inputs = `-i recording.mkv${options.pipWidth > 0 ? " -i reference.png" : ""}`;

  const fullSpeed = speed(options.videoSeconds);
  await run(`${inputs} -filter_complex ${shQuote(`[0:v]setpts=PTS/${fullSpeed},fps=30[base];${pip("base", 1)},tpad=stop_mode=clone:stop_duration=3,format=yuv420p[v]`)} -map [v] -c:v libx264 -preset slow -crf 20 -movflags +faststart timelapse.mp4`);

  const previewSpeed = speed(options.previewSeconds);
  // Small enough for a README: about 6 MB for 30 s.
  const previewWidth = 800, previewScale = previewWidth / 1920;
  await run(`${inputs} -filter_complex ${shQuote(`[0:v]setpts=PTS/${previewSpeed},fps=8,scale=${previewWidth}:-2:flags=lanczos[base];${pip("base", previewScale)},tpad=stop_mode=clone:stop_duration=2,format=bgra[v]`)} -map [v] -c:v libwebp -quality 50 -compression_level 6 -loop 0 preview.webp`);

  for (const file of ["timelapse.mp4", "preview.webp", "painting.png", "reference.png"])
    await machine.pull(`${dir}/${file}`, path.join(out, file)).catch(error => { if (file !== "painting.png") throw error; });
  await comparison(path.join(out, "reference.png"), path.join(out, "painting.png"), path.join(out, "comparison.png"))
    .catch(error => console.warn(`No comparison image: ${(error as Error).message}`));
  console.log(`Recording ${Math.round(duration)} s; video ${options.videoSeconds} s at ${fullSpeed.toFixed(1)}x; preview ${options.previewSeconds} s at ${previewSpeed.toFixed(1)}x.`);
}

/** The reference and the painting side by side at the painting's size, each with a caption. */
export async function comparison(referenceFile: string, paintingFile: string, outFile: string): Promise<void> {
  const painting = sharp(paintingFile);
  const { width = 0, height = 0 } = await painting.metadata();
  const reference = await sharp(referenceFile).resize(width, height, { fit: "fill" }).png().toBuffer();
  const gap = 32, caption = 56, margin = 32;
  const total = { width: margin * 2 + width * 2 + gap, height: margin * 2 + height + caption };
  const label = (text: string, x: number) =>
    `<text x="${x + width / 2}" y="${margin + height + 40}" font-family="sans-serif" font-size="26" fill="#333" text-anchor="middle">${text}</text>`;
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${total.width}" height="${total.height}">${label("Reference", margin)}${label("Painted by the agent in GIMP", margin + width + gap)}</svg>`);
  await sharp({ create: { ...total, channels: 3, background: "#ffffff" } })
    .composite([
      { input: reference, left: margin, top: margin },
      { input: await painting.png().toBuffer(), left: margin + width + gap, top: margin },
      { input: svg, left: 0, top: 0 },
    ])
    .png()
    .toFile(outFile);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: {
    ssh: { type: "string", default: "zinpc-benchmark" },
    "remote-dir": { type: "string" },
    out: { type: "string" },
    "video-seconds": { type: "string", default: String(DEFAULT_POSTPROCESS.videoSeconds) },
    "preview-seconds": { type: "string", default: String(DEFAULT_POSTPROCESS.previewSeconds) },
    "pip-width": { type: "string", default: String(DEFAULT_POSTPROCESS.pipWidth) },
  } });
  if (!values["remote-dir"] || !values.out) throw new Error("Pass --remote-dir (the run's Windows folder) and --out (a local folder).");
  await postprocess(remote(values.ssh), values["remote-dir"], values.out, {
    videoSeconds: Number(values["video-seconds"]), previewSeconds: Number(values["preview-seconds"]), pipWidth: Number(values["pip-width"]),
  });
}
