import { describe, expect, test, vi } from "vitest";
import { ComputerResources, requireComputerAddress } from "../src/computer-resources.ts";
import { parseComputerViews } from "../src/computer-views.ts";
import { presentComputerResult } from "../src/provider.ts";
import type { ComputerResult, ComputerSession } from "../src/session.ts";

function observed(id: string, dom = true): ComputerResult {
  return {
    content: [{ type: "text", text: "Fresh readonly DOM snapshot." }],
    details: {
      mode: "yolo", status: "observed", window_ref: "fixture", observation_id: id,
      ...(dom ? { dom: { window_ref: "fixture", observation_id: id, snapshot_id: "p1", captured_at: "2026-10-17T00:00:00.000Z", matches: 1, projection_truncated: false,
        page: { title: "Fixture", url: "http://127.0.0.1/" }, complete: false, collection_complete: false,
        matched_count: 1, returned_count: 1, truncated: false, omitted: { nodes: 0, depth: 0, frames: 1, metadata: 0, text: 0, hidden_filtered: 0 },
        scope: "document", elements: [{ hint: "1:a", frame: { ref: "frame-main", kind: "main" }, tag: "button", role: "button", name: "Save",
          value: null, text: "Save", text_truncated: false, attributes: { "data-testid": "save" }, states: { disabled: false }, visibility: "visible",
          bounds_css: { x: 4, y: 8, width: 50, height: 20 }, coordinate_space: "document_css_pixels" }] } } : {}),
    },
  } as ComputerResult;
}
function fixture() {
  let serial = 0;
  const session = {
    observeDom: vi.fn(async () => observed(`dom-${++serial}`)),
    checkDom: vi.fn(async () => observed("checked")),
    inspectDom: vi.fn(async () => observed("inspected")),
    sampleDomGeometry: vi.fn(async () => ({ content: [], details: { status: "observed", mode: "yolo" } })),
    observe: vi.fn(async () => observed(`ui-${++serial}`, false)),
    checkObservation: vi.fn(async () => observed("checked-ui", false)),
    observeWindowState: vi.fn(async () => ({ content: [], details: { status: "observed", mode: "yolo", window_state_id: "state-1" } })),
    act: vi.fn(), manageWindow: vi.fn(), restoreWindow: vi.fn(), captureSequence: vi.fn(),
  };
  const getSession = vi.fn(async () => session as unknown as ComputerSession);
  const resources = new ComputerResources(getSession, vi.fn());
  const window = requireComputerAddress("computer:window/fixture");
  const address = (id = "dom-1") => requireComputerAddress(`computer:observation/${id}`);
  return { resources, session, getSession, window, address };
}

describe("readonly DOM resource routing", () => {
  test("DOM is a validated standalone view, never an image or UI acquisition option", () => {
    expect(parseComputerViews(["dom"])).toEqual({ kind: "dom", options: {} });
    expect(parseComputerViews(['dom:{"locator":{"test_id":"save"},"include_hidden":true,"max_nodes":2}']))
      .toEqual({ kind: "dom", options: { locator: { test_id: "save" }, include_hidden: true, max_nodes: 2 } });
    for (const views of [["dom", "image"], ["ui", "dom"], ["state", "dom"], ["backend:wgc", "dom"],
      ["dom:{}", "capture:{}"], ['dom:{"scope_ref":"p1:0"}'], ['dom:{"max_nodes":201}']])
      expect(() => parseComputerViews(views)).toThrow();
  });

  test("fresh DOM retains an image-free address; cached Read checks lifetime without querying or renewing", async () => {
    const f = fixture();
    const fresh = await f.resources.read(f.window, "/fixture", ["dom"]);
    expect(fresh).toMatchObject({ details: { observation_id: "dom-1" } });
    expect(f.resources.descriptor(f.address())).toMatch(/readonly DOM/i);
    const cached = await f.resources.read(f.address(), "/fixture");
    expect(cached?.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringMatching(/cached.*no.*query/i) })]));
    expect(cached?.details.observation_id).toBe("dom-1");
    await f.resources.read(f.address(), "/fixture", ["dom:{}"]);
    expect(f.session.observeDom).toHaveBeenCalledTimes(1);
    expect(f.session.checkDom).toHaveBeenCalledTimes(2);
    expect(f.session.checkObservation).not.toHaveBeenCalled();
    for (const view of ["image", "ui", "full", "region:0,0,10,10", "state"])
      await expect(f.resources.read(f.address(), "/fixture", [view])).rejects.toThrow();
  });

  test("a failed lifetime check removes the cached DOM address without refreshing it", async () => {
    const f = fixture();
    await f.resources.read(f.window, "/fixture", ["dom"]);
    f.session.checkDom.mockResolvedValueOnce({ content: [], details: { status: "refused", mode: "yolo" } });
    expect(await f.resources.read(f.address(), "/fixture")).toMatchObject({ details: { status: "refused" } });
    expect(() => f.resources.descriptor(f.address())).toThrow(/expired/i);
    expect(f.session.observeDom).toHaveBeenCalledTimes(1);
    expect(f.session.observe).not.toHaveBeenCalled();
  });
  test("DOM Search and element detail stay in their purpose; scope and locator reads retire prior handles", async () => {
    const f = fixture();
    await f.resources.read(f.window, "/fixture", ["dom"]);
    await f.resources.search(f.address(), "/fixture", "Save", 3);
    await f.resources.read(f.address(), "/fixture", ["element:inspect,1:a"]);
    await f.resources.read(f.address(), "/fixture", ["element:crop,1:a"]);
    await f.resources.read(f.address(), "/fixture", ["element:highlight,1:a"]);
    expect(f.session.inspectDom.mock.calls).toEqual([
      ["fixture", "dom-1", { operation: "search", query: "Save", limit: 3 }, undefined],
      ["fixture", "dom-1", { operation: "inspect", hint: "1:a" }, undefined],
      ["fixture", "dom-1", { operation: "crop", hint: "1:a" }, undefined],
      ["fixture", "dom-1", { operation: "highlight", hint: "1:a" }, undefined],
    ]);
    await f.resources.read(f.address(), "/fixture", ["element:scope,1:a"]);
    expect(f.session.observeDom).toHaveBeenLastCalledWith("fixture", { scope: "1:a" }, undefined, "dom-1");
    expect(() => f.resources.descriptor(f.address())).toThrow(/expired/i);
    await f.resources.read(f.address("dom-2"), "/fixture", ['dom:{"locator":{"role":"button"}}']);
    expect(f.session.observeDom).toHaveBeenLastCalledWith("fixture", { locator: { role: "button" } }, undefined, "dom-2");
    expect(() => f.resources.descriptor(f.address("dom-2"))).toThrow(/expired/i);
    expect(f.session.observe).not.toHaveBeenCalled();
  });

  test("explicit element geometry routes only from a current DOM observation and does not renew its snapshot", async () => {
    const f = fixture();
    expect(parseComputerViews(["element:geometry,1:a"])).toEqual({ kind: "element", operation: "geometry", hint: "1:a" });
    await f.resources.read(f.window, "/fixture", ["dom"]);
    await f.resources.read(f.address(), "/fixture", ["element:geometry,1:a"]);
    expect(f.session.sampleDomGeometry).toHaveBeenCalledExactlyOnceWith("fixture", "dom-1", "1:a", undefined);
    expect(f.session.inspectDom).not.toHaveBeenCalled();
    expect(f.session.observeDom).toHaveBeenCalledTimes(1);
    expect(f.resources.descriptor(f.address())).toMatch(/readonly DOM/i);
    await f.resources.read(f.window, "/fixture", ["ui"]);
    await expect(f.resources.read(f.address("ui-2"), "/fixture", ["element:geometry,1:a"])).rejects.toThrow(/requires.*DOM/i);
    expect(f.session.sampleDomGeometry).toHaveBeenCalledTimes(1);
  });

  test("CSS sample presentation shows its viewport domain and native-mapping refusal", () => {
    const result: ComputerResult = { content: [], details: { status: "observed", mode: "yolo", window_ref: "fixture", observation_id: "dom-1",
      dom_geometry: { window_ref: "fixture", observation_id: "dom-1", hint: "1:a", frame: { ref: "frame-main", kind: "main" },
        received_at: "2026-10-17T00:00:00.000Z", coordinate_space: "frame_viewport_css_pixels", viewport: "layout",
        method: "isolated_cssom_border_box", native_pixel_mapping: "unavailable", atomic: false, connected: true, same_document: true,
        bounds: { x: 10.25, y: 20.5, width: 90, height: 30 }, scroll: { x: 0, y: 120 },
        visual_viewport: { offset_x: 0, offset_y: 0, page_x: 0, page_y: 120, width: 800, height: 600, scale: 1 } } } };
    const output = presentComputerResult({ appSource: id => id }, result);
    expect(output).toContain("DOM CSS geometry: 1:a");
    const previewHead = output.slice(0, output.indexOf("Bounds:"));
    expect(previewHead).toContain("native mapping=unavailable");
    expect(previewHead).toContain("atomic=false");
    expect(output).toContain("frame_viewport_css_pixels; viewport=layout");
    expect(output).toContain("native mapping=unavailable");
    expect(output).toContain("atomic=false");
    expect(output).toContain("readonly, input=none");
    expect(Buffer.byteLength(output)).toBeLessThan(24000);
  });

  test("every DOM Write/Insert shape refuses before dispatch, including identity and delivery backdoors", async () => {
    const f = fixture();
    await f.resources.read(f.window, "/fixture", ["dom"]);
    for (const suffix of ["", "?hint=1%3Aa", "?delivery=foreground", "?delay_ms=1"])
      for (const [tool, value] of [["write", "typed"], ["insert", "not-json"], ["insert", '{"action":"click","hint":"1:a"}'],
        ["insert", '{"action":"sequence","steps":[{"action":"key","key":"ENTER"}]}']] as const)
        await expect(f.resources.perform(requireComputerAddress(`computer:observation/dom-1${suffix}`), "/fixture", value, tool)).rejects.toThrow(/readonly DOM/i);
    expect(f.getSession).toHaveBeenCalledTimes(1);
    expect(f.session.act).not.toHaveBeenCalled();
    expect(f.session.manageWindow).not.toHaveBeenCalled();
    expect(f.session.restoreWindow).not.toHaveBeenCalled();
    expect(f.resources.descriptor(f.address())).toMatch(/readonly DOM/i);
  });

  test("fresh DOM/UI/state/sequence retire old handles even if later acquisition refuses", async () => {
    const f = fixture();
    await f.resources.read(f.window, "/fixture", ["state"]);
    await f.resources.read(f.window, "/fixture", ["ui"]);
    await f.resources.read(f.window, "/fixture", ["dom"]);
    expect(() => f.resources.descriptor(requireComputerAddress("computer:window-state/state-1"))).toThrow(/expired/i);
    expect(() => f.resources.descriptor(f.address("ui-1"))).toThrow(/expired/i);
    f.session.observeDom.mockRejectedValueOnce(Error("native refusal"));
    await expect(f.resources.read(f.address("dom-2"), "/fixture", ['dom:{"include_hidden":true}'])).rejects.toThrow("native refusal");
    expect(() => f.resources.descriptor(f.address("dom-2"))).toThrow(/expired/i);
    await f.resources.read(f.window, "/fixture", ["dom"]);
    await f.resources.read(f.window, "/fixture", ["image"]);
    expect(() => f.resources.descriptor(f.address("dom-3"))).toThrow(/expired/i);
    await f.resources.read(f.window, "/fixture", ["dom"]);
    await f.resources.read(f.window, "/fixture", ['sequence:{"duration_ms":100,"fps":1,"max_frames":1,"timeout_ms":1000}']);
    expect(() => f.resources.descriptor(f.address("dom-5"))).toThrow(/expired/i);
  });

  test("DOM presentation bounds rows and text without hiding geometry uncertainty", () => {
    const result = observed("dom-large");
    const dom = result.details.dom!;
    dom.geometry_status = "unqualified_native_layout_units";
    dom.elements = Array.from({ length: 200 }, (_, index) => ({ ...dom.elements[0], hint: `1:${index}`, name: "n".repeat(1024), text: "t".repeat(1024), attributes: { extra: "a".repeat(1024) } }));
    const output = presentComputerResult({ appSource: id => id }, result);
    expect(output.length).toBeLessThan(24_000);
    expect(output).toContain("Preview: 10/200 collected records");
    expect(output).toContain("geometry=unqualified_native_layout_units");
    expect(output).not.toContain("1:199 |");
  });
  test("Read and Search presentation share a final UTF-8 budget for maximum metadata", () => {
    const result = observed("dom-max");
    const dom = result.details.dom!;
    const fields = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`${index}${"k".repeat(120)}`, "界".repeat(1024)]));
    dom.elements = Array.from({ length: 10 }, (_, index) => ({ ...dom.elements[0], hint: `1:${index}`, role: "界".repeat(1024), name: "界".repeat(1024), value: "界".repeat(1024), text: "界".repeat(1024), states: fields, attributes: fields }));
    const output = presentComputerResult({ appSource: id => id }, result);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(24_000);
    expect(output).toContain("DOM text preview reached its byte limit");
    expect(output).toContain("readonly, input=none");
    expect(output).not.toContain("�");
  });
  test("present DOM coverage, opaque frame and CSS units without claiming input or native crop geometry", () => {
    const output = presentComputerResult({ appSource: id => id }, observed("dom-1"));
    expect(output).toContain("computer:observation/dom-1");
    expect(output).toMatch(/DOM.*complete=false/);
    expect(output).toContain("frame-main");
    expect(output).toContain("document_css_pixels");
    expect(output).toMatch(/readonly.*input=none/i);
    expect(output).toMatch(/absence.*unknown/i);
    expect(output).toMatch(/crop.*proof/i);
    expect(output).not.toMatch(/Use the still-current state once/);
  });
});
