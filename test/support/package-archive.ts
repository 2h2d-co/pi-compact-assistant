import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * The archive under test. A supplied candidate is used as-is: it resolves relative to
 * the current working directory and must be an existing, non-empty regular file. An
 * invalid candidate fails instead of falling back to packing the working directory.
 */
export async function packageArchive(
  root: string,
  temporary: string,
  supplied: string | undefined,
): Promise<string> {
  if (supplied !== undefined) {
    assert.ok(supplied.length > 0, "PI_PACKAGE_ARCHIVE must not be empty.");
    const candidate = await realpath(resolve(supplied));
    const info = await stat(candidate);
    assert.ok(info.isFile(), `PI_PACKAGE_ARCHIVE is not a regular file: ${supplied}`);
    assert.ok(info.size > 0, `PI_PACKAGE_ARCHIVE is an empty file: ${supplied}`);
    return candidate;
  }
  const { stdout } = await exec(
    "npm",
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--allow-directory=all",
      "--pack-destination",
      temporary,
    ],
    { cwd: root, encoding: "utf8" },
  );
  const packed: unknown = JSON.parse(stdout);
  assert.ok(Array.isArray(packed) && packed.length === 1, "npm pack must report one archive.");
  const result: unknown = packed[0];
  assert.ok(
    typeof result === "object" &&
      result !== null &&
      "filename" in result &&
      typeof result.filename === "string",
  );
  return join(temporary, result.filename);
}

/** Sorted archive members. A file that is not a gzip tar archive fails here. */
export async function archiveEntries(archive: string): Promise<string[]> {
  const { stdout } = await exec("tar", ["-tzf", archive], { encoding: "utf8" });
  return stdout.trim().split("\n").sort();
}

/** Sorted members required by `.github/npm-package-files`. */
export async function expectedArchiveEntries(root: string): Promise<string[]> {
  const files = await readFile(join(root, ".github/npm-package-files"), "utf8");
  return files
    .trim()
    .split("\n")
    .map((file) => `package/${file}`)
    .sort();
}
