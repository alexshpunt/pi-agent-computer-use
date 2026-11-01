// The demo gallery: one folder per run with its painting, a comparison with the reference and run.json, a gallery
// page with a video player per run, and a block of thumbnails in the repository README.
//   node demo/gimp-painting/gallery.ts add .tmp/gimp-demo/<run> [--video <url>] [--feature]
//   node demo/gimp-painting/gallery.ts video <id> <url>
//   node demo/gimp-painting/gallery.ts render
// See demo/gimp-painting/README.md#gallery.
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const galleryDir = path.join(here, "gallery");
const readmeFile = path.join(repo, "README.md");
const featuredPreview = path.join(repo, "images/gimp-demo/timelapse-preview.webp");
const START = "<!-- gimp-gallery:start -->", END = "<!-- gimp-gallery:end -->";

export interface Run {
  id: string;
  /** provider/model as Pi names it. */
  model: string;
  thinking: string;
  /** Day the run started, YYYY-MM-DD. */
  date: string;
  minutes: number;
  /** Model cost as Pi reported it, in US dollars. */
  cost: number;
  turns: number;
  toolCalls: number;
  canvas: string;
  /** A GitHub user-attachments URL of the full time-lapse, or null until it is uploaded. */
  video: string | null;
}

/** Model, thinking level, duration, cost and counts from a run's Pi event log. */
async function stats(eventsFile: string): Promise<Omit<Run, "id" | "canvas" | "video">> {
  let start: number | undefined, end = 0, cost = 0, turns = 0, toolCalls = 0, model = "", thinking = "";
  const lines = createInterface({ input: createReadStream(eventsFile), crlfDelay: Infinity });
  for await (const line of lines) {
    // Tool results carry screenshots; only the small event kinds below matter.
    if (!line.startsWith('{"type":"session"') && !line.startsWith('{"type":"message_end"') && !line.startsWith('{"type":"tool_execution_start"')) continue;
    const event = JSON.parse(line);
    if (event.type === "session") start = Date.parse(event.timestamp);
    else if (event.type === "tool_execution_start") toolCalls++;
    else if (event.message?.role === "assistant") {
      turns++;
      cost += event.message.usage?.cost?.total ?? 0;
      end = Math.max(end, event.message.timestamp ?? 0);
      model = `${event.message.provider}/${event.message.model}`;
      thinking = event.message.thinkingLevel ?? thinking;
    }
  }
  if (start === undefined || !turns) throw new Error(`${eventsFile} has no session or assistant turns.`);
  return { model, thinking: thinking || "off", date: new Date(start).toISOString().slice(0, 10), minutes: Math.round((end - start) / 60_000),
    cost: Math.round(cost * 100) / 100, turns, toolCalls };
}

async function exists(file: string) { return stat(file).then(() => true, () => false); }

async function runs(): Promise<Run[]> {
  const ids = await readdir(galleryDir).catch(() => [] as string[]);
  const found: Run[] = [];
  for (const id of ids) {
    const file = path.join(galleryDir, id, "run.json");
    if (await exists(file)) found.push(JSON.parse(await readFile(file, "utf8")));
  }
  return found.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

const shortModel = (run: Run) => run.model.split("/").pop()!;
const summary = (run: Run) => `${run.minutes} min · ${run.turns} turns · $${run.cost.toFixed(2)} · thinking ${run.thinking}`;

/** Write the gallery page and the README block from the runs' run.json files. */
async function render(): Promise<void> {
  const all = await runs();
  const page = [
    "# GIMP painting gallery",
    "",
    "Each run gave a Pi agent the same [reference picture](../../../assets/draw_task.png) and an empty canvas in GIMP, with the same [prompt](../prompt.md) and [painting skill](../skill/SKILL.md). [The demo guide](../README.md) explains how a run is made and how to add one.",
    "",
    "Cost is the model cost Pi reported. Time is from the agent's start to its last answer.",
    "",
    ...all.flatMap(run => [
      `## ${run.id}`,
      "",
      `**${run.model}** · ${run.date} · ${summary(run)} · ${run.toolCalls} tool calls`,
      "",
      `![The reference and the painting by ${run.model}](${run.id}/comparison.jpg)`,
      "",
      // GitHub plays a bare user-attachments URL on its own line as a video.
      ...(run.video ? [run.video, ""] : ["The time-lapse of this run isn't uploaded yet.", ""]),
    ]),
  ].join("\n");
  await mkdir(galleryDir, { recursive: true });
  await writeFile(path.join(galleryDir, "README.md"), page);

  const perRow = 3;
  const cells = all.map(run => `<td align="center" width="${Math.floor(100 / perRow)}%"><a href="demo/gimp-painting/gallery/README.md#${run.id}"><img src="demo/gimp-painting/gallery/${run.id}/painting.jpg" width="280" alt="Painting by ${run.model}"></a><br><b>${shortModel(run)}</b><br>${run.minutes} min · $${run.cost.toFixed(2)}</td>`);
  const rows = [];
  for (let i = 0; i < cells.length; i += perRow) rows.push(`<tr>\n${cells.slice(i, i + perRow).join("\n")}\n</tr>`);
  const block = [START, "", `<table>\n${rows.join("\n")}\n</table>`, "", END].join("\n");
  const readme = await readFile(readmeFile, "utf8");
  if (!readme.includes(START) || !readme.includes(END)) throw new Error(`README.md needs ${START} and ${END} where the gallery goes.`);
  await writeFile(readmeFile, readme.slice(0, readme.indexOf(START)) + block + readme.slice(readme.indexOf(END) + END.length));
  console.log(`Gallery: ${all.length} run(s); wrote ${path.relative(repo, path.join(galleryDir, "README.md"))} and the README block.`);
}

/** Add a finished run from its output folder. */
async function add(runDir: string, video: string | undefined, feature: boolean): Promise<void> {
  const painting = path.join(runDir, "painting.png");
  if (!(await exists(painting))) throw new Error(`${painting} is missing: the run exported no painting.`);
  const info = await stats(path.join(runDir, "events.jsonl"));
  const base = `${shortModel({ model: info.model } as Run)}-${info.date}`.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
  let id = base;
  for (let n = 2; await exists(path.join(galleryDir, id)); n++) id = `${base}-${n}`;
  const dir = path.join(galleryDir, id);
  await mkdir(dir, { recursive: true });
  const { width = 0, height = 0 } = await sharp(painting).metadata();
  await sharp(painting).resize(600).jpeg({ quality: 85, mozjpeg: true }).toFile(path.join(dir, "painting.jpg"));
  await sharp(path.join(runDir, "comparison.png")).resize(1600).jpeg({ quality: 85, mozjpeg: true }).toFile(path.join(dir, "comparison.jpg"));
  const run: Run = { id, ...info, canvas: `${width}x${height}`, video: video ?? null };
  await writeFile(path.join(dir, "run.json"), JSON.stringify(run, null, 2) + "\n");
  if (feature) await copyFile(path.join(runDir, "preview.webp"), featuredPreview);
  console.log(`Added ${id}: ${run.model}, ${summary(run)}.${video ? "" : " Upload timelapse.mp4 and run: gallery.ts video " + id + " <url>"}`);
  await render();
}

async function setVideo(id: string, url: string): Promise<void> {
  if (!/^https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]+$/.test(url)) throw new Error("Expected a https://github.com/user-attachments/assets/<id> URL.");
  const file = path.join(galleryDir, id, "run.json");
  const run: Run = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...run, video: url }, null, 2) + "\n");
  await render();
}

const { positionals, values } = parseArgs({ allowPositionals: true, options: { video: { type: "string" }, feature: { type: "boolean", default: false } } });
const [command, ...rest] = positionals;
if (command === "add" && rest[0]) await add(path.resolve(rest[0]), values.video, values.feature);
else if (command === "video" && rest[0] && rest[1]) await setVideo(rest[0], rest[1]);
else if (command === "render") await render();
else throw new Error("Usage: gallery.ts add <run folder> [--video <url>] [--feature] | video <id> <url> | render");
