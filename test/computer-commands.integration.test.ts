import { RpcClient } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("Computer Use exposes only settings, mode and setup commands", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "computer-commands-"));
  const client = new RpcClient({ cwd,
    cliPath: path.join(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js"),
    env: { PI_CODING_AGENT_DIR: path.join(cwd, "agent"), PI_OFFLINE: "1" },
    args: ["--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--approve", "--extension", path.resolve("src/index.ts")],
  });
  try {
    await client.start();
    const names = (await client.getCommands()).filter(command => command.name.startsWith("computer-")).map(command => command.name).sort();
    expect(names).toEqual(["computer-mode", "computer-settings", "computer-setup"]);
  } finally { await client.stop(); await rm(cwd, { recursive: true, force: true }); }
});
