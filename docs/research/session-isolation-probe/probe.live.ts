// Research probe for LPT-848 (docs/research/windows-session-isolation.md): the CUA driver inside an MXC isolation session on the test machine.
// Run with a vitest config that includes this file; needs wxc-exec.exe in %TEMP%\mxc and the runtime in C:\Users\Public\pi-mxc.
import { test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { McpDriver } from "../../../src/driver.ts";
import { WINDOWS_POWERSHELL, sshRunner } from "../../../src/runner.ts";
import { runnerHost, waitForGuestDriver } from "../../../src/sandbox.ts";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
test("cua driver inside an MXC isolation session", async () => {
  const runner = sshRunner("lab-wsl");
  const script = Buffer.from(await readFile(new URL("session.ps1", import.meta.url), "utf8"), "utf16le").toString("base64");
  const config = { version: "0.9.0-alpha", containerId: "PiCuaProbe", containment: "isolation_session",
    process: { commandLine: `powershell.exe -NoProfile -EncodedCommand ${script}`, cwd: "C:\\Windows", inheritDefaultEnv: true, timeout: 200000 },
    network: { egress: { default: "allow" }, ingress: { default: "allow", hostLoopback: "allow" } } };
  await runner.run("bash", ["-c", "cat > /mnt/c/Users/user/AppData/Local/Temp/mxc/cua.json"], { input: JSON.stringify(config) });
  await runner.run("bash", ["-c", "cat > /mnt/c/Users/user/AppData/Local/Temp/mxc/host-reverse.ps1"], { input: await readFile(new URL("host-reverse.ps1", import.meta.url), "utf8") });
  const relay = runner.spawn(WINDOWS_POWERSHELL, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\Users\\user\\AppData\\Local\\Temp\\mxc\\host-reverse.ps1"]);
  let clientPort = 0;
  relay.stdout.on("data", d => { const m = /ports (\d+) (\d+)/.exec(String(d)); if (m) clientPort = Number(m[1]); console.log("RELAY", String(d).trim()); });
  relay.stderr.on("data", d => console.log("RELAY-ERR", String(d).trim().slice(0, 300)));
  await sleep(3000);
  const child = runner.spawn("bash", ["-c", "cd /mnt/c/Users/user/AppData/Local/Temp/mxc && ./wxc-exec.exe --experimental 'C:\\Users\\user\\AppData\\Local\\Temp\\mxc\\cua.json'"]);
  child.stdout.on("data", d => console.log("SESSION", String(d).trim().slice(0, 300)));
  child.stderr.on("data", d => console.log("SESSION-ERR", String(d).trim().slice(0, 300)));
  await sleep(12000);
  const tunnel = await runnerHost(runner).forward(clientPort);
  const driver = new McpDriver({ command: "/mnt/c/Users/Public/pi-mxc/runtime/cua-driver.exe", runtime: "windows-desktop", ssh: "lab-wsl",
    endpoint: { url: `http://127.0.0.1:${tunnel.port}/mcp`, token: "pi-mxc-probe-token-0123456789abcdef0123456789", identityPort: 1 } });
  try {
    await waitForGuestDriver(driver, undefined, 60_000);
    const list = await driver.call("list_windows", {});
    const windows = (list.structuredContent?.windows ?? []) as { pid: number; window_id: number; title?: string; app_name?: string }[];
    console.log("WINDOWS", JSON.stringify(windows.map(w => [w.app_name, w.title, w.pid, w.window_id])));
    const np = windows.find(w => /notepad/i.test(`${w.app_name} ${w.title}`))!;
    const state = await driver.call("get_window_state", { pid: np.pid, window_id: np.window_id, include_screenshot: true });
    const img = state.content.find(c => c.type === "image") as { data: string } | undefined;
    if (img) await writeFile(".tmp/notepad-before.png", Buffer.from(img.data, "base64"));
    console.log("STATE", state.isError, JSON.stringify(state.structuredContent ?? {}).slice(0, 200));
    for (const mode of ["background", "foreground"]) {
      const t = await driver.call("type_text", { pid: np.pid, window_id: np.window_id, text: `${mode} works `, delivery_mode: mode });
      console.log("TYPE", mode, t.isError, JSON.stringify(t.structuredContent ?? t.content).slice(0, 250));
    }
    const after = await driver.call("get_window_state", { pid: np.pid, window_id: np.window_id, include_screenshot: true });
    const img2 = after.content.find(c => c.type === "image") as { data: string } | undefined;
    if (img2) await writeFile(".tmp/notepad-after.png", Buffer.from(img2.data, "base64"));
    const desk = await driver.call("get_desktop_state", {});
    console.log("DESKTOP", desk.isError, JSON.stringify(desk.structuredContent ?? {}).slice(0, 200));
  } finally { await driver.close(); tunnel.close(); child.kill(); relay.kill(); }
});
