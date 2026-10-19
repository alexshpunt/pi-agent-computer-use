import { defineConfig } from "vitest/config";

/** Live checks against a real configured machine. They act on that machine's desktop; run them only on purpose. */
export default defineConfig({
  test: { include: ["test/live/**/*.live.ts"], testTimeout: 600_000, hookTimeout: 120_000, fileParallelism: false },
});
