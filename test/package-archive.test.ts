import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { archiveEntries, expectedArchiveEntries, packageArchive } from "./package-archive.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

async function temporaryDirectory(t: TestContext): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), "pi-compact-assistant-archive-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  return temporary;
}

test("uses the supplied candidate without packing the working directory", async (t) => {
  const temporary = await temporaryDirectory(t);
  const candidate = join(temporary, "candidate.tgz");
  await writeFile(candidate, "synthetic candidate");
  // This directory has no package.json, so an accidental npm pack would fail.
  assert.equal(await packageArchive(temporary, temporary, candidate), await realpath(candidate));
  assert.equal(await readFile(candidate, "utf8"), "synthetic candidate");
  assert.deepEqual(await readdir(temporary), ["candidate.tgz"]);
});

test("resolves a relative candidate path from the current working directory", async (t) => {
  const temporary = await temporaryDirectory(t);
  const candidate = join(temporary, "candidate.tgz");
  await writeFile(candidate, "synthetic candidate");
  const supplied = relative(process.cwd(), candidate);
  assert.notEqual(supplied, candidate);
  assert.equal(await packageArchive(temporary, temporary, supplied), await realpath(candidate));
  assert.deepEqual(await readdir(temporary), ["candidate.tgz"]);
});

test("an invalid supplied candidate never falls back to npm pack", async (t) => {
  const temporary = await temporaryDirectory(t);
  await writeFile(join(temporary, "empty.tgz"), "");
  await mkdir(join(temporary, "directory.tgz"));
  await assert.rejects(packageArchive(temporary, temporary, ""), /must not be empty/);
  await assert.rejects(packageArchive(temporary, temporary, join(temporary, "missing.tgz")), {
    code: "ENOENT",
  });
  await assert.rejects(
    packageArchive(temporary, temporary, join(temporary, "directory.tgz")),
    /not a regular file/,
  );
  await assert.rejects(
    packageArchive(temporary, temporary, join(temporary, "empty.tgz")),
    /is an empty file/,
  );
  assert.deepEqual((await readdir(temporary)).sort(), ["directory.tgz", "empty.tgz"]);
});

test("a candidate that is not a gzip tar archive fails before extraction", async (t) => {
  const temporary = await temporaryDirectory(t);
  const candidate = join(temporary, "invalid.tgz");
  await writeFile(candidate, "not an archive");
  assert.equal(await packageArchive(temporary, temporary, candidate), await realpath(candidate));
  await assert.rejects(archiveEntries(candidate));
});

test("standalone validation packs locally when no candidate is supplied", async (t) => {
  const temporary = await temporaryDirectory(t);
  await writeFile(
    join(temporary, "package.json"),
    JSON.stringify({ name: "synthetic-live-test", version: "1.0.0" }),
  );
  const archive = await packageArchive(temporary, temporary, undefined);
  assert.equal(archive, join(temporary, "synthetic-live-test-1.0.0.tgz"));
  assert.deepEqual(await archiveEntries(archive), ["package/package.json"]);
});

test("expected archive members come from the package-files allowlist", async () => {
  const expected = await expectedArchiveEntries(root);
  assert.ok(expected.includes("package/extensions/index.ts"));
  assert.ok(expected.includes("package/package.json"));
  assert.deepEqual(expected, [...expected].sort());
});
