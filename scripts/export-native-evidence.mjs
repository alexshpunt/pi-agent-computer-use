import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getToolExecutionDetails, getToolExecutions, PiRun } from "pi-coding-agent-test";

// Export only the owned test-window images and compact action evidence, not credentials or the full transcript.
const source = path.resolve(".tmp/native-runs/native-windows-notepad");
const run = await PiRun.open(source);
const executions = getToolExecutions(run);
const observations = executions.filter((e) => e.toolName === "computer_observe"
  && getToolExecutionDetails(e)?.status === "observed");
await mkdir("docs/evidence", { recursive: true });
for (const [name, execution] of [["notepad-initial", observations[0]], ["notepad-final", observations.at(-1)]]) {
  const image = execution?.result?.content?.find((c) => c.type === "image" && c.mimeType === "image/png");
  if (!image) throw new Error(`Missing ${name} PNG`);
  await writeFile(`docs/evidence/${name}.png`, Buffer.from(image.data, "base64"));
}
const evidence = {
  model: run.state.model,
  target: getToolExecutionDetails(observations[0]).target,
  observations: observations.map((e) => {
    const details = getToolExecutionDetails(e);
    return {
      toolCallId: e.toolCallId,
      title: details.state.window_title,
      snapshot: details.state.snapshot_id,
      truncated: details.state.truncated,
      values: details.state.elements.filter((element) => element.value).map((element) => ({
        role: element.role, label: element.label, value: element.value,
      })),
    };
  }),
  actionInputs: run.messages.filter((message) => message.role === "assistant")
    .flatMap((message) => message.content).filter((block) => block.type === "toolCall" && block.name === "computer_act"),
  actionResults: executions.filter((e) => e.toolName === "computer_act").map((e) => ({
    toolCallId: e.toolCallId,
    isError: e.isError,
    ...getToolExecutionDetails(e),
  })),
};
await writeFile("docs/evidence/notepad-run.json", JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence, null, 2));
