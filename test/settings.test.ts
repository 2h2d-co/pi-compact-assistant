import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { instructionText } from "../src/instructions.ts";
import {
  DEFAULT_SETTINGS,
  SETTINGS_FILE_NAME,
  loadSettings,
  parseSettings,
  resolveCompactTokens,
} from "../src/settings.ts";

test("omitted settings compact at 80% of the context window", () => {
  assert.deepEqual(parseSettings({}), DEFAULT_SETTINGS);
  assert.equal(
    resolveCompactTokens(DEFAULT_SETTINGS, "anthropic/claude-opus-5-5", 1_000_000),
    800_000,
  );
});

test("exact model entries override the default with tokens or percentages", () => {
  const settings = parseSettings({
    default: { compactAt: "60.5%" },
    models: {
      "anthropic/claude-opus-5-5": { compactAt: 500_000 },
      "openai-codex/gpt-6.1-sol": false,
    },
  });
  assert.equal(resolveCompactTokens(settings, "anthropic/claude-opus-5-5", 1_000_000), 500_000);
  assert.equal(resolveCompactTokens(settings, "openai-codex/gpt-6.1-sol", 272_000), undefined);
  assert.equal(resolveCompactTokens(settings, "openai-codex/gpt-6-astra", 272_000), 164_560);
  // Model keys are exact and case-sensitive.
  assert.equal(resolveCompactTokens(settings, "anthropic/Claude-Opus-5-5", 1_000_000), 605_000);
});

test("disabled settings and a false default skip unlisted models", () => {
  assert.equal(
    resolveCompactTokens(parseSettings({ enabled: false }), "faux/faux-1", 100_000),
    undefined,
  );
  const listedOnly = parseSettings({
    default: false,
    models: { "faux/faux-1": { compactAt: 20 } },
  });
  assert.equal(resolveCompactTokens(listedOnly, "faux/other", 100_000), undefined);
  assert.equal(resolveCompactTokens(listedOnly, "faux/faux-1", 100_000), 20);
});

test("prepareAt from earlier versions is ignored, whatever its value", () => {
  const settings = parseSettings({
    default: { prepareAt: "70%", compactAt: "80%" },
    models: {
      "a/b": { prepareAt: 600_000, compactAt: 500_000 },
      "a/c": { prepareAt: "bad", compactAt: 10 },
    },
  });
  assert.deepEqual(settings, {
    enabled: true,
    default: { compactAt: "80%" },
    models: { "a/b": { compactAt: 500_000 }, "a/c": { compactAt: 10 } },
  });
});

test("rejects invalid documents with the failing setting named", () => {
  const cases: [unknown, RegExp][] = [
    [[], /JSON object/],
    [{ enable: true }, /enable is not a setting/],
    [{ enabled: "yes" }, /enabled must be true or false/],
    [{ default: { compactAt: 0 } }, /default\.compactAt must be/],
    [{ default: { compactAt: 1.5 } }, /default\.compactAt must be/],
    [{ default: { compactAt: "100%" } }, /default\.compactAt must be/],
    [{ default: { compactAt: "70" } }, /default\.compactAt must be/],
    [{ default: { prepareAt: 10 } }, /default\.compactAt must be/],
    [{ default: { compactAt: null } }, /default\.compactAt must be/],
    [{ default: { compactAt: 20, keep: 1 } }, /default\.keep is not a setting\. Use compactAt\./],
    [{ default: true }, /default must be an object with compactAt, or false/],
    [{ models: [] }, /models must be an object/],
    [{ models: { "claude-opus-5-5": false } }, /exact "provider\/modelId"/],
  ];
  for (const [value, message] of cases) {
    assert.throws(() => parseSettings(value), { message }, JSON.stringify(value));
  }
});

test("loads the settings file and reports invalid JSON with its path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-compact-assistant-settings-"));
  assert.equal(await loadSettings(directory), DEFAULT_SETTINGS);
  await writeFile(join(directory, SETTINGS_FILE_NAME), '{"default": false}');
  assert.deepEqual(await loadSettings(directory), { ...DEFAULT_SETTINGS, default: false });
  await writeFile(join(directory, SETTINGS_FILE_NAME), "{");
  await assert.rejects(loadSettings(directory), {
    message: new RegExp(`^Invalid settings in ${join(directory, SETTINGS_FILE_NAME)}: `),
  });
});

test("the instruction directs the model to a Markdown state file without context statistics", () => {
  const text = instructionText();
  assert.match(text, /^\[Compaction required\]\nThe conversation must be compacted now\./);
  assert.match(text, /Compaction does not end the task/);
  assert.match(
    text,
    /1\. Record the current state in a Markdown state file:\n {3}- the user's goal/,
  );
  assert.match(text, / {3}- open questions for the user\n/);
  assert.match(text, / {3}- Never stage or commit the state file\./);
  assert.match(text, /If you cannot or may not write files, skip this step/);
  assert.match(text, /2\. After the write succeeds, or if you skipped step 1, call `compact`/);
  assert.match(
    text,
    /`message` \(required\).*Give the state file's absolute path and the exact next step/,
  );
  assert.match(text, /If no work is pending, say so/);
  assert.doesNotMatch(text, /preparation/i);
  assert.doesNotMatch(text, /tokens|%/);
});
