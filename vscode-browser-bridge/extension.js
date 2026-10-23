// Pi Browser Bridge: exposes VS Code's integrated browser to Pi computer use. The proposed `browser` API gives each
// integrated browser tab a browser-level CDP channel (BrowserTab.startCDPSession). This extension relays that channel
// over a WebSocket on 127.0.0.1 behind a random token and publishes the endpoint in
// %LOCALAPPDATA%\PiComputerUse\vscode-browser\<extension host pid>.json, where attach_browser finds it by the VS Code
// window's process tree. Each connection gets the active integrated browser tab, or a new blank one.
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");
const { WebSocketServer } = require("ws");

const folder = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "PiComputerUse", "vscode-browser");
const file = path.join(folder, `${process.pid}.json`);

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const output = vscode.window.createOutputChannel("Pi Browser Bridge");
  context.subscriptions.push(output);
  if (typeof vscode.window.openBrowserTab !== "function") {
    output.appendLine("The proposed browser API is not enabled for this extension; add it to enable-proposed-api in argv.json and restart VS Code.");
    return;
  }
  const token = crypto.randomBytes(24).toString("hex");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: `/${token}` });
  server.on("listening", () => {
    fs.mkdirSync(folder, { recursive: true });
    // A VS Code that crashed left its endpoint behind; drop those whose extension host is gone.
    for (const name of fs.readdirSync(folder)) {
      try { process.kill(Number(name.replace(/\.json$/, "")), 0); }
      catch (error) { if (error.code !== "EPERM") fs.rmSync(path.join(folder, name), { force: true }); }
    }
    fs.writeFileSync(file, JSON.stringify({ port: server.address().port, token }));
    output.appendLine(`Listening on 127.0.0.1:${server.address().port}`);
  });
  server.on("connection", socket => relay(socket, output));
  context.subscriptions.push({ dispose() { server.close(); fs.rmSync(file, { force: true }); } });
}

/** Relay one client's CDP messages to an integrated browser tab and back. Messages sent before the session opens wait. */
async function relay(socket, output) {
  const pending = [];
  let session;
  socket.on("message", data => session ? session.sendMessage(JSON.parse(String(data))) : pending.push(JSON.parse(String(data))));
  try {
    const tab = vscode.window.activeBrowserTab ?? vscode.window.browserTabs[0]
      ?? await vscode.window.openBrowserTab("about:blank", { preserveFocus: true, background: true });
    session = await tab.startCDPSession();
    output.appendLine(`Client attached to ${tab.url}`);
    session.onDidReceiveMessage(message => socket.send(JSON.stringify(message)));
    session.onDidClose(() => socket.close());
    socket.on("close", () => session.close());
    for (const message of pending.splice(0)) await session.sendMessage(message);
  } catch (error) {
    output.appendLine(`Attach failed: ${error instanceof Error ? error.message : error}`);
    socket.close(1011, "Could not open a CDP session on the integrated browser");
  }
}

function deactivate() { fs.rmSync(file, { force: true }); }

module.exports = { activate, deactivate };
