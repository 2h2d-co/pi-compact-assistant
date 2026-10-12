import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getPackageDir, VERSION } from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("../", import.meta.url));
const dependency = join(root, "node_modules/@earendil-works/pi-coding-agent");

test("in-process tests use the repository's Pi dependency for package resources", async () => {
  // npm test removes an inherited PI_PACKAGE_DIR so it cannot select another runtime's
  // version, docs, or themes for the SDK under test.
  const manifest: unknown = JSON.parse(await readFile(join(dependency, "package.json"), "utf8"));
  assert.ok(typeof manifest === "object" && manifest !== null && "version" in manifest);
  assert.equal(VERSION, manifest.version);
  assert.equal(await realpath(getPackageDir()), await realpath(dependency));
});
