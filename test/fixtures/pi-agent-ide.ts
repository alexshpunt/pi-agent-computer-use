import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
/** A Pi Agent IDE checkout from PI_COMPUTER_IDE_SOURCE, otherwise the installed dependency. */
const ide = path.resolve(process.env.PI_COMPUTER_IDE_SOURCE ?? path.join(root, "node_modules/pi-agent-ide"));
const manifest = JSON.parse(readFileSync(path.join(ide, "package.json"), "utf8")) as { name: string; pi: { extensions: string[] } };
if (manifest.name !== "pi-agent-ide") throw new Error(`Expected Pi Agent IDE at ${ide}, found ${manifest.name}.`);

/** The IDE extension entry these tests load next to computer use. */
export const IDE_EXTENSION = path.join(ide, manifest.pi.extensions[0]);
/** The Pi command for real-Pi tests; undefined uses `pi` from PATH. */
export const PI_COMMAND = process.env.PI_COMPUTER_PI_COMMAND;
