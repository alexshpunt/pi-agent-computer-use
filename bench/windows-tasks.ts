/**
 * A small Windows task-success suite for computer use (LPT-838), in the style of WindowsAgentArena.
 *
 * Each trial gives a real Pi agent (this extension plus Pi Agent IDE) one task to do inside a Windows Sandbox that it
 * opens itself on a configured machine. The suite prepares an input folder and an empty output folder on that
 * machine; the sandbox sees them as C:\pi\import\input and C:\pi\export. A task passes when the output folder or the
 * agent's final `ANSWER:` line matches. Only built-in sandbox apps and local synthetic pages are used.
 */
import { createHash } from "node:crypto";
import type { EvalScore, EvalSuite, EvalTask } from "pi-coding-agent-eval";

/** What a check sees: the output folder (directories end in "/") and the agent's final answer, if any. */
export interface TaskOutcome { readonly files: ReadonlyMap<string, Buffer>; readonly answer?: string }

export interface WindowsTask extends EvalTask {
  /** What the agent is asked to do inside the sandbox. */
  readonly task: string;
  /** Pass or fail with the reason, from the trial's outcome. */
  check(outcome: TaskOutcome): { passed: boolean; reason: string };
}

/** The confirmation code the synthetic form shows; the page runs this same function. */
export function confirmation(name: string, email: string): string {
  let hash = 7;
  for (const character of `${name}|${email}`) hash = (hash * 31 + character.charCodeAt(0)) % 1_000_003;
  return `PB-${String(hash).padStart(7, "0")}`;
}

const docs: Record<string, number> = { "alpha.txt": 120, "beta.log": 2048, "gamma.csv": 35_000, "delta.md": 900, "epsilon.txt": 15_000, "zeta.json": 4000, "eta.ini": 300 };
const data = Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 31) % 251));
const draft = "Quarterly draft v3\r\nOwner: Ada\r\n";
const products: [string, number][] = [["Brass hinge", 140], ["Copper wire", 912], ["Steel bolt", 655], ["Oak plank", 87], ["Glass pane", 430], ["Rubber seal", 899]];

/** The input folder's files, by path relative to it. */
export function inputFiles(): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const [name, size] of Object.entries(docs)) files.set(`docs/${name}`, Buffer.alloc(size, name[0]));
  files.set("data.bin", data);
  files.set("draft.txt", Buffer.from(draft));
  files.set("form.html", Buffer.from(`<!doctype html><title>Order form</title>
<label>Name <input id="name"></label> <label>Email <input id="email"></label> <button id="submit">Submit</button>
<p id="result"></p>
<script>${confirmation.toString()}
document.getElementById("submit").onclick = () => { document.getElementById("result").textContent =
  "Confirmation code: " + confirmation(document.getElementById("name").value, document.getElementById("email").value); };</script>`));
  files.set("table.html", Buffer.from(`<!doctype html><title>Stock</title><table border="1"><tr><th>Product</th><th>Units</th></tr>
${products.map(([name, units]) => `<tr><td>${name}</td><td>${units}</td></tr>`).join("\n")}</table>`));
  return files;
}

/** Text of an output file, decoding the UTF-16 that PowerShell and Registry Editor write. */
function text(file: Buffer | undefined): string | undefined {
  if (!file) return undefined;
  return file[0] === 0xff && file[1] === 0xfe ? file.subarray(2).toString("utf16le") : file.toString("utf8").replace(/^\uFEFF/, "");
}
const same = (answer: string | undefined, expected: string) => answer?.trim().replace(/^["'`]|["'`.]$/g, "").toLowerCase() === expected.toLowerCase();
const result = (passed: boolean, reason: string) => ({ passed, reason });
const answered = (expected: string) => (outcome: TaskOutcome) =>
  result(same(outcome.answer, expected), `expected answer ${expected}, got ${outcome.answer ?? "none"}`);

/** The ten tasks, in the order the benchmark runs them. */
export const WINDOWS_TASKS: readonly WindowsTask[] = [
  { id: "cmd-write", task: "Using Command Prompt, create C:\\pi\\export\\hello.txt that contains exactly the line: hello sandbox",
    check: ({ files }) => result(text(files.get("hello.txt"))?.trim() === "hello sandbox", `hello.txt is ${JSON.stringify(text(files.get("hello.txt")))}`) },
  { id: "explorer-folders", task: "Using File Explorer, not a command line, create the folder C:\\pi\\export\\reports\\2026.",
    check: ({ files }) => result(files.has("reports/2026/"), "reports/2026 must exist") },
  { id: "explorer-copy", task: "Using File Explorer, copy C:\\pi\\import\\input\\draft.txt into C:\\pi\\export and rename the copy to final.txt.",
    check: ({ files }) => result(files.get("final.txt")?.toString() === draft, "final.txt must equal draft.txt") },
  { id: "explorer-largest", task: "Using File Explorer, find the largest file in C:\\pi\\import\\input\\docs. Answer with its file name.",
    // File Explorer hides known extensions by default, so the bare name counts too.
    check: outcome => result(same(outcome.answer, "gamma.csv") || same(outcome.answer, "gamma"), `expected answer gamma.csv, got ${outcome.answer ?? "none"}`) },
  { id: "count-files", task: "How many files are in C:\\pi\\import\\input\\docs? Use any app in the sandbox. Answer with the number.",
    check: answered(String(Object.keys(docs).length)) },
  { id: "powershell-hash", task: "Using Windows PowerShell, write the SHA-256 hash of C:\\pi\\import\\input\\data.bin as hex into C:\\pi\\export\\hash.txt.",
    check: ({ files }) => {
      const expected = createHash("sha256").update(data).digest("hex");
      return result(text(files.get("hash.txt"))?.toLowerCase().includes(expected) ?? false, `hash.txt must contain ${expected}`);
    } },
  { id: "regedit-read", task: "Using Registry Editor, read the SystemRoot value under HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion. Answer with that value.",
    check: answered("C:\\Windows") },
  { id: "regedit-export", task: "Using Registry Editor, create the key HKEY_CURRENT_USER\\Software\\PiBench with a string value named Answer set to 42, then export that key with File > Export to C:\\pi\\export\\pibench.reg.",
    check: ({ files }) => {
      const exported = text(files.get("pibench.reg")) ?? "";
      return result(exported.includes("[HKEY_CURRENT_USER\\Software\\PiBench]") && exported.includes("\"Answer\"=\"42\""), "pibench.reg must hold the key with Answer=42");
    } },
  { id: "edge-form", task: "Open C:\\pi\\import\\input\\form.html in Microsoft Edge, enter the name Ada Lovelace and the email ada@example.com, press Submit and answer with the confirmation code the page shows.",
    check: answered(confirmation("Ada Lovelace", "ada@example.com")) },
  { id: "edge-table", task: "Open C:\\pi\\import\\input\\table.html in Microsoft Edge and answer with the name of the product that has the most units.",
    check: answered(products.reduce((best, row) => row[1] > best[1] ? row : best)[0]) },
];

/** The answer on the agent's last `ANSWER:` line, if it gave one. */
export function finalAnswer(messages: readonly unknown[]): string | undefined {
  for (const message of [...messages].reverse() as { role?: string; content?: unknown }[]) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const body = (message.content as { type?: string; text?: string }[]).filter(block => block.type === "text").map(block => block.text).join("\n");
    const line = body.split(/\r?\n/).reverse().find(item => /^\s*ANSWER:/i.test(item));
    if (line) return line.replace(/^\s*ANSWER:\s*/i, "").trim();
    if (body.trim()) return undefined;
  }
  return undefined;
}

/** The machine a trial runs on: its two folders and the output after the run. */
export interface BenchHost {
  /** Configured machine name the agent works on. */
  readonly machine: string;
  /** Create the trial's input and empty output folders; returns their Windows paths on that machine. */
  prepare(trialId: string, files: ReadonlyMap<string, Buffer>): Promise<{ input: string; output: string }>;
  /** Every file and directory in the output folder. */
  collect(trialId: string): Promise<Map<string, Buffer>>;
  /** Remove the trial's folders and close a sandbox its agent left open. */
  remove(trialId: string): Promise<void>;
}

interface TrialState { readonly trialId: string; readonly input: string; readonly output: string }

/**
 * The suite. `config` is this extension's `.pi/computer-use.json` content: each trial writes it into the agent's
 * workspace so the agent can use `host.machine`.
 */
export function windowsTaskSuite(host: BenchHost, config: string): EvalSuite<WindowsTask, TrialState> {
  const task = (id: string) => WINDOWS_TASKS.find(item => item.id === id)!;
  return {
    id: "windows-tasks",
    async loadBenchmarkPreset(preset) {
      if (preset !== "windows-10") throw new Error(`Unknown benchmark preset ${preset}; use windows-10.`);
      return { tasks: WINDOWS_TASKS, seed: 20261020, attempts: 1 };
    },
    async prepareTrial({ trial, workspaceDirectory }) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(`${workspaceDirectory}/.pi`, { recursive: true });
      await writeFile(`${workspaceDirectory}/.pi/computer-use.json`, config);
      const trialId = `${trial.pairId}-${trial.task.id}`.replace(/[^A-Za-z0-9-]/g, "-");
      const folders = await host.prepare(trialId, inputFiles());
      return { cwd: workspaceDirectory, state: { trialId, ...folders } };
    },
    prompt({ trial, prepared }) {
      const { input, output } = prepared.state;
      return [`Use computer use to do one task on the configured machine "${host.machine}", inside a new Windows Sandbox only.`,
        "Insert", JSON.stringify({ action: "open_sandbox", import: [input], export: output }),
        `into computer:machine/${host.machine}. In the sandbox, the input folder is C:\\pi\\import\\input and the output folder is C:\\pi\\export.`,
        "Close the sandbox when you are done. Do not touch anything outside the sandbox.",
        "", `Task: ${trial.task.task}`, "",
        "If the task asks for an answer, end your final message with one line: ANSWER: <value>"].join("\n");
    },
    async validate({ trial, prepared, piResult }): Promise<EvalScore> {
      const outcome = { files: await host.collect(prepared.state.trialId), answer: finalAnswer(piResult.messages) };
      const verdict = task(trial.task.id).check(outcome);
      return { reward: verdict.passed ? 1 : 0, passed: verdict.passed,
        details: { reason: verdict.reason, answer: outcome.answer ?? null, output: [...outcome.files.keys()] } };
    },
    async cleanupTrial({ prepared, keepWorkspace }) {
      if (!keepWorkspace) await host.remove(prepared.state.trialId);
    },
    taskMetadata: item => ({ app: item.id.split("-")[0] }),
  };
}
