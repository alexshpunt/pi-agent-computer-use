import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getToolExecutionDetails, getToolExecutions, PiRun } from "pi-coding-agent-test";

// Export only a completed successful run and owned disposable-window evidence, never the full session.
const summary = JSON.parse(await readFile(".tmp/native-yolo-summary.json", "utf8"));
if (!summary.success) throw new Error("Native qualification did not pass; do not export it as success.");
const run = await PiRun.open(path.resolve(summary.artifacts.directory));
const executions = getToolExecutions(run);
const owned = [summary.canary, ...summary.opened];
const belongs = target => target && owned.some(window => target.pid === window.pid && target.window_id === window.window_id);
const observed = executions.filter(execution => {
  const details = getToolExecutionDetails(execution);
  return details?.status === "observed" && belongs(details.target);
});
const withValue = value => observed.find(execution => getToolExecutionDetails(execution).state.elements
  .some(element => element.role === "Document" && element.value === value));
const selected = [
  ["canary-blank", observed.find(execution => getToolExecutionDetails(execution).target.window_id === summary.canary.window_id)],
  ["canary-written", withValue("YOLO existing window 363")],
  ["automatic-written", withValue("YOLO automatic window 363")],
  ["calculator", observed.find(execution => /calculator/i.test(getToolExecutionDetails(execution).state.window_title ?? ""))],
];
const directory = "docs/evidence/yolo";
await mkdir(directory, { recursive: true });
for (const [name, execution] of selected) {
  const image = execution?.result?.content?.find(block => block.type === "image" && block.mimeType === "image/png");
  if (!image) throw new Error(`Missing ${name} grounding PNG.`);
  await writeFile(`${directory}/${name}.png`, Buffer.from(image.data, "base64"));
}
const evidence = {
  model: { provider: run.state.model?.provider, id: run.state.model?.id }, driverVersion: summary.driverVersion,
  canary: summary.canary, opened: summary.opened, remaining: summary.remaining,
  toolNames: summary.toolNames, toolCallCount: summary.toolNames.length,
  results: executions.map(execution => {
    const details = getToolExecutionDetails(execution);
    const state = details?.state;
    return { callId: execution.toolCallId, tool: execution.toolName, isError: execution.isError,
      status: details?.status, mode: details?.mode, opened: details?.opened,
      ...(belongs(details?.target) ? { target: details.target, window_ref: details.window_ref,
        observation_id: details.observation_id, snapshot: state?.snapshot_id,
        title: state?.window_title, truncated: state?.truncated, elements_complete: state?.elements_complete,
        values: state?.elements?.filter(element => element.value).map(element => ({ role: element.role, label: element.label, value: element.value })),
        effect: state?.effect, delivery: state?.delivery, route: state?.route, summary: state?.summary,
        native_message: state?.native_message } : {}),
    };
  }),
};
await writeFile(`${directory}/run.json`, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify({ images: selected.map(([name]) => `${directory}/${name}.png`),
  toolCallCount: evidence.toolCallCount, remaining: evidence.remaining }, null, 2));
