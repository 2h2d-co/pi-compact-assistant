import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  calculateContextTokens,
  getAgentDir,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import manifest from "../package.json" with { type: "json" };
import { CONTINUATION_TYPE, INSTRUCTION_TYPE, NOTICE_TYPE } from "../src/extension.ts";
import { SETTINGS_FILE_NAME } from "../src/settings.ts";
import { CANCEL_MODE_ENV, type CancelMode } from "./support/cancel-probe.ts";
import { describeFailure, errorLog } from "./support/error-log.ts";
import { HOLD_DIR_ENV, STARTED_FILE, TYPED_FILE } from "./support/compaction-probe.ts";
import {
  archiveEntries,
  expectedArchiveEntries,
  packageArchive,
} from "./support/package-archive.ts";
import { isolatePromptPatcher } from "./support/prompt-patcher.ts";
import {
  PROBE_TYPE,
  TOOLS_PROBE_TYPE,
  type ProbedInstruction,
  type ProbedTools,
} from "./support/wire-probe.ts";

type RpcClientModule =
  typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js");
type RpcClient = InstanceType<RpcClientModule["RpcClient"]>;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piVersion = manifest.devDependencies["@earendil-works/pi-coding-agent"];

const FACTS = "project Lantern, language TypeScript, port 4317, storage SQLite";

function isRpcClientModule(value: unknown): value is RpcClientModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "RpcClient" in value &&
    typeof value.RpcClient === "function"
  );
}

/** Synthetic filler of about `tokens` tokens whose last line names `word`. */
function pad(tokens: number, word: string): string {
  const line = "The synthetic inventory lists crates, pallets, and labels for review.\n";
  return `${line.repeat(Math.ceil((tokens * 4) / line.length))}Final word: ${word}\n`;
}

function isProbedInstruction(value: unknown): value is ProbedInstruction {
  return (
    typeof value === "object" &&
    value !== null &&
    "stage" in value &&
    "role" in value &&
    "index" in value &&
    typeof value.index === "number" &&
    "systemLength" in value &&
    typeof value.systemLength === "number" &&
    "systemUnchanged" in value &&
    typeof value.systemUnchanged === "boolean" &&
    "systemHasInstruction" in value &&
    typeof value.systemHasInstruction === "boolean"
  );
}

function probes(entries: readonly SessionEntry[]): ProbedInstruction[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== PROBE_TYPE) return [];
    const data: unknown = entry.data;
    if (typeof data !== "object" || data === null || !("found" in data)) return [];
    return Array.isArray(data.found) ? data.found.filter(isProbedInstruction) : [];
  });
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** The tools each request declared, in request order, with the index of its probe entry. */
function toolProbes(entries: readonly SessionEntry[]): (ProbedTools & { entry: number })[] {
  return entries.flatMap((entry, index) => {
    if (entry.type !== "custom" || entry.customType !== TOOLS_PROBE_TYPE) return [];
    const data: unknown = entry.data;
    if (typeof data !== "object" || data === null) return [];
    if (!("names" in data && "top" in data && "stages" in data)) return [];
    const { names, top, stages } = data;
    if (!stringArray(names) || !stringArray(top) || !stringArray(stages)) return [];
    return [{ names, top, stages, entry: index }];
  });
}

/** Entry types, roles, tool calls, and stop reasons, without content, for failure reports. */
function outline(entries: readonly SessionEntry[]): string {
  return entries
    .map((entry) => {
      if (entry.type === "custom_message" && entry.customType === NOTICE_TYPE) {
        // The notice is the extension's own text and names why a request stopped.
        return `${entry.customType}(${JSON.stringify(entry.content).slice(0, 300)})`;
      }
      if (entry.type === "custom" || entry.type === "custom_message") return entry.customType;
      if (entry.type !== "message") return entry.type;
      const message = entry.message;
      if (message.role === "assistant") {
        const calls = message.content.flatMap((block) =>
          block.type === "toolCall" ? [block.name] : [],
        );
        return `assistant(${message.stopReason}${calls.length ? `:${calls.join(",")}` : ""}${message.errorMessage ? `:${describeFailure(message)}` : ""})`;
      }
      if (message.role === "toolResult") {
        return `toolResult(${message.toolName}${message.isError ? ":error" : ""})`;
      }
      return message.role;
    })
    .join(" > ");
}

/**
 * Loads the packaged extension through the Pi CLI with the extensions of a real setup: the
 * provider's compat extension and the system prompt patcher. It crosses the preparation and
 * compaction thresholds with synthetic files, verifies where each instruction reaches the
 * provider, and expects the model to call `compact`, compaction to run through the compat
 * extension, and the continuation to resume the agent with the project facts intact.
 */
interface Scenario {
  provider: string;
  model: string;
  role: string;
  compat: string | undefined;
  settings: { file: string; value: unknown } | undefined;
}

/**
 * Unpack the release candidate and prepare isolated agent state with the real login, the pinned
 * prompt patcher, and the scenario's compat extension. Returns RPC client options for Pi.
 */
async function prepareLive(
  t: TestContext,
  scenario: Scenario,
  { cancel, hold = false }: { cancel?: CancelMode; hold?: boolean } = {},
) {
  const temporary = await mkdtemp(join(tmpdir(), "pi-compact-assistant-live-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  // A release passes its exact staged-index archive; otherwise pack this worktree.
  const archive = await packageArchive(root, temporary, process.env["PI_PACKAGE_ARCHIVE"]);
  assert.deepEqual(await archiveEntries(archive), await expectedArchiveEntries(root));
  execFileSync("tar", ["-xzf", archive, "-C", temporary]);
  const packageRoot = join(temporary, "package");
  // Installed packages have no node_modules: every Pi import must resolve through Pi's aliases.
  assert.equal(existsSync(join(packageRoot, "node_modules")), false);

  const cli = await realpath(
    process.env["PI_TEST_CLI_PATH"] ??
      join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
  );
  const piRoot = resolve(dirname(cli), "../..");
  const piManifest: unknown = JSON.parse(await readFile(join(piRoot, "package.json"), "utf8"));
  assert.ok(typeof piManifest === "object" && piManifest !== null && "version" in piManifest);
  assert.equal(
    piManifest.version,
    piVersion,
    "Live validation requires the Pi version pinned as the development dependency.",
  );
  const loaded: unknown = await import(
    pathToFileURL(join(piRoot, "dist/modes/rpc/rpc-client.js")).href
  );
  assert.ok(isRpcClientModule(loaded), `Pi at ${piRoot} does not export RpcClient.`);

  // Isolated agent state with the real login, the pinned patcher, and the compat extension.
  const realAgentDir = getAgentDir();
  const agent = join(temporary, "agent");
  await mkdir(agent);
  await symlink(join(realAgentDir, "auth.json"), join(agent, "auth.json"));
  if (existsSync(join(realAgentDir, "APPEND_SYSTEM.md"))) {
    await copyFile(join(realAgentDir, "APPEND_SYSTEM.md"), join(agent, "APPEND_SYSTEM.md"));
  }
  await isolatePromptPatcher({
    sourceAgentDir: realAgentDir,
    agentDir: agent,
    provider: scenario.provider,
    model: scenario.model,
  });
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify({
      retry: { enabled: false, provider: { maxRetries: 0 } },
      compaction: { enabled: false, keepRecentTokens: 1 },
    }),
  );
  if (scenario.settings) {
    await writeFile(join(agent, scenario.settings.file), JSON.stringify(scenario.settings.value));
  }
  const settingsFile = join(agent, SETTINGS_FILE_NAME);
  // A threshold no request reaches enables the model without instructions or `compact`.
  await writeFile(settingsFile, JSON.stringify({ default: { compactAt: "99%" } }));
  const work = join(temporary, "work");
  await mkdir(work);
  await writeFile(join(work, "facts.txt"), `${FACTS}\n`);
  await writeFile(join(work, "pad2.txt"), pad(7000, "cobalt"));
  const sessionFile = join(temporary, "session.jsonl");

  const options = {
    cliPath: cli,
    cwd: work,
    provider: scenario.provider,
    model: scenario.model,
    env: {
      PI_CODING_AGENT_DIR: agent,
      PI_TELEMETRY: "0",
      ...(cancel ? { [CANCEL_MODE_ENV]: cancel } : {}),
      ...(hold ? { [HOLD_DIR_ENV]: temporary } : {}),
    },
    args: [
      "--thinking",
      "low",
      "--session",
      sessionFile,
      ...(cancel ? ["-e", join(root, "test/support/cancel-probe.ts")] : []),
      ...(hold ? ["-e", join(root, "test/support/compaction-probe.ts")] : []),
      "-e",
      packageRoot,
      ...(scenario.compat ? ["-e", join(root, "node_modules", scenario.compat)] : []),
      "-e",
      join(root, "node_modules/pi-system-prompt-patcher"),
      "-e",
      join(root, "test/support/wire-probe.ts"),
    ],
  };
  return { loaded, options, settingsFile, work, sessionFile, temporary, errors: errorLog(t) };
}

/** RPC client options for Pi from {@link prepareLive}. */
type LiveOptions = Awaited<ReturnType<typeof prepareLive>>["options"];

/** Run Pi in print mode with `prompt` on the live session. */
function runPrint(options: LiveOptions, prompt: string, extraArgs: readonly string[] = []) {
  return spawnSync(
    process.execPath,
    [
      options.cliPath,
      "--provider",
      options.provider,
      "--model",
      options.model,
      ...options.args,
      ...extraArgs,
      "-p",
      prompt,
    ],
    {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      encoding: "utf8",
      timeout: 480_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

/** Tokens past the measured context at which {@link armCompaction} sets `compactAt`. */
const ARMED_MARGIN = 3000;

/**
 * Measure the session's context after one small turn, then set `compactAt` {@link ARMED_MARGIN}
 * tokens above it for the scenario's model. Reading `pad2.txt` then passes the threshold, and the
 * context after compaction stays below it. Pi reads the settings when a session starts.
 */
async function armCompaction(prepared: Awaited<ReturnType<typeof prepareLive>>): Promise<number> {
  const { options, sessionFile, settingsFile, errors } = prepared;
  const run = runPrint(options, "Do not use any tools. Reply with only the word OK.");
  const entries = await sessionEntries(sessionFile);
  errors.printRun(run.stderr, messages(entries));
  assert.equal(run.status, 0, `Pi exited with status ${String(run.status)}.`);
  const usage = messages(entries).findLast((message) => message.role === "assistant")?.usage;
  const baseline = usage ? calculateContextTokens(usage) : 0;
  assert.ok(baseline > 0, `The first turn reports its context. Entries: ${outline(entries)}`);
  await writeFile(
    settingsFile,
    JSON.stringify({
      default: false,
      models: { [`${options.provider}/${options.model}`]: { compactAt: baseline + ARMED_MARGIN } },
    }),
  );
  return baseline;
}

const anthropicCompatSettings = {
  file: "pi-anthropic-compat.json",
  value: { enabled: true, keepRecentTokens: 0 },
};
const scenarios = [
  {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    role: "system",
    compat: "pi-anthropic-compat",
    settings: anthropicCompatSettings,
  },
  // Pi's built-in Anthropic provider sends the instructions and summarizes with Pi's compaction.
  {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    role: "system",
    compat: undefined,
    settings: undefined,
  },
  {
    provider: "openai-codex",
    model: "gpt-6.1-sol",
    role: "developer",
    compat: undefined,
    settings: undefined,
  },
  {
    provider: "openai-codex",
    model: "gpt-6.1-sol",
    role: "developer",
    compat: "pi-openai-codex-compat",
    settings: undefined,
  },
];
for (const scenario of scenarios) {
  test(
    `live packaged Pi CLI ${scenario.provider}/${scenario.model} ${scenario.compat ? `with ${scenario.compat}` : "without a compat extension"} instructs, compacts, and resumes`,
    { skip: process.env["PI_COMPACT_ASSISTANT_LIVE_TEST"] !== "1", timeout: 900_000 },
    async (t) => {
      const { loaded, options, settingsFile, work, errors } = await prepareLive(t, scenario);
      let client: RpcClient = new loaded.RpcClient(options);
      client.onEvent(errors.rpcEvent);
      t.after(async () => client.stop());

      async function turn(prompt: string): Promise<void> {
        const events = await client.promptAndWait(prompt, undefined, 240_000);
        assert.deepEqual(
          events.filter((event: { type: string }) => event.type === "extension_error"),
          [],
        );
        assert.doesNotMatch(client.getStderr(), /Failed to load extension|Extension error/);
      }

      async function lastAssistantText(): Promise<string> {
        const assistant = (await client.getMessages())
          .filter((message) => message.role === "assistant")
          .at(-1);
        assert.ok(assistant?.role === "assistant");
        assert.equal(assistant.stopReason, "stop", describeFailure(assistant));
        return assistant.content.map((block) => (block.type === "text" ? block.text : "")).join("");
      }

      // Measure the context after one turn, then set thresholds relative to it.
      await client.start();
      await turn("Use the read tool to read facts.txt. Remember the facts and reply with OK.");
      const baseline = (await client.getSessionStats()).contextUsage?.tokens;
      assert.ok(typeof baseline === "number" && baseline > 0);
      await client.stop();
      await writeFile(
        settingsFile,
        JSON.stringify({
          default: false,
          models: {
            [`${scenario.provider}/${scenario.model}`]: { compactAt: baseline + 6000 },
          },
        }),
      );

      client = new loaded.RpcClient(options);
      client.onEvent(errors.rpcEvent);
      await client.start();
      await turn(
        "Use the read tool to read pad2.txt. Reply with the word on its last line. Then follow any compaction instruction.",
      );
      let entries: SessionEntry[] = [];
      let resumed = false;
      for (let attempt = 0; attempt < 120 && !resumed; attempt++) {
        ({ entries } = await client.getEntries());
        const continuation = entries.findIndex(
          (entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE,
        );
        resumed =
          continuation >= 0 &&
          entries
            .slice(continuation + 1)
            .some((entry) => entry.type === "message" && entry.message.role === "assistant") &&
          !(await client.getState()).isStreaming;
        if (!resumed) await setTimeout(2000);
      }
      assert.ok(
        resumed,
        `The agent resumes from the continuation after compaction. Entries: ${outline(entries)}`,
      );
      assert.doesNotMatch(client.getStderr(), /Extension error/);

      // The resumed agent may cross a threshold again; check the cycle that ended in compaction.
      const compactionIndex = entries.findIndex((entry) => entry.type === "compaction");
      const records = entries
        .slice(0, compactionIndex)
        .filter((entry) => entry.type === "custom" && entry.customType === INSTRUCTION_TYPE);
      assert.deepEqual(
        records.map((entry) =>
          entry.type === "custom" &&
          typeof entry.data === "object" &&
          entry.data !== null &&
          "stage" in entry.data
            ? entry.data.stage
            : undefined,
        ),
        ["compact"],
      );
      const found = probes(entries);
      assert.ok(found.length > 0, "The instruction reached the provider payload.");
      for (const item of found) {
        assert.equal(item.role, scenario.role);
        assert.ok(item.index > 0, "The instruction is a mid-conversation item.");
        // The instruction steers mid-conversation and leaves the top-level system prompt alone.
        assert.ok(item.systemLength > 0, "The request keeps its top-level system prompt.");
        assert.equal(
          item.systemUnchanged,
          true,
          "The top-level system prompt equals the one sent before the instructions.",
        );
        assert.equal(
          item.systemHasInstruction,
          false,
          "No instruction is folded into the top-level system prompt.",
        );
      }
      // `compact` is declared exactly in the requests that carry the compaction instruction.
      const requests = toolProbes(entries);
      const cycle = requests.filter((request) => request.entry < compactionIndex);
      assert.ok(
        cycle.some((request) => request.stages.includes("compact")),
        `A probed request carried the compaction instruction. Entries: ${outline(entries)}`,
      );
      for (const request of cycle) {
        assert.equal(
          request.names.includes("compact"),
          request.stages.includes("compact"),
          `Declared ${JSON.stringify(request.names)} with stages ${JSON.stringify(request.stages)}.`,
        );
      }
      const resumedRequest = requests.find((request) => request.entry > compactionIndex);
      assert.ok(resumedRequest, `The resumed request was probed. Entries: ${outline(entries)}`);
      assert.equal(
        resumedRequest.names.includes("compact"),
        false,
        "Compaction withdraws compact.",
      );
      // Anthropic and Pi AI's Codex adapter add `compact` inside the conversation and keep the
      // top-level tools of the request before. pi-openai-codex-compat sends the complete current
      // tool set at the top level by design, so adding `compact` changes it.
      const topLevelChange = scenario.compat === "pi-openai-codex-compat";
      const added = cycle.findIndex((request) => request.names.includes("compact"));
      const before = cycle[added - 1];
      const first = cycle[added];
      assert.ok(before && first, `A request preceded the one that added compact.`);
      assert.deepEqual(first.top, topLevelChange ? [...before.top, "compact"] : before.top);
      const call = entries.findIndex(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.content.some(
            (block) => block.type === "toolCall" && block.name === "compact",
          ),
      );
      const compaction = entries.findIndex((entry) => entry.type === "compaction");
      const continuation = entries.findIndex(
        (entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE,
      );
      assert.ok(call >= 0, "The model called compact.");
      // The instructions ask for a Markdown state file, and the continuation names it.
      const callEntry = entries[call];
      const compactCall =
        callEntry?.type === "message" && callEntry.message.role === "assistant"
          ? callEntry.message.content.find(
              (block) => block.type === "toolCall" && block.name === "compact",
            )
          : undefined;
      const continuationMessage =
        compactCall?.type === "toolCall" && typeof compactCall.arguments["message"] === "string"
          ? compactCall.arguments["message"]
          : "";
      const stateFile = /[\w./~-]+\.md\b/.exec(continuationMessage)?.[0];
      assert.ok(stateFile, `The compact message names a Markdown file: ${continuationMessage}`);
      assert.ok(
        existsSync(resolve(work, stateFile)),
        `The named Markdown state file exists: ${stateFile}`,
      );
      assert.ok(call < compaction && compaction < continuation);
      const compactionEntry = entries[compaction];
      assert.ok(compactionEntry?.type === "compaction");
      // A compat extension supplies the native compaction. Without one, Pi summarizes.
      assert.equal(Boolean(compactionEntry.fromHook), scenario.compat !== undefined);

      await turn("Reply with only the port number from the project facts.");
      assert.match(await lastAssistantText(), /4317/);
      t.diagnostic(
        `Pi ${piVersion} with ${scenario.compat ?? "no compat extension"}: the compaction instruction reached ${scenario.provider}/${scenario.model} as a mid-conversation ${scenario.role} item beside an unchanged ${found[0]?.systemLength ?? 0}-character top-level system prompt; compact was declared only with the compaction instruction, ${topLevelChange ? "in the top-level tools" : "inside the conversation with unchanged top-level tools"}, and withdrawn after compaction; the model compacted and resumed.`,
      );
    },
  );
}

/** Entries after each poll until `done` holds and the session is idle, or two minutes pass. */
async function settledEntries(
  client: RpcClient,
  done: (entries: readonly SessionEntry[]) => boolean,
): Promise<SessionEntry[]> {
  let entries: SessionEntry[] = [];
  for (let attempt = 0; attempt < 60; attempt++) {
    ({ entries } = await client.getEntries());
    if (done(entries) && !(await client.getState()).isStreaming) return entries;
    await setTimeout(2000);
  }
  return entries;
}

/**
 * Each way an accepted request is cancelled, through the packaged CLI and a real model that
 * reaches the compaction threshold. The fixture interrupts at the point a user or extension would.
 */
const cancellations: { mode: CancelMode; notice: RegExp }[] = [
  { mode: "abort", notice: /did not run: The run was aborted\./ },
  { mode: "fail", notice: /did not run: Compaction cancelled/ },
];
const cancellationScenario = scenarios[0];
/**
 * After {@link armCompaction}, reading `pad2.txt` passes `compactAt`, so the next request carries
 * `compact` and the `[Compaction required]` instruction.
 */
const COMPACT_PROMPT =
  "Use the read tool to read pad2.txt. Do not write any files. Then follow the compaction instruction. When you call compact, use exactly this message: Reply with only the word RESUMED.";

function hasCompactCall(entries: readonly SessionEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.content.some((block) => block.type === "toolCall" && block.name === "compact"),
  );
}

for (const cancellation of cancellations) {
  test(
    `live packaged Pi CLI cancels an accepted compact request on ${cancellation.mode}`,
    { skip: process.env["PI_COMPACT_ASSISTANT_LIVE_TEST"] !== "1", timeout: 600_000 },
    async (t) => {
      assert.ok(cancellationScenario);
      const prepared = await prepareLive(t, cancellationScenario, { cancel: cancellation.mode });
      const { loaded, options, errors } = prepared;
      await armCompaction(prepared);
      const client: RpcClient = new loaded.RpcClient(options);
      client.onEvent(errors.rpcEvent);
      t.after(async () => client.stop());
      await client.start();
      await client.promptAndWait(COMPACT_PROMPT, undefined, 240_000);
      const entries = await settledEntries(client, (current) =>
        current.some(
          (entry) => entry.type === "custom_message" && entry.customType === NOTICE_TYPE,
        ),
      );
      assert.doesNotMatch(client.getStderr(), /Extension error|Failed to load extension/);
      assert.ok(hasCompactCall(entries), `The model called compact. Entries: ${outline(entries)}`);
      const notice = entries.find(
        (entry) => entry.type === "custom_message" && entry.customType === NOTICE_TYPE,
      );
      assert.ok(
        notice?.type === "custom_message",
        `A notice was sent. Entries: ${outline(entries)}`,
      );
      assert.match(JSON.stringify(notice.content), cancellation.notice);
      assert.equal(
        entries.some(
          (entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE,
        ),
        false,
        "The continuation message is withheld.",
      );
      assert.equal(
        entries.some((entry) => entry.type === "compaction"),
        false,
      );
      t.diagnostic(
        `Pi ${piVersion} with ${cancellationScenario.compat ?? "no compat extension"}: ${cancellation.mode} cancelled the request with a notice.`,
      );
    },
  );
}

/**
 * User input sent after the model calls `compact` never cancels it. Input during the run reaches
 * the model before compaction. Input during compaction waits and follows the continuation as its
 * own message.
 */
// The input does not conflict with the continuation, so the model can follow both.
const HELD_INPUT = "Include the word READY in your next reply.";
const holds = [
  // Sent while the model writes its response after the read, which calls compact, so the input
  // is queued before the tool runs.
  { when: "while the model calls compact", event: "message_start", send: "steer", held: false },
  { when: "during compaction", event: "compaction_start", send: "followUp", held: true },
] as const;

function assistantText(entry: SessionEntry | undefined): string | undefined {
  if (entry?.type !== "message" || entry.message.role !== "assistant") return undefined;
  return entry.message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

for (const hold of holds) {
  test(
    `live packaged Pi CLI delivers user input sent ${hold.when} and still compacts`,
    { skip: process.env["PI_COMPACT_ASSISTANT_LIVE_TEST"] !== "1", timeout: 600_000 },
    async (t) => {
      assert.ok(cancellationScenario);
      const prepared = await prepareLive(t, cancellationScenario);
      const { loaded, options, errors } = prepared;
      await armCompaction(prepared);
      const client: RpcClient = new loaded.RpcClient(options);
      client.onEvent(errors.rpcEvent);
      t.after(async () => client.stop());
      await client.start();
      let sent: Promise<unknown> | undefined;
      let read = false;
      client.onEvent((event) => {
        if (event.type === "tool_execution_end" && event.toolName === "read") read = true;
        if (sent || event.type !== hold.event) return;
        if (event.type === "message_start" && (event.message.role !== "assistant" || !read)) return;
        sent = hold.send === "steer" ? client.steer(HELD_INPUT) : client.followUp(HELD_INPUT);
      });
      await client.promptAndWait(COMPACT_PROMPT, undefined, 240_000);
      const userIndex = (entries: readonly SessionEntry[]) =>
        entries.findIndex(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "user" &&
            JSON.stringify(entry.message.content).includes(HELD_INPUT),
        );
      const continuationIndex = (entries: readonly SessionEntry[]) =>
        entries.findIndex(
          (entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE,
        );
      const answeredAfter = (entries: readonly SessionEntry[], index: number) =>
        index >= 0 &&
        entries
          .slice(index + 1)
          .some(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "assistant" &&
              entry.message.stopReason === "stop",
          );
      const entries = await settledEntries(
        client,
        (current) =>
          answeredAfter(current, userIndex(current)) &&
          answeredAfter(current, continuationIndex(current)),
      );
      assert.doesNotMatch(client.getStderr(), /Extension error|Failed to load extension/);
      assert.equal(await sent, hold.held ? "handled" : "queued");
      assert.ok(hasCompactCall(entries), `The model called compact. Entries: ${outline(entries)}`);
      assert.equal(
        entries.some(
          (entry) => entry.type === "custom_message" && entry.customType === NOTICE_TYPE,
        ),
        false,
        `No cancellation notice. Entries: ${outline(entries)}`,
      );
      const compaction = entries.findIndex((entry) => entry.type === "compaction");
      const continuation = continuationIndex(entries);
      const input = userIndex(entries);
      assert.ok(
        compaction >= 0 && compaction < continuation,
        `Compaction, then the continuation. Entries: ${outline(entries)}`,
      );
      if (hold.held) {
        assert.ok(continuation < input, `The input follows the continuation: ${outline(entries)}`);
      } else {
        assert.ok(input < compaction, `The input reaches the model first: ${outline(entries)}`);
      }
      // The reply to the input comes before the next user or custom message.
      const reply = entries
        .slice(input + 1)
        .find((entry) => entry.type === "message" && entry.message.role === "assistant");
      const replyText = assistantText(reply) ?? "";
      assert.match(replyText, /READY/, "The model answers the input.");
      t.diagnostic(
        `Pi ${piVersion} with ${cancellationScenario.compat ?? "no compat extension"}: input sent ${hold.when} was ${hold.held ? "held until after compaction" : "answered before compaction"}: ${JSON.stringify(replyText.slice(0, 80))}.`,
      );
    },
  );
}

/** The messages among session entries. */
function messages(entries: readonly SessionEntry[]) {
  return entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

/** The entries Pi wrote to a session file, without its header. */
async function sessionEntries(file: string): Promise<SessionEntry[]> {
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line): SessionEntry[] => {
      const entry: unknown = JSON.parse(line);
      return isSessionEntry(entry) ? [entry] : [];
    });
}

function isSessionEntry(value: unknown): value is SessionEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    value.type !== "session"
  );
}

/** The `type` of each JSON-mode event line. */
function eventTypes(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const event: unknown = JSON.parse(line);
      return typeof event === "object" && event !== null && "type" in event
        ? String(event.type)
        : "";
    });
}

/** The indexes of the compact call, the compaction, the continuation, and the reply to it. */
function compactionOrder(entries: readonly SessionEntry[]) {
  const call = entries.findIndex(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.content.some((block) => block.type === "toolCall" && block.name === "compact"),
  );
  const compaction = entries.findIndex((entry) => entry.type === "compaction");
  const continuation = entries.findIndex(
    (entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE,
  );
  const reply =
    continuation < 0
      ? -1
      : entries.findIndex(
          (entry, index) =>
            index > continuation &&
            entry.type === "message" &&
            entry.message.role === "assistant" &&
            entry.message.stopReason === "stop",
        );
  return { call, compaction, continuation, reply };
}

/**
 * A print or JSON run ends when its prompt returns. It must still run the compaction and the
 * continuation's turn before it exits.
 */
for (const output of ["text", "json"] as const) {
  test(
    `live packaged Pi CLI ${output} print run compacts and answers the continuation before it exits`,
    { skip: process.env["PI_COMPACT_ASSISTANT_LIVE_TEST"] !== "1", timeout: 600_000 },
    async (t) => {
      assert.ok(cancellationScenario);
      const prepared = await prepareLive(t, cancellationScenario);
      const { options, sessionFile, errors } = prepared;
      await armCompaction(prepared);
      const run = runPrint(options, COMPACT_PROMPT, output === "json" ? ["--mode", "json"] : []);
      const entries = await sessionEntries(sessionFile);
      errors.printRun(run.stderr, messages(entries));
      assert.equal(run.error, undefined, "Pi started and finished within the timeout.");
      assert.equal(run.status, 0, `Pi exited with status ${String(run.status)}.`);
      const { stdout } = run;
      const order = compactionOrder(entries);
      assert.ok(
        order.call >= 0 &&
          order.call < order.compaction &&
          order.compaction < order.continuation &&
          order.continuation < order.reply,
        `Compact call, compaction, continuation, then its reply. Entries: ${outline(entries)}`,
      );
      assert.equal(
        entries.some(
          (entry) => entry.type === "custom_message" && entry.customType === NOTICE_TYPE,
        ),
        false,
        `No cancellation notice. Entries: ${outline(entries)}`,
      );
      const reply = assistantText(entries[order.reply]) ?? "";
      assert.match(reply, /RESUMED/);
      if (output === "text") {
        // Text mode prints the last assistant message, so the run ended after the reply.
        assert.equal(stdout.trim(), reply.trim());
      } else {
        const events = eventTypes(stdout);
        const compactionEnd = events.indexOf("compaction_end");
        const lastEnd = events.lastIndexOf("agent_end");
        assert.ok(
          compactionEnd >= 0 && compactionEnd < lastEnd,
          `JSON events show compaction, then the continuation's run: ${events.join(",")}`,
        );
      }
      t.diagnostic(
        `Pi ${piVersion} ${output} print run: compacted and answered the continuation (${JSON.stringify(reply.slice(0, 40))}) before exiting.`,
      );
    },
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Terminal output with escape sequences removed. */
function visibleText(output: string): string {
  return stripVTControlCharacters(output);
}

const tuiSupported = process.platform === "darwin" || process.platform === "linux";

/**
 * Start the interactive TUI with `prompt` in a pseudo-terminal from the operating system's
 * `script` utility. `until` polls a condition and fails with the screen when Pi exits or two
 * hundred and forty seconds pass.
 */
function launchTui(t: TestContext, options: LiveOptions, prompt: string) {
  const command = [
    process.execPath,
    options.cliPath,
    "--provider",
    options.provider,
    "--model",
    options.model,
    ...options.args,
    prompt,
  ];
  // A fixed size, because the pseudo-terminal starts without one.
  const inner = `stty cols 120 rows 40 && exec ${command.map(shellQuote).join(" ")}`;
  const pty =
    process.platform === "darwin"
      ? ["script", "-q", "/dev/null", "/bin/sh", "-c", inner]
      : ["script", "-qfec", `/bin/sh -c ${shellQuote(inner)}`, "/dev/null"];
  // Node gives the child a socket for stdin, and macOS `script` needs a pipe, so `cat` relays.
  const child = spawn("/bin/sh", ["-c", `cat | exec ${pty.map(shellQuote).join(" ")}`], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env, TERM: "xterm-256color" },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on("data", (data: Buffer) => {
    output += data.toString();
  });
  t.after(() => {
    if (child.exitCode === null && child.pid) process.kill(-child.pid, "SIGKILL");
  });
  const screen = () => visibleText(output);
  async function until(label: string, done: () => boolean | Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 240; attempt++) {
      if (await done()) return;
      assert.equal(
        child.exitCode,
        null,
        `Pi exited while waiting for ${label}. Screen: ${screen().slice(-2000)}`,
      );
      await setTimeout(1000);
    }
    assert.fail(`Timed out waiting for ${label}. Screen: ${screen().slice(-2000)}`);
  }
  return {
    screen,
    until,
    type: (text: string) => child.stdin.write(text),
    /** Screen lines trimmed for the error log, which reads extension error lines. */
    trimmedScreen: () =>
      screen()
        .split("\n")
        .map((line) => line.trim())
        .join("\n"),
  };
}

/**
 * In the interactive TUI, the recorded instruction appears in the transcript as a box instead of a
 * status notice. Input typed during compaction waits in the editor's compaction queue, then
 * follows the continuation as its own message.
 */
test(
  "live packaged Pi CLI interactive session draws the instruction and sends input typed during compaction after the continuation",
  {
    skip: process.env["PI_COMPACT_ASSISTANT_LIVE_TEST"] !== "1" || !tuiSupported,
    timeout: 600_000,
  },
  async (t) => {
    assert.ok(cancellationScenario);
    const prepared = await prepareLive(t, cancellationScenario, { hold: true });
    const { options, sessionFile, temporary, errors } = prepared;
    await armCompaction(prepared);
    const tui = launchTui(t, options, COMPACT_PROMPT);
    try {
      await tui.until("compaction to start", () => existsSync(join(temporary, STARTED_FILE)));
      tui.type(HELD_INPUT);
      await setTimeout(500);
      tui.type("\r");
      await tui.until("the TUI to queue the input", () =>
        tui.screen().includes("Queued message for after compaction"),
      );
      await writeFile(join(temporary, TYPED_FILE), "");

      const heldIndex = (entries: readonly SessionEntry[]) =>
        entries.findIndex(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "user" &&
            JSON.stringify(entry.message.content).includes(HELD_INPUT),
        );
      const answered = (entries: readonly SessionEntry[]) => {
        const held = heldIndex(entries);
        return (
          held >= 0 &&
          entries
            .slice(held + 1)
            .some(
              (entry) =>
                entry.type === "message" &&
                entry.message.role === "assistant" &&
                entry.message.stopReason === "stop",
            )
        );
      };
      let entries: SessionEntry[] = [];
      await tui.until("the reply to the typed input", async () => {
        entries = await sessionEntries(sessionFile);
        return answered(entries);
      });
      assert.doesNotMatch(tui.screen(), /Extension error|Failed to load extension/);
      const order = compactionOrder(entries);
      const held = heldIndex(entries);
      assert.ok(
        order.call >= 0 && order.call < order.compaction && order.compaction < order.continuation,
        `Compact call, compaction, then the continuation. Entries: ${outline(entries)}`,
      );
      assert.ok(
        order.continuation < held,
        `The typed input follows the continuation. Entries: ${outline(entries)}`,
      );
      assert.equal(
        entries.some(
          (entry) => entry.type === "custom_message" && entry.customType === NOTICE_TYPE,
        ),
        false,
        `No cancellation notice. Entries: ${outline(entries)}`,
      );
      const reply = entries
        .slice(held + 1)
        .find((entry) => entry.type === "message" && entry.message.role === "assistant");
      const replyText = assistantText(reply) ?? "";
      assert.match(replyText, /READY/, "The model answers the typed input.");
      assert.match(tui.screen(), /\[Compaction required\] Added at [\d,]+ tokens/);
      assert.doesNotMatch(tui.screen(), /Compaction instruction added at|renderer failed/);
      t.diagnostic(
        `Pi ${piVersion} interactive TUI: the instruction appeared in the transcript as a box, and input typed during compaction followed the continuation: ${JSON.stringify(replyText.slice(0, 80))}.`,
      );
    } finally {
      // The TUI shows notices only on screen, so report extension error lines and failed responses.
      errors.printRun(tui.trimmedScreen(), messages(await sessionEntries(sessionFile)));
    }
  },
);
