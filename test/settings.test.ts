import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { instructionText, reachedStage } from "../src/instructions.ts";
import {
  DEFAULT_SETTINGS,
  SETTINGS_FILE_NAME,
  loadSettings,
  parseSettings,
  resolveThresholds,
} from "../src/settings.ts";

test("omitted settings use 70% and 80% of the context window", () => {
  assert.deepEqual(parseSettings({}), DEFAULT_SETTINGS);
  assert.deepEqual(resolveThresholds(DEFAULT_SETTINGS, "anthropic/claude-opus-5-5", 1_000_000), {
    prepareTokens: 700_000,
    compactTokens: 800_000,
  });
});

test("exact model entries override the default with tokens or percentages", () => {
  const settings = parseSettings({
    default: { prepareAt: "50%", compactAt: "60.5%" },
    models: {
      "anthropic/claude-opus-5-5": { prepareAt: 450_000, compactAt: 500_000 },
      "openai-codex/gpt-6.1-sol": false,
    },
  });
  assert.deepEqual(resolveThresholds(settings, "anthropic/claude-opus-5-5", 1_000_000), {
    prepareTokens: 450_000,
    compactTokens: 500_000,
  });
  assert.equal(resolveThresholds(settings, "openai-codex/gpt-6.1-sol", 272_000), undefined);
  assert.deepEqual(resolveThresholds(settings, "openai-codex/gpt-6-astra", 272_000), {
    prepareTokens: 136_000,
    compactTokens: 164_560,
  });
  // Model keys are exact and case-sensitive.
  assert.deepEqual(resolveThresholds(settings, "anthropic/Claude-Opus-5-5", 1_000_000), {
    prepareTokens: 500_000,
    compactTokens: 605_000,
  });
});

test("disabled settings and a false default skip unlisted models", () => {
  assert.equal(
    resolveThresholds(parseSettings({ enabled: false }), "faux/faux-1", 100_000),
    undefined,
  );
  const listedOnly = parseSettings({
    default: false,
    models: { "faux/faux-1": { prepareAt: 10, compactAt: 20 } },
  });
  assert.equal(resolveThresholds(listedOnly, "faux/other", 100_000), undefined);
  assert.deepEqual(resolveThresholds(listedOnly, "faux/faux-1", 100_000), {
    prepareTokens: 10,
    compactTokens: 20,
  });
});

test("rejects invalid documents with the failing setting named", () => {
  const cases: [unknown, RegExp][] = [
    [[], /JSON object/],
    [{ enable: true }, /enable is not a setting/],
    [{ enabled: "yes" }, /enabled must be true or false/],
    [{ default: { prepareAt: 0, compactAt: 10 } }, /default\.prepareAt must be/],
    [{ default: { prepareAt: 1.5, compactAt: 10 } }, /default\.prepareAt must be/],
    [{ default: { prepareAt: "100%", compactAt: "90%" } }, /default\.prepareAt must be/],
    [{ default: { prepareAt: "70", compactAt: "90%" } }, /default\.prepareAt must be/],
    [{ default: { prepareAt: 10 } }, /default\.compactAt must be/],
    [{ default: { prepareAt: 10, compactAt: 20, keep: 1 } }, /default\.keep is not a setting/],
    [{ default: true }, /default must be an object/],
    [{ models: [] }, /models must be an object/],
    [{ models: { "claude-opus-5-5": false } }, /exact "provider\/modelId"/],
  ];
  for (const [value, message] of cases) {
    assert.throws(() => parseSettings(value), { message }, JSON.stringify(value));
  }
});

test("compactAt must resolve above prepareAt for the active window", () => {
  const settings = parseSettings({ default: { prepareAt: 300_000, compactAt: "50%" } });
  assert.deepEqual(resolveThresholds(settings, "a/b", 1_000_000), {
    prepareTokens: 300_000,
    compactTokens: 500_000,
  });
  assert.throws(() => resolveThresholds(settings, "a/b", 272_000), {
    message: "prepareAt (300000 tokens) must be below compactAt (136000 tokens) for a/b.",
  });
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

test("selects the highest reached stage", () => {
  const thresholds = { prepareTokens: 450_000, compactTokens: 500_000 };
  assert.equal(reachedStage(449_999, thresholds), undefined);
  assert.equal(reachedStage(450_000, thresholds), "prepare");
  assert.equal(reachedStage(500_000, thresholds), "compact");
});

test("instructions direct the model to a Markdown state file without context statistics", () => {
  const prepare = instructionText("prepare");
  assert.match(prepare, /^\[Compaction preparation\]\n/);
  assert.match(prepare, /later `\[Compaction required\]` instruction/);
  assert.match(prepare, /Keep working\. Do not stop or wrap up early/);
  assert.match(prepare, /Record the state in a Markdown file now/);
  const compact = instructionText("compact");
  assert.match(compact, /^\[Compaction required\]\n/);
  assert.match(compact, /update the Markdown file that tracks this work/);
  assert.match(
    compact,
    /`message` \(required\).*Give the path of that Markdown file and the exact next step/,
  );
  const combined = instructionText("combined");
  assert.match(combined, /^\[Compaction required\]\n/);
  assert.match(combined, /record the current state in a Markdown file: the user's goal/);
  assert.match(combined, /or create one\. Then call the `compact` tool alone/);
  assert.match(combined, /Give the path of that Markdown file and the exact next step/);
  assert.doesNotMatch(combined, /later|update the Markdown file that tracks/);
  for (const text of [prepare, compact, combined]) assert.doesNotMatch(text, /tokens|%/);
});
