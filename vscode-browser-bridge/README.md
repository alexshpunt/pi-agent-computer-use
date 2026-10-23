# Pi Browser Bridge

Lets [Pi computer use](https://github.com/alexshpunt/pi-agent-computer-use) attach Playwright to VS Code's integrated browser (Browser: Open Integrated Browser).

VS Code's proposed `browser` API gives each integrated browser tab a Chrome DevTools Protocol channel. This extension relays it over a WebSocket on `127.0.0.1` behind a random token. It writes the endpoint to `%LOCALAPPDATA%\PiComputerUse\vscode-browser\<pid>.json`, where `attach_browser` on a VS Code window finds it. A connection uses the active integrated browser tab, or opens a blank one.

Setup:

1. Install it with `/computer-setup vscode-bridge`, or package this folder with `npx @vscode/vsce package` after `npm install --omit=dev` and install the `.vsix` with `code --install-extension`.
2. Run **Preferences: Configure Runtime Arguments** and add `"enable-proposed-api": ["alexshpunt.pi-browser-bridge"]`.
3. Quit VS Code fully and start it again; Reload Window does not reread that file.

It runs in the local (UI) extension host, also for remote and WSL windows. The proposed API can change between VS Code releases.
