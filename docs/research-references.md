# Research references

These references came from the user's project pitch. They are inputs for future research, not selected dependencies or verified architecture claims. The complete supplied notes are kept in the research task's Original Request in Linear.

The first [source-backed comparison](research/external-implementations.md) is available. Keep the supplied claims below separate from its verified findings.
The [read-only mole classifier experiment](research/mole-classifier-experiment.md) compares MobileCLIP2-S0 and S2 on real game screenshots. It measures recognition and capture costs; it does not adopt a classifier dependency.
The [Decisions subscription probe](research/decisions-subscription-probe.md) records real requests using existing Codex OAuth and a fresh direct-sharing grant. Decisions rejected both; the fresh grant passed public Responses, and Luna worked through Codex Responses.

## First sources to study

| Reference | Source | What to investigate |
| --- | --- | --- |
| `@injaneity/pi-computer-use` | [GitHub](https://github.com/injaneity/pi-computer-use) · [Pi package](https://pi.dev/packages/%40injaneity/pi-computer-use) | Semantic desktop resources, accessibility, immutable observations, scoped element references, stale-state checks, batches, postconditions, and browser CDP in the same model. |
| `@amaster.ai/pi-computer-use` | [GitHub monorepo](https://github.com/TGYD-helige/pi) · [Pi package](https://pi.dev/packages/%40amaster.ai/pi-computer-use) | Capability coverage, accessibility plus screenshots, native input, window and browser control, and progressive tool disclosure. |
| `@husain-zaidi/pi-computer-use` | [GitHub](https://github.com/husain-zaidi/pi-computer-use) | Persistent Python, Playwright/PyAutoGUI, code-first orchestration, roundtrip costs, and the unrestricted execution boundary. |

## Other comparisons

| Reference | Source | What to investigate |
| --- | --- | --- |
| `@edward40/pi-computer-use` | [GitHub](https://github.com/SASUKE40/pi-computer-use) · [Pi package](https://pi.dev/packages/%40edward40/pi-computer-use) | A small single-tool baseline backed by Cua Driver, with fresh screenshots after actions. |
| `@agimon-ai/doompi-computer-use` | [Pi package](https://pi.dev/packages/%40agimon-ai/doompi-computer-use) | State/action/exec interfaces and the cost of requiring DoomPi Desktop. |

Browser-only references named by the user: `pi-browser-use`, `pi-browser`, and `pi-agent-browser-native`. Resolve their exact repositories before comparing them; package names alone do not establish identity.

## Claims to verify

- Platform support, especially Pi running in WSL while controlling the Windows host desktop. Native Windows support is not proof of this setup.
- Backend selection and whether a Windows helper or bridge is needed from WSL.
- The supplied Cua Driver version (`0.28.2`), tool counts (`56` and browser `50+`), current package APIs, and runtime dependencies. These may change.
- The Python author's reported benchmark results: 2 versus 13 calls and 19.89 versus 64.93 seconds on a local form task; 60 versus 119 calls on a DMV task. These are self-reported, not independent evidence.
- State lifetime, stale-reference failures, action verification, batching, and recovery in actual code rather than README promises.
- Execution permissions and any safety boundary. Do not install or run these packages merely to prepare the project.

Record source links and inspected versions or commits in the eventual research findings. Keep observed facts separate from advertised behavior and recommendations.
