import { afterAll, expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { connectLive, text } from "./remote.ts";

// LPT-821: an app builds a scene through its own scripting while computer use observes and verifies it.
// Blender runs portable from BLENDER_PATH on the machine (default: the test machine user folder; no installer needed).
const live = await connectLive();
const blender = process.env.BLENDER_PATH ?? "C:\\Users\\user\\AppData\\Local\\Programs\\Blender\\blender-5.2.2-windows-x64\\blender.exe";
let window = "";
afterAll(async () => { if (window) await live.insert(window, { action: "kill" }); await live.close(); });

test("a Blender scene built by a script is checked through a window Read", async () => {
  await mkdir(".tmp", { recursive: true });
  await writeFile(".tmp/pi-scene.py", [
    "import bpy",
    "bpy.ops.object.select_all(action='SELECT')",
    "bpy.ops.object.delete()  # the default camera, cube and light; a short outliner then lists only the scene built here",
    "for name, add, location in (('PiCube', bpy.ops.mesh.primitive_cube_add, (0, 0, 1)), ('PiSphere', bpy.ops.mesh.primitive_uv_sphere_add, (3, 0, 1))):",
    "    add(location=location)",
    "    bpy.context.object.name = name",
    "bpy.ops.mesh.primitive_plane_add(size=10)",
    "bpy.context.object.name = 'PiGround'",
  ].join("\n"));
  const put = await live.insert(live.machine, { action: "put", from: ".tmp/pi-scene.py", name: "scene.py" });
  expect(put.details.status, text(put)).toBe("delivered");
  const opened = await live.insert(live.machine, { action: "open", path: blender, args: ["--factory-startup", "--python", put.details.state!.path as string] });
  expect(opened.details.status, text(opened)).toBe("observed");
  window = `computer:window/${opened.details.window_ref}`;
  // The splash screen covers the viewport until the first click; the outliner on the right stays visible.
  let names: string[] = [];
  for (let attempt = 0; attempt < 10 && !["PiCube", "PiSphere", "PiGround"].every(name => names.includes(name)); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    // The outliner sits in the top-right corner; region OCR enlarges it, which small Remote Desktop text needs.
    const read = await live.read(window, ['capture:{"granularity":"image","maxLongEdge":3840}']);
    const { width, height } = (read.details.agent_image as { output: { width: number; height: number } }).output;
    const corner = await live.read(`computer:observation/${read.details.observation_id}`, [`region:${Math.round(width * 0.7)},0,${Math.round(width * 0.3)},${Math.round(height * 0.4)}`, "ocr"]);
    names = (corner.details.text_lines ?? []).flatMap(line => line.words.map(word => word.text));
  }
  console.log("outliner words", JSON.stringify(names));
  expect(names).toEqual(expect.arrayContaining(["PiCube", "PiSphere", "PiGround"]));
  const state = await live.read(window, ["state"]);
  expect(state.details.process).toMatchObject({ responding: true });
});
