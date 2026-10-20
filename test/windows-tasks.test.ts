import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { WINDOWS_TASKS, confirmation, finalAnswer, inputFiles, type TaskOutcome } from "../bench/windows-tasks.ts";

// LPT-838: the benchmark is only as honest as its checks. Each task must pass on its real outcome and fail without it.
const utf16 = (value: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, "utf16le")]);
const files = (entries: Record<string, string | Buffer>) => new Map(Object.entries(entries).map(([name, value]) => [name, Buffer.isBuffer(value) ? value : Buffer.from(value)]));
const input = inputFiles();

/** Run the synthetic form page's own script with a minimal document and press Submit. */
function submitForm(name: string, email: string): string {
  const script = /<script>([\s\S]*)<\/script>/.exec(input.get("form.html")!.toString())![1];
  const elements: Record<string, { value?: string; textContent?: string; onclick?: () => void }> = { name: { value: name }, email: { value: email }, submit: {}, result: {} };
  new Function("document", script)({ getElementById: (id: string) => elements[id] });
  elements.submit.onclick!();
  return elements.result.textContent!.replace("Confirmation code: ", "");
}

const done: Record<string, TaskOutcome> = {
  "cmd-write": { files: files({ "hello.txt": "hello sandbox \r\n" }) },
  "explorer-folders": { files: files({ "reports/": "", "reports/2026/": "" }) },
  "explorer-copy": { files: files({ "final.txt": input.get("draft.txt")! }) },
  "explorer-largest": { files: files({}), answer: "gamma" },
  "count-files": { files: files({}), answer: "7" },
  "powershell-hash": { files: files({ "hash.txt": utf16(`${createHash("sha256").update(input.get("data.bin")!).digest("hex").toUpperCase()}\r\n`) }) },
  "regedit-read": { files: files({}), answer: "C:\\WINDOWS" },
  "regedit-export": { files: files({ "pibench.reg": utf16("Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\PiBench]\r\n\"Answer\"=\"42\"\r\n") }) },
  "edge-form": { files: files({}), answer: submitForm("Ada Lovelace", "ada@example.com") },
  "edge-table": { files: files({}), answer: "`Copper wire`" },
};

test("each task passes on its real outcome and fails on an empty one", () => {
  expect(WINDOWS_TASKS.map(task => task.id)).toEqual(Object.keys(done));
  for (const task of WINDOWS_TASKS) {
    expect(task.check(done[task.id]), task.id).toMatchObject({ passed: true });
    expect(task.check({ files: new Map() }).passed, task.id).toBe(false);
  }
});

test("wrong answers and near-miss files fail", () => {
  const task = (id: string) => WINDOWS_TASKS.find(item => item.id === id)!;
  expect(task("explorer-largest").check({ files: new Map(), answer: "epsilon.txt" }).passed).toBe(false);
  expect(task("regedit-read").check({ files: new Map(), answer: "C:\\Windows\\System32" }).passed).toBe(false);
  expect(task("edge-form").check({ files: new Map(), answer: confirmation("Ada", "ada@example.com") }).passed).toBe(false);
  expect(task("explorer-copy").check({ files: files({ "final.txt": "Quarterly draft v3" }) }).passed).toBe(false);
  expect(task("regedit-export").check({ files: files({ "pibench.reg": utf16("[HKEY_CURRENT_USER\\Software\\PiBench]\r\n\"Answer\"=dword:0000002a\r\n") }) }).passed).toBe(false);
});

test("the final answer is the last ANSWER line of the last assistant text", () => {
  const assistant = (value: string) => ({ role: "assistant", content: [{ type: "text", text: value }] });
  expect(finalAnswer([assistant("ANSWER: old"), { role: "user", content: [] }, assistant("Done.\nANSWER: gamma.csv")])).toBe("gamma.csv");
  expect(finalAnswer([assistant("ANSWER: old"), assistant("I could not finish.")])).toBeUndefined();
  expect(finalAnswer([])).toBeUndefined();
});
