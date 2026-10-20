/**
 * Run the Windows task-success benchmark (LPT-838) with a real model on a configured machine.
 *
 *   npm run bench:windows -- [--machine zinpc] [--model provider/id] [--thinking high] [--task <id>]
 *
 * Every trial opens its own Windows Sandbox on that machine, so trials run one at a time. Model and thinking default to
 * Pi's own defaults in ~/.pi/agent/settings.json. Results land in .tmp/bench/results with a Markdown summary table.
 */
import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { runEvaluation } from "pi-coding-agent-eval";
import { machineConfig } from "../src/machine.ts";
import { WINDOWS_POWERSHELL, sshRunner } from "../src/runner.ts";
import { WINDOWS_TASKS, windowsTaskSuite, type BenchHost } from "./windows-tasks.ts";

const repo = path.resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: { machine: { type: "string", default: "zinpc" }, model: { type: "string" },
  thinking: { type: "string" }, task: { type: "string" } } });
const settings = JSON.parse(await readFile(path.join(homedir(), ".pi/agent/settings.json"), "utf8")) as Record<string, string>;
const model = values.model ?? `${settings.defaultProvider}/${settings.defaultModel}`;
const thinking = (values.thinking ?? settings.defaultThinkingLevel ?? "medium") as "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** The trial folders live in the remote user's %LOCALAPPDATA%\PiComputerUse\bench and are reached over SSH. */
async function sshHost(machine: string): Promise<BenchHost> {
  const runner = sshRunner((await machineConfig(repo, machine)).ssh);
  const sh = (script: string, args: string[] = [], input?: Buffer) => runner.run("bash", ["-c", script, "bash", ...args], { ...(input ? { input } : {}), timeoutMs: 60_000 });
  const local = (await sh("cd /mnt/c && /mnt/c/Windows/System32/cmd.exe /c 'echo %LOCALAPPDATA%'")).trim();
  const windows = (trialId: string) => `${local}\\PiComputerUse\\bench\\${trialId}`;
  const started = new Map<string, string>();
  const wsl = (trialId: string) => `/mnt/${local[0].toLowerCase()}/${local.slice(3).replace(/\\/g, "/")}/PiComputerUse/bench/${trialId}`;
  return {
    machine,
    async prepare(trialId, files) {
      started.set(trialId, new Date().toISOString());
      await sh('rm -rf "$1" && mkdir -p "$1/input" "$1/output"', [wsl(trialId)]);
      for (const [name, bytes] of files) await sh('mkdir -p "$(dirname "$1")" && cat > "$1"', [`${wsl(trialId)}/input/${name}`], bytes);
      return { input: `${windows(trialId)}\\input`, output: `${windows(trialId)}\\output` };
    },
    async collect(trialId) {
      // One line per entry: a directory as "path/", a file as "path<TAB>base64".
      const listing = await sh('cd "$1" && find . -mindepth 1 -type d -printf "%P/\\n" && find . -type f -size -2M -printf "%P\\t" -exec sh -c "base64 -w0 \\"\\$0\\"; echo" {} \\;', [`${wsl(trialId)}/output`]);
      return new Map(listing.split("\n").filter(Boolean).map(line => {
        const [name, data] = line.split("\t");
        return [name, Buffer.from(data ?? "", "base64")] as const;
      }));
    },
    async remove(trialId) {
      // A trial that timed out leaves the sandbox its agent opened; only a sandbox started during this trial is closed.
      const since = started.get(trialId);
      if (since) await runner.run(WINDOWS_POWERSHELL, ["-NoProfile", "-Command",
        `Get-Process WindowsSandboxRemoteSession -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge [DateTime]::Parse('${since}') } | Stop-Process -Force`]).catch(() => "");
      await sh('rm -rf "$1"', [wsl(trialId)]);
    },
  };
}

const ide = process.env.PI_AGENT_IDE_EXTENSION ?? path.resolve(repo, "../pi-agent-ide/src/pi-agent-ide.ts");
const suite = windowsTaskSuite(await sshHost(values.machine!), await readFile(path.join(repo, ".pi/computer-use.json"), "utf8"));
const results = path.join(repo, ".tmp/bench/results");
// One evaluation per task: a trial that times out or crashes Pi fails that task instead of ending the run.
const rows: string[] = ["| Task | Passed | Time, s | Tool calls | Tokens | Reason |", "| --- | --- | --- | --- | --- | --- |"];
for (const task of values.task ? [values.task] : WINDOWS_TASKS.map(item => item.id)) {
  try {
    const directory = await runEvaluation({
      suite, benchmarkPreset: "windows-10", taskId: task,
      agentProfiles: [{ id: "computer-use", extensions: [ide, path.join(repo, "src/index.ts")], skills: [path.join(repo, ".pi/skills/computer-use")] }],
      model, thinking, resultsDirectory: results, workspacesDirectory: path.join(tmpdir(), "pi-computer-use-bench"), timeoutMs: 20 * 60_000,
    });
    const trial = (JSON.parse(await readFile(path.join(directory, "summary.json"), "utf8")) as { trials: { score: { passed: boolean; details?: { reason?: string } };
      metrics: Record<string, number> }[] }).trials[0];
    rows.push(`| ${task} | ${trial.score.passed ? "yes" : "no"} | ${Math.round(trial.metrics.elapsedSeconds)} | ${trial.metrics.toolCalls} | ${trial.metrics["usage.totalTokens"]} | ${trial.score.details?.reason ?? ""} |`);
  } catch (error) {
    rows.push(`| ${task} | no | | | | ${(error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 160)} |`);
  }
  console.log(rows.at(-1));
}
const table = [`Model ${model} (${thinking}), machine ${values.machine}, ${new Date().toISOString()}`, "", ...rows].join("\n");
await writeFile(path.join(results, `summary-${Date.now()}.md`), table + "\n");
console.log(table);
