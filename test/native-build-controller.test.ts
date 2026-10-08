import { expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);
const script = path.resolve("scripts/run-native-window-capture-comparison.mjs");

for (const scenario of ["cancelled_second_attempt", "failed_source"]) {
  test(`build controller stops ${scenario} before rerun, download or fixture launch`, async () => {
    await mkdir(".tmp", { recursive: true });
    const cwd = await mkdtemp(path.resolve(".tmp/native-build-controller-"));
    try {
      const bin = path.join(cwd, "bin"); await mkdir(bin);
      const source = "a".repeat(40);
      const state = { headSha: source, status: "completed", conclusion: scenario === "failed_source" ? "failure" : "cancelled", attempt: scenario === "failed_source" ? 1 : 2 };
      const gh = path.join(bin, "gh");
      await writeFile(gh, `#!/usr/bin/env node\nimport {appendFileSync} from 'node:fs';\nappendFileSync('commands.jsonl',JSON.stringify(process.argv.slice(2))+'\\n');\nif(process.argv[2]!=='api')process.exit(99);\nconsole.log(${JSON.stringify(JSON.stringify(state))});\n`);
      await chmod(gh, 0o755);
      const plan = path.join(cwd, "plan.json");
      await writeFile(plan, JSON.stringify({ runs: Object.fromEntries(["wgc", "baseline", "direct", "wgcPoll5"].map((role,i) => [role, { id: i+1, source }])) }));
      let code = 0;
      try { await exec(process.execPath, [script, plan, "--owned-fixture"], { cwd, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH }, timeout: 5000 }); }
      catch (error) { code = (error as { code: number }).code; }
      expect(code).toBe(1);
      const commands = (await readFile(path.join(cwd, "commands.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(commands).toHaveLength(1);
      expect(commands[0].slice(0,2)).toEqual(["api", "repos/alexshpunt/cua/actions/runs/1"]);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}
