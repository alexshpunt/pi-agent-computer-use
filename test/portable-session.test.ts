import { expect, test, vi } from "vitest";
import { ComputerSession, type Driver } from "../src/session.ts";
import { observationSource } from "../src/observation-source.ts";

function backend(platform: "linux" | "macos") {
  const call = vi.fn(async (name: string) => ({ content: [], structuredContent: name === "list_apps"
    ? { apps: [{ name: "Synthetic editor", bundle_id: "org.synthetic.editor" }] }
    : { windows: [{ pid: 42, window_id: 99, title: "Owned test marker" }] } }));
  const identity = vi.fn(async () => undefined);
  const base: Driver = { platform, windowLifetime: false, call, identity, close: vi.fn(async () => {}) };
  return { driver: base, call, identity };
}

test.each(["linux", "macos"] as const)("%s exposes metadata but never substitutes reusable IDs for native lifetime", async platform => {
  const { driver, call, identity } = backend(platform);
  const session = new ComputerSession(driver);
  const found = await session.windows(undefined, "Owned test marker");
  expect(found.details.status).toBe("listed");
  const row = (found.details.state!.windows as Record<string, unknown>[])[0];
  expect(row.window_ref).toBeUndefined();
  expect(row.unavailable).toContain("window_lifetime_unavailable");
  expect(row.source_identity).toMatchObject({ domain: `${platform}-host`, membership: { virtual_desktop_id: null } });
  expect(identity).not.toHaveBeenCalled();
  call.mockClear();
  const opened = await session.open("Synthetic editor");
  expect(opened.details.status).toBe("refused");
  expect(opened.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("window_lifetime_unavailable") });
  expect(call).not.toHaveBeenCalled();
});

test.each(["linux", "macos"] as const)("%s app discovery accepts native bundle identifiers and does not call them Windows apps", async platform => {
  const { driver } = backend(platform);
  const result = await new ComputerSession(driver).apps();
  expect(result.details.state!.apps).toEqual([{ name: "Synthetic editor", bundle_id: "org.synthetic.editor", app_id: "org.synthetic.editor" }]);
  expect(result.content[0]).toMatchObject({ type: "text", text: expect.not.stringContaining("Installed Windows apps") });
});

test.each(["linux", "macos"] as const)("%s display provenance never invents Windows session or shell-desktop membership", platform => {
  const source = observationSource("display", { screenshot_width: 500, screenshot_height: 300 }, { session_id: "agent", display_id: "primary" }, false, platform);
  expect(source.domain).toBe(`${platform}-host`);
  expect(source.membership).not.toHaveProperty("windows_session_id");
  expect(source.membership.virtual_desktop_id).toBeNull();
  expect(source.virtual_desktop).toBeUndefined();
  expect(source.capabilities.input).toBe("none");
});
