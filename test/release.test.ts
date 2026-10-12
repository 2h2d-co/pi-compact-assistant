import assert from "node:assert/strict";
import childProcess, { type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

// The release command is one top-level script. These tests import it with mocked child
// processes: no real Git, npm, Mise, Pi, or provider call happens. They cover the order
// of the live gate, signing, tagging, and the state left behind by each failure.

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const releasedVersion = releaseCandidateVersion(changelog);
const candidate = "synthetic release archive";
const digest = createHash("sha256").update(candidate).digest("hex");
const packageFiles = readFileSync(join(root, ".github/npm-package-files"), "utf8")
  .trim()
  .split("\n")
  .map((path) => ({ path, mode: 0o644 }));

/** A version whose changelog section exists, so the changelog gate passes. Before the first
 * stable release, a prerelease takes the Unreleased section. */
function releaseCandidateVersion(text: string): string {
  const version = text.match(/^##\s+\[?v?(\d+\.\d+\.\d+)\]?/m)?.[1];
  if (version) return version;
  assert.match(text, /^## \[Unreleased\]\n\n\S/m, "CHANGELOG.md needs Unreleased entries.");
  return "0.0.1-alpha.1";
}

interface Scenario {
  version?: string;
  branch?: string;
  status?: string;
  originMain?: string;
  tagExists?: boolean;
  live?: number | "spawn-error";
  reproducible?: boolean;
}

interface Outcome {
  calls: string[];
  archives: string[];
  liveRuns: { cwd: unknown; archive: string | undefined; contents: string }[];
  signed: boolean;
  tagged: boolean;
  error: unknown;
}

async function runRelease(t: TestContext, scenario: Scenario): Promise<Outcome> {
  const version = scenario.version ?? releasedVersion;
  const tag = `v${version}`;
  const previousArgv = process.argv;
  const previousNpm = process.env["npm_execpath"];
  const outcome: Outcome = {
    calls: [],
    archives: [],
    liveRuns: [],
    signed: false,
    tagged: false,
    error: undefined,
  };
  const spawnError = Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" });
  process.argv = [process.execPath, join(root, "scripts/release.ts"), version];
  process.env["npm_execpath"] = "synthetic-npm";
  // The script's success summary would read like a real release in the test output.
  t.mock.method(console, "log", () => {});
  const mocked = t.mock.method(
    childProcess,
    "spawnSync",
    (command: string, args: string[] = [], options: SpawnSyncOptions = {}) => {
      const operation = (
        command === process.execPath ? ["npm", ...args.slice(1)] : [command, ...args]
      ).join(" ");
      outcome.calls.push(operation);
      let stdout = "";
      let status: number | null = 0;
      let error: Error | undefined;
      if (command === "git") {
        assert.equal(options.cwd, root);
        const verb = args[0];
        if (verb === "branch") stdout = scenario.branch ?? "main";
        else if (verb === "status") stdout = scenario.status ?? "";
        else if (verb === "fetch" || verb === "add" || verb === "checkout-index") stdout = "";
        else if (verb === "rev-parse" && args.includes("--verify")) {
          status = scenario.tagExists ? 0 : 1;
        } else if (verb === "rev-parse" && args[1] === "origin/main") {
          stdout = scenario.originMain ?? "initial-commit";
        } else if (verb === "rev-parse") {
          stdout = outcome.signed ? "release-commit" : "initial-commit";
        } else if (verb === "diff") stdout = "package-lock.json\npackage.json";
        else if (verb === "commit") outcome.signed = true;
        else if (verb === "tag") outcome.tagged = true;
        else if (verb === "-c") assert.equal(args.at(-2), "verify-commit");
        else if (verb === "cat-file") stdout = "commit";
        else if (verb === "log") {
          stdout = args.includes("--pretty=%s") ? `release: ${tag}` : digest;
        } else throw new Error(`Unexpected Git command: ${operation}`);
      } else if (command === process.execPath) {
        const verb = args[1];
        assert.equal(args[0], "synthetic-npm");
        assert.equal(typeof options.cwd, "string");
        const cwd = String(options.cwd);
        if (verb === "version") assert.equal(cwd, root);
        else if (verb === "ci") {
          assert.notEqual(cwd, root, "Packages build from a checked-out index copy.");
          writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: {} }));
        } else if (verb === "pack") {
          const output = args[args.indexOf("--pack-destination") + 1];
          assert.ok(output);
          const filename = `pi-compact-assistant-${version}.tgz`;
          const archive = join(output, filename);
          const rebuild = outcome.archives.length > 0 && scenario.reproducible === false;
          writeFileSync(archive, rebuild ? `${candidate} changed` : candidate);
          outcome.archives.push(archive);
          stdout = JSON.stringify([
            { name: "pi-compact-assistant", version, filename, files: packageFiles },
          ]);
        } else if (verb === "run") {
          assert.deepEqual(args.slice(2), ["test:live"]);
          const archive = options.env?.["PI_PACKAGE_ARCHIVE"];
          outcome.liveRuns.push({
            cwd: options.cwd,
            archive,
            contents: archive ? readFileSync(archive, "utf8") : "",
          });
          if (scenario.live === "spawn-error") {
            error = spawnError;
            status = null;
          } else status = scenario.live ?? 0;
        } else throw new Error(`Unexpected npm command: ${operation}`);
      } else throw new Error(`Unexpected child command: ${operation}`);
      return {
        pid: 0,
        output: [null, stdout, ""],
        stdout,
        stderr: "",
        status,
        signal: null,
        error,
      };
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
    process.argv = previousArgv;
    if (previousNpm === undefined) delete process.env["npm_execpath"];
    else process.env["npm_execpath"] = previousNpm;
  });
  try {
    await import(new URL(`../scripts/release.ts?scenario=${t.name}`, import.meta.url).href);
  } catch (error) {
    outcome.error = error;
  }
  assert.ok(
    outcome.archives.every((archive) => !existsSync(archive)),
    "Temporary candidates are cleaned up.",
  );
  return outcome;
}

function assertNoReleaseArtifacts(outcome: Outcome): void {
  assert.equal(outcome.signed, false);
  assert.equal(outcome.tagged, false);
  assert.ok(!outcome.calls.some((call) => call.startsWith("git commit ")));
  assert.ok(!outcome.calls.some((call) => call.startsWith("git tag ")));
}

for (const [name, scenario, message] of [
  ["a branch other than main", { branch: "feature" }, /created from main/],
  ["a dirty worktree or index", { status: " M README.md" }, /clean worktree and index/],
  ["a HEAD that differs from origin/main", { originMain: "other-commit" }, /does not match/],
  ["an existing release tag", { tagExists: true }, /already exists/],
  ["a missing changelog section", { version: "99.0.0" }, /no 99\.0\.0 section/],
] as const) {
  test(`release stops before changing anything on ${name}`, async (t) => {
    const outcome = await runRelease(t, scenario);
    assert.match(String(outcome.error), message);
    assertNoReleaseArtifacts(outcome);
    assert.deepEqual(outcome.liveRuns, []);
    assert.deepEqual(outcome.archives, []);
    assert.ok(!outcome.calls.some((call) => call.startsWith("npm version ")));
    assert.ok(!outcome.calls.some((call) => call.startsWith("git add ")));
  });
}

test("release rejects an invalid version before any Git command", async (t) => {
  const outcome = await runRelease(t, { version: "1.0" });
  assert.match(String(outcome.error), /Invalid release version/);
  assert.deepEqual(outcome.calls, []);
});

for (const [name, live, message] of [
  ["the live test cannot start", "spawn-error", /spawn node ENOENT/],
  ["the live test exits with a failure", 1, /synthetic-npm run test:live exited with 1/],
] as const) {
  test(`release leaves only staged version metadata when ${name}`, async (t) => {
    const outcome = await runRelease(t, { live });
    assert.match(String(outcome.error), message);
    if (live === "spawn-error") {
      assert.ok(outcome.error instanceof Error && "code" in outcome.error);
      assert.equal(outcome.error.code, "ENOENT");
    }
    assertNoReleaseArtifacts(outcome);
    assert.equal(outcome.liveRuns.length, 1);
    assert.equal(outcome.archives.length, 1, "The rebuild never runs after a failed gate.");
    // The version bump and its staging happen before the gate; nothing undoes them.
    assert.ok(
      outcome.calls.includes(
        `npm version ${releasedVersion} --no-git-tag-version --ignore-scripts`,
      ),
    );
    assert.ok(outcome.calls.includes("git add package-lock.json package.json"));
  });
}

test("release runs the live gate once against the exact staged archive before signing", async (t) => {
  const outcome = await runRelease(t, {});
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.liveRuns.length, 1);
  const [live] = outcome.liveRuns;
  assert.ok(live);
  assert.equal(live.cwd, root, "The live test runs from the repository root.");
  assert.equal(live.archive, outcome.archives[0]);
  assert.ok(live.archive && !live.archive.startsWith(root), "The archive is a temporary file.");
  assert.equal(live.contents, candidate);
  assert.ok(outcome.signed);
  assert.ok(outcome.tagged);
  assert.equal(outcome.archives.length, 2, "The post-commit rebuild packs again without the gate.");
  assert.ok(
    outcome.calls.includes(
      `git commit -S -m release: v${releasedVersion} -m Npm-Artifact-SHA256: ${digest}`,
    ),
  );
  assert.ok(outcome.calls.includes(`git tag v${releasedVersion}`));
  const liveIndex = outcome.calls.indexOf("npm run test:live");
  const commitIndex = outcome.calls.findIndex((call) => call.startsWith("git commit "));
  const rebuildIndex = outcome.calls.findLastIndex((call) =>
    call.startsWith("git checkout-index "),
  );
  const tagIndex = outcome.calls.findIndex((call) => call.startsWith("git tag "));
  assert.ok(liveIndex < commitIndex && commitIndex < rebuildIndex && rebuildIndex < tagIndex);
});

test("release keeps the signed commit but refuses the tag when the rebuild differs", async (t) => {
  const outcome = await runRelease(t, { reproducible: false });
  assert.match(String(outcome.error), /not reproducible/);
  assert.equal(outcome.liveRuns.length, 1, "The rebuild does not repeat live validation.");
  assert.ok(outcome.signed, "A local release commit already exists at this point.");
  assert.equal(outcome.tagged, false);
  assert.ok(!outcome.calls.some((call) => call.startsWith("git tag ")));
});
