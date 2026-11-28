import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/runner.ts";
import { selectRemoteInterop } from "../src/remote-interop.ts";

function remote(sockets: string[], sessions: Record<string, string | Error>): CommandRunner {
  return {
    ssh: "workstation",
    spawn: () => { throw new Error("Unexpected spawn"); },
    run: async (file, _args, options) => {
      if (file === "bash") return sockets.join("\n");
      const result = sessions[options?.env?.WSL_INTEROP ?? ""];
      if (result instanceof Error || result === undefined) throw result ?? new Error("Unavailable");
      return result;
    },
  };
}

describe("selectRemoteInterop", () => {
  it("selects a socket in the active Windows session, not session zero", async () => {
    const runner = remote(["/run/WSL/1_interop", "/run/WSL/10_interop", "/run/WSL/11_interop"], {
      "/run/WSL/1_interop": "0:0", "/run/WSL/10_interop": "1:0", "/run/WSL/11_interop": "1:0",
    });
    expect(await selectRemoteInterop(runner)).toBe("/run/WSL/10_interop");
  });

  it("ignores sockets in disconnected sessions and those that cannot be used", async () => {
    const runner = remote(["/run/WSL/1_interop", "/run/WSL/2_interop", "/run/WSL/3_interop"], {
      "/run/WSL/1_interop": "2:4", "/run/WSL/2_interop": new Error("failed"), "/run/WSL/3_interop": "3:0",
    });
    expect(await selectRemoteInterop(runner)).toBe("/run/WSL/3_interop");
  });

  it("refuses to choose between multiple active desktops", async () => {
    const runner = remote(["/run/WSL/1_interop", "/run/WSL/2_interop"], {
      "/run/WSL/1_interop": "1:0", "/run/WSL/2_interop": "2:0",
    });
    await expect(selectRemoteInterop(runner)).rejects.toThrow();
  });

  it("refuses when no usable active session exists", async () => {
    await expect(selectRemoteInterop(remote(["/run/WSL/1_interop"], { "/run/WSL/1_interop": "0:0" }))).rejects.toThrow();
  });

  it("honors cancellation", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(selectRemoteInterop(remote([], {}), controller.signal)).rejects.toThrow();
  });
});
