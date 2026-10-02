import { mkdir, writeFile } from "node:fs/promises";
import { loadComputerConfig } from "../src/config.ts";
import { McpDriver } from "../src/driver.ts";
import { ComputerSession } from "../src/session.ts";

// Opt-in qualification only: create one disposable canary outside the interactive Pi extension session.
// Never rerun blindly: the application survives backend cleanup, including on a failed empty-state check.
await mkdir(".tmp", { recursive: true });
const session = new ComputerSession(new McpDriver(await loadComputerConfig(process.cwd())));
try {
  const opened = await session.open("Notepad");
  await writeFile(".tmp/safe-prepared.json", JSON.stringify(opened.details, null, 2) + "\n");
  const image = opened.content.find(block => block.type === "image");
  if (image) await writeFile(".tmp/safe-canary-blank.png", Buffer.from(image.data, "base64"));
  const elements = opened.details.state?.elements;
  if (opened.details.status !== "observed" || !Array.isArray(elements)
    || elements.filter(element => element.role === "TabItem").length !== 1
    || !elements.some(element => element.role === "Document" && !element.value))
    throw new Error("Created canary is not a single empty Notepad. Inspect only this new window; do not write or relaunch blindly.");
  console.log(JSON.stringify({ target: opened.details.target, details: ".tmp/safe-prepared.json",
    screenshot: ".tmp/safe-canary-blank.png" }, null, 2));
} finally { await session.close(); }
