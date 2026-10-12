import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Runs the release-gating live test through the repository's Pi dependency. Pi finds its own
// package directory, so an inherited PI_PACKAGE_DIR is removed rather than replaced.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env: NodeJS.ProcessEnv = { ...process.env, PI_COMPACT_ASSISTANT_LIVE_TEST: "1" };
delete env["PI_PACKAGE_DIR"];
const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", "test/cli.live.test.ts"],
  { cwd: root, env, stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
