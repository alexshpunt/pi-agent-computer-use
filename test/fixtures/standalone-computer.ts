import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ComputerResources } from "../../src/computer-resources.ts";
import type { ComputerMode, ComputerResult, ComputerSession } from "../../src/session.ts";
import { registerStandaloneTools } from "../../src/standalone-tools.ts";

export const STANDALONE_TOOLS = ["computer_read", "computer_search", "computer_write", "computer_insert"];

/**
 * Register the production standalone tools over a fixture session and declare them at once. tool_search
 * discovery itself is covered by extension-modes.integration.test.ts; these fixtures test the tools.
 */
export function registerFixtureComputerTools(pi: ExtensionAPI, getSession: (cwd: string) => Promise<ComputerSession>,
  closeSession: () => Promise<ComputerResult>, getMode?: () => ComputerMode): ComputerResources {
  const resources = new ComputerResources(getSession, closeSession, undefined, undefined, getMode);
  pi.on("session_start", () => {
    registerStandaloneTools(pi, resources, "Fixture computer guide.");
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...STANDALONE_TOOLS])]);
  });
  return resources;
}

/**
 * Codemode helpers that read returned addresses and hints from the tools' readable results, as an agent does.
 * computer_read resolves to a string, or to an image block whose note carries the same text.
 */
export const SCRIPT_HELPERS = String.raw`
const body = value => typeof value === "string" ? value : value.note ?? value.text ?? "";
const address = (value, kind, label) => {
  const match = body(value).match(new RegExp((label ? label + ": " : "") + "(computer:" + kind + "/[\\w-]+)"));
  if (!match) throw Error("No " + kind + " address in: " + body(value).slice(0, 600));
  return match[1];
};
const observation = value => address(value, "observation", "Observation");
const hints = value => [...body(value).matchAll(/^(\d+:[a-z]+) \| /gm)].map(match => match[1]);
const insert = (path, command) => tools.computer_insert({ path, text: JSON.stringify(command) });
const windows = async query => tools.computer_search({ path: "computer:machine/local/windows", query: query ?? "" });
const openApp = app => insert("computer:machine/local", { action: "open", app });
`;

/** The computer tool calls a Codemode script made, in order, with their real results. */
export function nestedCalls(executions: readonly { toolCallId: string; toolName?: string; result?: unknown; isError?: boolean }[], parent: string) {
  return executions.filter(execution => execution.toolCallId.startsWith(`${parent}/`)).map(execution => {
    const result = (execution.result ?? {}) as { details?: Record<string, any> };
    const details = result.details ?? {};
    const computer = (details.computer ?? (details.metadata as { semanticAction?: unknown } | undefined)?.semanticAction ?? details) as Record<string, any>;
    return { name: execution.toolName, isError: execution.isError, details, computer };
  });
}
