import { expect, test } from "vitest";
import { validateWebAction, validateWebSnapshot } from "../src/web-browser.ts";

// Validation is the only gate before a command reaches the owned browser; a refusal here sends nothing.

test("tab, navigation and dialog commands accept only their own fields", () => {
  expect(validateWebAction({ action: "switch_tab", tab: "t2" })).toEqual({ action: "switch_tab", tab: "t2" });
  expect(validateWebAction({ action: "close_tab" })).toEqual({ action: "close_tab" });
  expect(validateWebAction({ action: "new_tab", url: "http://127.0.0.1:8080/" })).toEqual({ action: "new_tab", url: "http://127.0.0.1:8080/" });
  expect(validateWebAction({ action: "back" })).toEqual({ action: "back" });
  expect(validateWebAction({ action: "wait_load" })).toEqual({ action: "wait_load", state: "load" });
  expect(validateWebAction({ action: "dialog", accept: true, text: "Ada" })).toEqual({ action: "dialog", accept: true, text: "Ada" });
  expect(validateWebAction({ action: "dialog", accept: false })).toEqual({ action: "dialog", accept: false });
});

test("malformed tab and dialog commands refuse before reaching the browser", () => {
  expect(() => validateWebAction({ action: "switch_tab" })).toThrow(/tab id/);
  expect(() => validateWebAction({ action: "switch_tab", tab: "w-1" })).toThrow(/tab id/);
  expect(() => validateWebAction({ action: "back", target: { ref: "e1" } })).toThrow(/does not accept: target/);
  expect(() => validateWebAction({ action: "new_tab", url: "file:///C:/Windows/win.ini" })).toThrow(/HTTP\(S\)/);
  expect(() => validateWebAction({ action: "wait_load", state: "visible" })).toThrow(/wait_load state/);
  expect(() => validateWebAction({ action: "dialog" })).toThrow(/accept/);
  // Text answers only an accepted prompt; dismissing with text would silently drop it.
  expect(() => validateWebAction({ action: "dialog", accept: false, text: "Ada" })).toThrow(/accepted prompt/);
});

test("uploads need absolute paths and downloads need their own ids", () => {
  expect(validateWebAction({ action: "upload", target: { label: "File" }, files: ["/tmp/a.txt", "C:\\Temp\\b.txt"], chooser: true }))
    .toEqual({ action: "upload", target: { label: "File" }, files: ["/tmp/a.txt", "C:\\Temp\\b.txt"], chooser: true });
  expect(validateWebAction({ action: "wait_download" })).toEqual({ action: "wait_download" });
  expect(validateWebAction({ action: "cancel_download", download: "d2" })).toEqual({ action: "cancel_download", download: "d2" });
  // A relative path would resolve against the Windows worker's directory, not the agent's.
  expect(() => validateWebAction({ action: "upload", target: { label: "File" }, files: ["a.txt"] })).toThrow(/absolute/);
  expect(() => validateWebAction({ action: "upload", target: { label: "File" }, files: [] })).toThrow(/1\.\.32/);
  expect(() => validateWebAction({ action: "upload", files: ["/tmp/a.txt"] })).toThrow(/needs a target/);
  expect(() => validateWebAction({ action: "cancel_download", download: "t1" })).toThrow(/download must be an id/);
});

test("evaluate and the log view validate their inputs", () => {
  expect(validateWebAction({ action: "evaluate", expression: "document.title" })).toEqual({ action: "evaluate", expression: "document.title" });
  expect(validateWebAction({ action: "evaluate", target: { role: "status" }, expression: "el => el.textContent" }))
    .toEqual({ action: "evaluate", target: { role: "status" }, expression: "el => el.textContent" });
  expect(() => validateWebAction({ action: "evaluate" })).toThrow(/expression/);
  expect(validateWebSnapshot({ log: true })).toEqual({ log: true });
  expect(() => validateWebSnapshot({ log: "yes" })).toThrow(/log must be boolean/);
});