import { expect, test, vi } from "vitest";
import { computerSource } from "../src/computer-address.ts";
import { ComputerRequestError, ComputerResources, type OpenedMachine } from "../src/computer-resources.ts";
import { loadComputerConfig } from "../src/config.ts";
import { computerAction, readComputer } from "../src/provider.ts";
import { ShortAddresses } from "../src/short-addresses.ts";
import { ComputerSession, type Driver } from "../src/session.ts";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const cwd = "/synthetic-short-addresses";

/** A native backend with two windows (titles "Game" and "Game settings"); either can be closed. */
function backend(pid: number) {
  const open = new Set([7, 8]);
  const driver: Driver = {
    identity: vi.fn(async (target: { window_id: number }) => open.has(target.window_id) ? `life-${pid}-${target.window_id}` : undefined) as Driver["identity"],
    close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async (name, args) => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [...open].map(id => ({ pid, window_id: id, title: id === 7 ? "Game" : "Game settings" })) } };
      if (name === "get_window_state") return { content: [], structuredContent: { pid, window_id: (args as { window_id: number }).window_id, snapshot_id: "s", elements_complete: true, elements: [],
        ...((args as { include_screenshot?: boolean }).include_screenshot !== false ? { screenshot_error: "No surface." } : {}), window_bounds: { x: 0, y: 0, width: 100, height: 80 } } };
      throw new Error(`Unexpected native call ${name}`);
    }),
  };
  return { driver, close: (id: number) => open.delete(id) };
}

function fixture() {
  const host = backend(10), remote = backend(20);
  const hostSession = new ComputerSession(host.driver, () => "yolo"), remoteSession = new ComputerSession(remote.driver, () => "yolo");
  const machine: OpenedMachine = { ref: "lab", session: remoteSession, describe: source => source, close: () => remoteSession.close() };
  const resources = new ComputerResources(async () => hostSession, async () => hostSession.close(), undefined, async () => machine);
  const search = async (source: string, query = "") => (await resources.search(resources.address(source), cwd, query)).details.state!.windows as { window_ref: string; title: string }[];
  // computer_window name: the receipt and summary the tool returns.
  const name = (source: string, as: string) => computerAction(resources, source, "name", () => resources.address(source), address => resources.name(address, cwd, as));
  const read = (source: string, views?: string[]) => readComputer(resources, source, cwd, { views }, false);
  const text = (read: Awaited<ReturnType<typeof readComputer>>) => read.content[0].type === "text" ? read.content[0].text : "";
  return { resources, host, remote, search, name, read, text };
}

// LPT-932: the agent sees short addresses with the machine and a run tag, and can name windows.
test("presented addresses are short, per machine and kind, and resolve back to the long ones", async () => {
  const f = fixture();
  const [game] = await f.search("computer:machine/lab/windows", "Game");
  const tag = (f.resources as unknown as { shorts: ShortAddresses }).shorts.tag;
  // Search output lists each window by its short address.
  const listed = await f.read("computer:session");
  expect(f.text(listed)).not.toContain("computer:window/");
  const view = await f.read(computerSource("window", game.window_ref), ["ui"]);
  const body = f.text(view);
  expect(body).toMatch(new RegExp(`^Computer observed \\(yolo\\) on lab\\nWindow: computer:lab/w1${tag}\\nObservation: computer:lab/o1${tag}$`, "m"));
  expect(body).not.toMatch(/computer:(window|observation)\//);
  expect(f.resources.address(`computer:lab/w1${tag}`)).toMatchObject({ kind: "window", ref: game.window_ref });
  expect(f.resources.address(`computer:lab/o1${tag}`)).toMatchObject({ kind: "observation", ref: view.details.computer!.observation_id });
  // The short address works for Read; long addresses still work too.
  expect(f.text(await f.read(`computer:lab/w1${tag}`, ["ui"]))).toContain(`Observation: computer:lab/o2${tag}`);
  // Receipts for scripts carry the short addresses as well.
  const receipt = await f.name(`computer:lab/w1${tag}`, "game");
  expect(receipt.script).toMatchObject({ outcome: "delivered", window: `computer:lab/w1${tag}` });
});

test("an alias from another run, or one never issued, refuses with the reason", () => {
  const f = fixture();
  const tag = (f.resources as unknown as { shorts: ShortAddresses }).shorts.tag;
  const other = tag === "zz" ? "zy" : "zz";
  expect(() => f.resources.address(`computer:lab/w1${other}`)).toThrow(new RegExp(`earlier Pi run.*end in "${tag}"`));
  expect(() => f.resources.address(`computer:lab/w9${tag}`)).toThrow(/never issued in this run/);
  expect(() => f.resources.address(`computer:lab/w1${other}`)).toThrow(ComputerRequestError);
});

test("names resolve to their window, are unique while the window lives, and stop when it closes", async () => {
  const f = fixture();
  const [game] = await f.search("computer:machine/lab/windows", "regex:^Game$");
  const named = await f.name(computerSource("window", game.window_ref), "game");
  expect(named.summary).toMatch(/computer:game now names computer:lab\/w1\w\w \(Game\)/);
  expect(f.resources.address("computer:game")).toMatchObject({ kind: "window", ref: game.window_ref });
  expect(f.text(await f.read("computer:game", ["ui"]))).toMatch(/^Computer observed \(yolo\) on lab/);
  const [other] = await f.search("computer:machine/lab/windows", "settings");
  const settings = await f.name(computerSource("window", other.window_ref), "settings");
  expect(settings.script.outcome).toBe("delivered");
  // Only windows take names.
  expect((await f.name("computer:machine/lab", "lab2")).script.outcome).toBe("refused");
  // A live window's name is not taken over; bad names refuse.
  expect((await f.name("computer:settings", "game")).summary).toMatch(/computer:game already names computer:lab\/w1\w\w \(Game\)/);
  for (const bad of ["window", "lab", "Game", "9x", "a b"]) expect((await f.name("computer:game", bad)).script.outcome).toBe("refused");
  const session = f.text(await f.read("computer:session"));
  expect(session).toMatch(/Window names[\s\S]*- computer:game → computer:lab\/w1\w\w \| Game\n- computer:settings → computer:lab\/w2\w\w \| Game settings/);
  // The window closes: its name disappears from the list and refuses.
  f.remote.close(7);
  await f.search("computer:machine/lab/windows");
  expect(f.text(await f.read("computer:session"))).not.toContain("computer:game →");
  expect(() => f.resources.address("computer:game")).toThrow(/No window is named game/);
  expect(() => f.resources.address("computer:nothing")).toThrow(/No window is named nothing/);
  expect(() => f.resources.address("computer:settings?delivery=foreground")).toThrow(/takes no options/);
});

test("machine names never take an address kind word", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-machines-"));
  await mkdir(path.join(dir, ".pi"));
  for (const name of ["window", "session", "display", "machine"]) {
    await writeFile(path.join(dir, ".pi/computer-use.json"), JSON.stringify({ command: "/x/cua-driver.exe", machines: { [name]: { ssh: "a", command: "/x" } } }));
    await expect(loadComputerConfig(dir)).rejects.toThrow(/Invalid machines/);
  }
});
