import { afterAll, expect, test } from "vitest";
import { readFile, stat } from "node:fs/promises";
import sharp from "sharp";
import { connectLive, paintTool, text } from "./remote.ts";
import { machineConfig } from "../../src/machine.ts";
import { sshRunner } from "../../src/runner.ts";

// LPT-817: a 10-second recording of a new Paint window shows the drawn stroke. Frames are decoded with
// the machine's own ffmpeg (the one the driver records with).
const live = await connectLive();
const runner = sshRunner((await machineConfig(process.cwd(), process.env.LIVE_MACHINE ?? "lab")).ssh);
let pid = 0;
afterAll(async () => { if (pid) await live.kill(pid); await live.close(); });

test("a recording of a Paint window plays back the drawn stroke", async () => {
  const opened = await live.insert(live.machine, { action: "open", app: "Paint" });
  expect(opened.details.status, text(opened)).toBe("observed");
  pid = opened.details.target!.pid;
  const window = `computer:window/${opened.details.window_ref}`;
  await paintTool(live, window, "Pencil");

  // open keeps the previous foreground window in front; bring Paint forward so the video starts on its canvas.
  const front = await live.read(window, ["image"]);
  await live.insert(`computer:observation/${front.details.observation_id}?delivery=foreground`, { action: "key", key: "escape" });
  const started = await live.insert(live.machine, { action: "record_start", seconds: 10 });
  expect(started.details.status, text(started)).toBe("delivered");
  await new Promise(resolve => setTimeout(resolve, 2000));
  const view = await live.read(window, ["image"]);
  const stroke = await live.insert(`computer:observation/${view.details.observation_id}?delivery=foreground`, { action: "drag",
    from_x: 450, from_y: 380, via: [{ x: 600, y: 470 }, { x: 750, y: 380 }], to_x: 850, to_y: 470, duration_ms: 1500 });
  expect(stroke.details.status, text(stroke)).toBe("delivered");
  await new Promise(resolve => setTimeout(resolve, 2000));
  const stopped = await live.insert(live.machine, { action: "record_stop", to: ".tmp/m7/recording.mp4" });
  expect(stopped.details.status, text(stopped)).toBe("delivered");
  expect((await stat(".tmp/m7/recording.mp4")).size).toBeGreaterThan(100_000);

  const folder = (await live.insert(live.machine, { action: "files" })).details.state!.folder as string;
  const wsl = (await runner.run("wslpath", ["-u", folder])).trim();
  const ffmpeg = (await runner.run("bash", ["-c", "ls -d /mnt/c/Users/*/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg*/*/bin/ffmpeg.exe | head -1"])).trim();
  const name = String(stopped.details.state!.name);
  await runner.run("bash", ["-c", `cd '${wsl}' && '${ffmpeg}' -v error -y -ss 1.8 -i ${name} -frames:v 1 first.png && '${ffmpeg}' -v error -y -sseof -0.5 -i ${name} -frames:v 1 last.png`], { timeoutMs: 120_000 });
  const frame = async (file: string) => sharp(Buffer.from((await runner.run("base64", ["-w0", `${wsl}/${file}`])).trim(), "base64"));
  const [first, last] = await Promise.all([frame("first.png"), frame("last.png")]);
  const meta = await first.metadata();
  // The window starts at its native bounds on the main display; compare the stroke area of the two frames.
  const bounds = (view.details.source as { image: { native_bounds: { x: number; y: number; width: number } } }).image.native_bounds;
  const scale = bounds.width / (view.details.agent_image as { output: { width: number } }).output.width;
  const area = { left: Math.round(bounds.x + 440 * scale), top: Math.round(bounds.y + 370 * scale), width: Math.round(420 * scale), height: Math.round(110 * scale) };
  console.log("video", meta.width, meta.height, "area", area);
  // Pixels that changed clearly between the frames are the stroke; H.264 noise stays well below 60 levels.
  const grey = (image: ReturnType<typeof sharp>) => image.clone().extract(area).greyscale().raw().toBuffer();
  const [before, after] = await Promise.all([grey(first), grey(last)]);
  const changed = before.filter((value: number, i: number) => Math.abs(value - after[i]) > 60).length;
  console.log("changed pixels in the stroke area", changed);
  expect(changed).toBeGreaterThan(300);
  expect((await readFile(".tmp/m7/recording.mp4")).subarray(4, 8).toString()).toBe("ftyp");
});
