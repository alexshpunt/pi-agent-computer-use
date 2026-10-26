import { afterAll, expect, test } from "vitest";
import { performComputer, readComputer } from "../../src/provider.ts";
import { connectLive, nativeForm, openWindow, WINDOWS_POWERSHELL_PATH } from "./remote.ts";

// LPT-932: on a configured machine, results show short addresses with the machine, and a named window is used by name.
const live = await connectLive();
const name = process.env.LIVE_MACHINE ?? "lab";
afterAll(() => live.close());
const read = async (source: string, views?: string[]) => {
  const result = await readComputer(live.resources, source, live.cwd, { views }, false);
  return result.content[0].type === "text" ? result.content[0].text : "";
};
const insert = (source: string, command: unknown) => performComputer(live.resources, "insert", source, { path: source, text: JSON.stringify(command) }, live.cwd);

test("a window is read and acted on by its short address and by a name, and the name ends with the window", async () => {
  const title = `pi-short-${Date.now()}`;
  const long = await openWindow(live, live.machine, WINDOWS_POWERSHELL_PATH, nativeForm(title), title);
  const named = await insert(live.machine, { action: "name", as: "form", title });
  expect(named.script.outcome, named.summary).toBe("delivered");
  const short = named.script.window as string;
  expect(short).toMatch(new RegExp(`^computer:${name}/w\\d+[a-z]{2}$`));
  const view = await read(short, ["ui"]);
  expect(view).toMatch(new RegExp(`^Computer observed \\(yolo\\) on ${name}\\nWindow: ${short}\\nObservation: computer:${name}/o\\d+[a-z]{2}$`, "m"));
  expect(view).not.toMatch(/computer:(window|observation)\/[wd0-9a-f-]{8}/);
  // Act by name: a locator click on the form's counter button.
  const clicked = await insert("computer:form", { action: "click", target: "getByRole('button', { name: 'Count 0' })" });
  expect(clicked.script.outcome, clicked.summary).toBe("delivered");
  expect(await read("computer:form", ["ui"])).toContain("Count 1");
  expect(await read("computer:session")).toMatch(new RegExp(`computer:form → ${short} \\| ${title}`));
  // Closing the window ends the name once a full listing shows it gone.
  const state = await live.read(long, ["state"]);
  await live.closeWindow((state.details.target as { window_id: number }).window_id);
  for (let i = 0; i < 20 && ((await live.search(live.windows, title)).details.state?.windows as unknown[] | undefined)?.length; i++) await new Promise(resolve => setTimeout(resolve, 500));
  await live.search(live.windows, "");
  const gone = await insert("computer:form", { action: "click", target: "getByRole('button')" });
  expect(gone.script.outcome).toBe("refused");
  expect(gone.summary).toMatch(/No window is named form/);
});
