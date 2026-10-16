import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const fixture = fileURLToPath(new URL("./support/print-fixture.ts", import.meta.url));

for (const output of ["text", "json"]) {
  test(`Pi ${output} host waits for compaction and the continuation`, async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-compact-assistant-agent-"));
    const { stdout, stderr } = await exec(process.execPath, [fixture, output], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      timeout: 20000,
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.match(stdout, /print-compaction-completed/);
    assert.doesNotMatch(stderr, /Extension error|Failed|Error:/);
    if (output === "text") assert.equal(stdout.trim(), "print-compaction-completed");
  });
}
