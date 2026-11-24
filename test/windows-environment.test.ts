import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { windowsSystemEnvironment } from "../src/driver.ts";

test("the driver keeps the Windows variables programs need to start other programs, not Pi's secrets", () => {
  const env = windowsSystemEnvironment({ PATHEXT: ".COM;.EXE;.BAT;.CMD", WINDIR: "C:\\WINDOWS", ComSpec: "C:\\WINDOWS\\system32\\cmd.exe", OPENAI_API_KEY: "secret" });
  expect(env).toEqual({ PATHEXT: ".COM;.EXE;.BAT;.CMD", WINDIR: "C:\\WINDOWS", ComSpec: "C:\\WINDOWS\\system32\\cmd.exe" });
});

// The driver inherits what the MCP stdio transport passes plus these variables; a PowerShell it launches then runs .exe files.
test.skipIf(process.platform !== "win32")("a PowerShell started with the driver's Windows environment runs native programs", () => {
  const minimal = Object.fromEntries(["APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERNAME", "USERPROFILE", "PROGRAMFILES"]
    .flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
  const script = "& \"$env:SystemRoot\\System32\\whoami.exe\" | Out-Null; if ($?) { 'ran' }";
  const run = (env: Record<string, string>) => spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { env, encoding: "utf8", timeout: 30_000 });
  expect(run({ ...minimal, ...windowsSystemEnvironment() }).stdout.trim()).toBe("ran");
});
