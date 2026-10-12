import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("npm package contains exactly the public extension, source, and documentation", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const { stdout } = await promisify(execFile)(
    "npm",
    ["pack", "--dry-run", "--ignore-scripts", "--allow-directory=all", "--json"],
    { cwd: root },
  );
  const value: unknown = JSON.parse(stdout);
  assert.ok(Array.isArray(value) && value.length === 1);
  const pack: unknown = value[0];
  assert.ok(
    typeof pack === "object" && pack !== null && "files" in pack && Array.isArray(pack.files),
  );
  const paths = pack.files.map((file: unknown) => {
    assert.ok(
      typeof file === "object" && file !== null && "path" in file && typeof file.path === "string",
    );
    return file.path;
  });
  const expected = (
    await readFile(new URL("../.github/npm-package-files", import.meta.url), "utf8")
  )
    .trim()
    .split("\n");
  assert.deepEqual(paths.toSorted(), expected.toSorted());
});
