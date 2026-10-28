import { RpcClient } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("human visual commands persist preferences and restore the selected Pi branch without model work", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "computer-visual-commands-"));
  const client = new RpcClient({ cwd,
    cliPath: path.join(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js"),
    env: { PI_CODING_AGENT_DIR: path.join(cwd, "agent"), PI_OFFLINE: "1" },
    args: ["--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--approve",
      "--extension", path.resolve("test/fixtures/visual-commands-extension.ts")],
  });
  const probe = async () => {
    expect(await client.prompt("/visual-probe")).toBe("handled");
    return JSON.parse(await readFile(path.join(cwd, "preferences.json"), "utf8")) as {
      visuals: { preset: string; previews: boolean; keyboard: boolean; quality: string };
      images: { maxLongEdge: number; hints: boolean };
    };
  };
  try {
    await client.start();
    const commands = await client.getCommands();
    expect(commands.filter(command => command.name === "computer-visuals")).toHaveLength(1);
    expect(commands.filter(command => command.name === "computer-images")).toHaveLength(1);
    expect(await client.prompt("/computer-visuals subtle")).toBe("handled");
    const saved = (await client.getEntries()).entries.filter(entry => entry.type === "custom" && entry.customType === "computer-use-visuals");
    expect(saved).toHaveLength(1);
    expect((await probe()).visuals).toMatchObject({ preset: "subtle", previews: false });
    expect(await client.prompt('/computer-visuals {"preset":"full","keyboard":false,"quality":"high"}')).toBe("handled");
    expect((await probe()).visuals).toMatchObject({ preset: "full", keyboard: false, quality: "high" });
    expect(await client.prompt(`/visual-navigate ${saved[0].id}`)).toBe("handled");
    expect((await probe()).visuals).toMatchObject({ preset: "subtle", previews: false, keyboard: true, quality: "balanced" });
    expect(await client.prompt("/computer-images cap 960")).toBe("handled");
    expect(await client.prompt("/computer-images hints off")).toBe("handled");
    expect((await probe()).images).toMatchObject({ maxLongEdge: 960, hints: false });
    expect(await client.prompt('/computer-visuals {"constructor":false}')).toBe("handled");
    expect((await probe()).visuals).toMatchObject({ preset: "subtle", previews: false });
    expect((await client.getEntries()).entries.filter(entry => entry.type === "custom" && entry.customType === "computer-use-visuals")).toHaveLength(2);
    expect((await client.getMessages()).filter(message => message.role === "assistant")).toHaveLength(0);
    expect(client.getStderr()).toBe("");
  } finally { await client.stop(); await rm(cwd, { recursive: true, force: true }); }
});
