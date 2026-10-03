import { randomBytes, randomInt } from "node:crypto";
import sharp from "sharp";
import { VisionImages, validateVisionSettings, type VisionSettings } from "./vision-images.ts";

const sizes = [28, 20, 16, 12, 10, 8];
const words = ["birch", "cedar", "forest", "harbor", "meadow", "orchid", "river", "stone", "violet", "winter"];
const randomText = () => Array.from({ length: 3 }, () => words[randomInt(words.length)]).join(" ") + " " + randomInt(1000, 10000);
const escape = (text: string) => text.replace(/[<>&"']/g, value => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[value]!);
const rows = [...sizes, ...sizes].map((fontSize, index) => ({ row: index + 1, fontSize,
  background: index < 6 ? "light" as const : "dark" as const }));

/** Public sample metadata. The text being tested is only delivered as PNG pixels. */
export interface VisionTrial {
  id: string; rows: typeof rows; configuration: VisionSettings;
}
/** A committed grade. It contains no correct answers or submitted text. */
export interface VisionTrialResult {
  trial: string; configuration: VisionSettings;
  rows: { row: number; fontSize: number; background: "light" | "dark"; status: "correct" | "wrong" }[];
}
interface Sample { id: string; text: string[]; png: Buffer; configuration: VisionSettings }
interface Answer { row: number; text: string }
const publicSample = (sample: Sample): VisionTrial => ({ id: sample.id,
  rows: rows.map(row => ({ ...row })), configuration: { ...sample.configuration } });

/** Bounded, in-memory trials. Apply grades once and changes settings only after the next PNG is ready. */
export class VisionTrials {
  private samples = new Map<string, Sample>();
  private completed: VisionTrialResult[] = [];
  private busy = false;
  private images: VisionImages;
  private createText: () => string;
  constructor(images: VisionImages, createText = randomText) { this.images = images; this.createText = createText; }

  private async generate(): Promise<Sample> {
    const id = randomBytes(16).toString("hex");
    const text = rows.map(() => this.createText());
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="980" height="480"><rect width="490" height="480" fill="#fff"/><rect x="490" width="490" height="480" fill="#17202d"/>` +
      rows.map((row, index) => `<text x="${26 + (index < 6 ? 0 : 490)}" y="${60 + (index % 6) * 74}" font-family="sans-serif" font-size="${row.fontSize}" fill="${row.background === "light" ? "#111" : "#fff"}">${index % 6 + 1}. ${escape(text[index])}</text>`).join("") +
      '<path d="M26 465h200" stroke="#777" stroke-width="0.5"/><path d="M516 465h200" stroke="#ddd" stroke-width="0.5"/></svg>';
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    return { id, text, png, configuration: this.images.settings() };
  }
  private retain(sample: Sample): VisionTrial {
    this.samples.set(sample.id, sample);
    while (this.samples.size > 6) this.samples.delete(this.samples.keys().next().value!);
    return publicSample(sample);
  }
  /** Create a fresh sample without returning its answer strings. */
  async create(): Promise<VisionTrial> { return this.retain(await this.generate()); }
  /** Return the source PNG only while its trial is active. */
  pixels(id: string): Buffer | undefined { return this.samples.get(id)?.png; }
  /** Return a copy of the last sixteen grades, never the expected text. */
  results(): VisionTrialResult[] { return structuredClone(this.completed); }

  /** Compare all twelve strings exactly, then start a new sample with the selected settings. */
  async apply(value: unknown): Promise<{ result: VisionTrialResult; next: VisionTrial }> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected trial submission.");
    const input = value as Record<string, unknown>;
    if (Object.keys(input).sort().join(",") !== "answers,settings,trial" || typeof input.trial !== "string") throw new Error("Invalid trial fields.");
    const sample = this.samples.get(input.trial);
    if (!sample) throw new Error("Trial expired or already graded.");
    const settings = validateVisionSettings(input.settings);
    if (!Array.isArray(input.answers) || input.answers.length !== rows.length) throw new Error("Submit twelve answers.");
    const answers = input.answers as Answer[];
    for (const [index, answer] of answers.entries()) {
      if (!answer || typeof answer !== "object" || Object.keys(answer).sort().join(",") !== "row,text" ||
        answer.row !== index + 1 || typeof answer.text !== "string" || answer.text.length > 200) throw new Error("Invalid or duplicate answer row.");
    }
    if (this.busy) throw new Error("An Apply is already running; do not repeat it.");
    this.busy = true;
    try {
      const next = await this.generate();
      const result: VisionTrialResult = { trial: sample.id, configuration: { ...sample.configuration },
        rows: answers.map((answer, index) => ({ ...rows[index], status: answer.text === sample.text[index] ? "correct" : "wrong" })) };
      next.configuration = this.images.update(settings);
      this.samples.delete(sample.id);
      this.completed.push(result); this.completed = this.completed.slice(-16);
      return { result: structuredClone(result), next: this.retain(next) };
    } finally { this.busy = false; }
  }
}
