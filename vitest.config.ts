import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"], exclude: ["test/**/*.integration.test.ts"],
    // The user's own agent directory (global machines and settings) stays out of unit tests.
    env: { PI_CODING_AGENT_DIR: path.resolve(".tmp/unit-agent-dir") },
  },
});
