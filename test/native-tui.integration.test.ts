import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { IDE_EXTENSION, PI_COMMAND } from "./fixtures/pi-agent-ide.ts";

const root = path.resolve(import.meta.dirname, "..");
const call = (id: string, name: string, args: Record<string, unknown>) => assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
const tools = ["read", "search", "write", "insert", "delete", "codemode", "fixture_control", "computer_open", "computer_click", "computer_type", "computer_window"];
const w = "computer:local/w1tt";

/** One scripted conversation through the real Pi TUI over the synthetic driver; returns the final screen without trailing blanks. */
async function screenOf(name: string, conversation: ReturnType<typeof call>[], size: { cols: number; rows: number }, expanded: boolean) {
  await mkdir(path.join(root, ".tmp/lpt-856"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/lpt-856/pi-tui-"));
  try {
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath, args: [path.join(root, "test/fixtures/ide-provider-driver.mjs"), path.join(cwd, "calls.jsonl")] }));
    const result = await new PiIntegrationTest({
      testName: name, artifactsDir: testArtifactsDir(import.meta.filename), cwd, isolateUserResources: true, rawMode: false, piCommand: PI_COMMAND, tuiSize: size,
      // The harness expands tool output unless it runs live; compact is the user's normal view.
      environment: expanded ? {} : { PI_INTEGRATION_TEST_LIVE: "1" },
      extensions: [IDE_EXTENSION, path.join(root, "test/fixtures/native-tui-extension.ts")], tools, timeoutMs: 120_000,
      conversation: [...conversation, assistantMessage([text("done")])],
    }).run("Look at the synthetic fixture.");
    return result.tuiRenderedOutput.split("\n").map(line => line.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n");
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

// Contract: every Computer Use call shows a title line and one status line (delivered, unknown, refused), a few
// scannable rows, and never the agent's receipt text, typed input or a guide dump. Layout holds at 60 columns.
const flow = [
  call("c1", "computer_open", { at: "computer:machine/local", app: "Notepad" }),
  call("c2", "search", { path: "computer:machine/local/windows", query: "Owned fixture" }),
  call("c3", "read", { path: w }),
  // Points are pixels of the latest image, so these steps do not depend on how many snapshots came before.
  call("c5", "computer_click", { window: w, x: 240, y: 180 }),
  call("c6", "read", { path: w }),
  call("c7", "fixture_control", { operation: "partial" }),
  call("c8", "computer_click", { window: w, x: 240, y: 180 }),
  call("c9", "fixture_control", { operation: "close_first" }),
  call("c10", "computer_click", { window: w, x: 240, y: 180 }),
  // Not a valid call (typing takes a target, not a point): Pi's own validation refuses it before the tool runs.
  call("c10b", "computer_type", { window: w, text: "PRIVATE_TYPED_TEXT", delay_ms: 0, x: 240, y: 180 }),
  call("c11", "write", { path: "computer:local/o1tt", content: "PRIVATE_WRITTEN_TEXT" }),
  call("c12", "delete", { path: w }),
];

for (const [label, size] of [["normal", { cols: 160, rows: 100 }], ["narrow", { cols: 60, rows: 140 }]] as const) test(`${label} terminal: observation, UI rows and every action outcome read at a glance`, async () => {
  const screen = await screenOf(`states-${label}`, flow, size, false);
  // A narrow terminal wraps lines, so facts are compared with their whitespace collapsed.
  const flat = screen.replace(/\s+/g, " ");
  // Observation and discovery.
  expect(flat).toContain("computer_open Notepad · local ✓ observed · local · image 500×350 · UI 2 elements 1:a Edit “Fixture text field”");
  expect(flat).toContain("✓ listed · local · 2 windows Notepad “Unowned fixture” 1000×700 Notepad “Owned fixture 91” 1000×700 yours");
  // Actions: delivered, unknown (may have been applied), refused (nothing sent), failed before the tool ran.
  expect(flat).toContain("computer_click “Owned fixture 91” · 240,180 ✓ delivered · local");
  expect(flat).toContain("? unknown · local Driver returned unknown for click");
  expect(flat).toContain("✗ refused · local Window closed");
  expect(flat).toContain("computer_type “Owned fixture 91” · 240,180 · 18 chars ✗ failed Validation failed for tool \"computer_type\"");
  // What the agent sends and gets back stays out of the human view.
  for (const hidden of ["PRIVATE_TYPED_TEXT", "PRIVATE_WRITTEN_TEXT", "Computer delivered (yolo)", "# Guide:", "system-result", "Initial fixture value", "\u001b"]) expect(flat, hidden).not.toContain(hidden);
  expect(Math.max(...screen.split("\n").map(line => [...line].length))).toBeLessThanOrEqual(size.cols);
}, 180_000);

test("expanded: exact arguments and details appear on demand, still without typed text", async () => {
  const screen = await screenOf("states-expanded", flow, { cols: 160, rows: 140 }, true);
  expect(screen).toMatch(/computer_click “Owned fixture 91” · 240,180\n .*window=computer:local\/w1tt · x=240 · y=180/);
  // Details carry the receipt's own codes and values.
  expect(screen).toContain("COMPUTER_");
  expect(screen).toContain("unverified");
  for (const hidden of ["PRIVATE_TYPED_TEXT", "PRIVATE_WRITTEN_TEXT", "Computer delivered (yolo)", "system-result"]) expect(screen, hidden).not.toContain(hidden);
}, 180_000);

// Pi's Codemode draws its own activity rows for nested calls and has no hook for a tool to restyle them; they stay as they are.
test("a nested Codemode script keeps Pi's activity rows and returns the receipts to the script", async () => {
  const screen = await screenOf("nested", [call("n1", "codemode", { code: `const open = await tools.computer_open({ at: "computer:machine/local", app: "Notepad" });
const view = await tools.read({ path: open.window });
const click = await tools.computer_click({ window: open.window, x: 240, y: 180 });
text(JSON.stringify({ open: open.outcome, click: click.outcome }));` })], { cols: 160, rows: 100 }, false);
  expect(screen).toMatch(/✓ computer_open /);
  expect(screen).toMatch(/✓ read /);
  expect(screen).toMatch(/✓ computer_click /);
  expect(screen).toContain('{"open":"observed","click":"delivered"}');
}, 180_000);
