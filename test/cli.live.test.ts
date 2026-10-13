import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import { getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";
import manifest from "../package.json" with { type: "json" };
import { CONTINUATION_TYPE, INSTRUCTION_TYPE, NOTICE_TYPE } from "../src/extension.ts";
import { SETTINGS_FILE_NAME } from "../src/settings.ts";
import { CANCEL_MODE_ENV, type CancelMode } from "./cancel-probe.ts";
import { archiveEntries, expectedArchiveEntries, packageArchive } from "./package-archive.ts";
import { isolatePromptPatcher } from "./prompt-patcher.ts";
import { PROBE_TYPE, type ProbedInstruction } from "./wire-probe.ts";

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
    typeof value.index === "number"
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
        return `assistant(${message.stopReason}${calls.length ? `:${calls.join(",")}` : ""}${message.errorMessage ? `:${message.errorMessage.slice(0, 200)}` : ""})`;
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
async function prepareLive(t: TestContext, scenario: Scenario, cancel?: CancelMode) {
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
  await writeFile(settingsFile, JSON.stringify({ default: false }));
  const work = join(temporary, "work");
  await mkdir(work);
  await writeFile(join(work, "facts.txt"), `${FACTS}\n`);
  await writeFile(join(work, "pad1.txt"), pad(3000, "amber"));
  await writeFile(join(work, "pad2.txt"), pad(7000, "cobalt"));

  const options = {
    cliPath: cli,
    cwd: work,
    provider: scenario.provider,
    model: scenario.model,
    env: {
      PI_CODING_AGENT_DIR: agent,
      PI_TELEMETRY: "0",
      ...(cancel ? { [CANCEL_MODE_ENV]: cancel } : {}),
    },
    args: [
      "--thinking",
      "low",
      "--session",
      join(temporary, "session.jsonl"),
      // The branch fixture must load first so its settled handler dispatches first.
      ...(cancel ? ["-e", join(root, "test/cancel-probe.ts")] : []),
      "-e",
      packageRoot,
      ...(scenario.compat ? ["-e", join(root, "node_modules", scenario.compat)] : []),
      "-e",
      join(root, "node_modules/pi-system-prompt-patcher"),
      "-e",
      join(root, "test/wire-probe.ts"),
    ],
  };
  return { loaded, options, settingsFile, work };
}

const anthropicCompatSettings = {
  file: "pi-anthropic-compat.json",
  value: { enabled: true, keepRecentTokens: 0 },
};
const scenarios = [
  {
    provider: "anthropic",
    model: "claude-fable-5-1",
    role: "system",
    compat: "pi-anthropic-compat",
    settings: anthropicCompatSettings,
    compactOnly: false,
  },
  // Without prepareAt, only the self-contained compaction instruction is posted.
  {
    provider: "anthropic",
    model: "claude-fable-5-1",
    role: "system",
    compat: "pi-anthropic-compat",
    settings: anthropicCompatSettings,
    compactOnly: true,
  },
  // Pi's built-in Anthropic provider sends the instructions and summarizes with Pi's compaction.
  {
    provider: "anthropic",
    model: "claude-fable-5-1",
    role: "system",
    compat: undefined,
    settings: undefined,
    compactOnly: false,
  },
  {
    provider: "openai-codex",
    model: "gpt-6.1-sol",
    role: "developer",
    compat: undefined,
    settings: undefined,
    compactOnly: false,
  },
  {
    provider: "openai-codex",
    model: "gpt-6.1-sol",
    role: "developer",
    compat: "pi-openai-codex-compat",
    settings: undefined,
    compactOnly: false,
  },
];
for (const scenario of scenarios) {
  test(
    `live packaged Pi CLI ${scenario.provider}/${scenario.model} ${scenario.compat ? `with ${scenario.compat}` : "without a compat extension"}${scenario.compactOnly ? " with only compactAt" : ""} instructs, compacts, and resumes`,
    { skip: process.env["PI_COMPACT_ASSISTANT_LIVE_TEST"] !== "1", timeout: 900_000 },
    async (t) => {
      const { loaded, options, settingsFile, work } = await prepareLive(t, scenario);
      let client: RpcClient = new loaded.RpcClient(options);
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
        assert.equal(assistant.stopReason, "stop", assistant.errorMessage);
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
            [`${scenario.provider}/${scenario.model}`]: scenario.compactOnly
              ? { compactAt: baseline + 6000 }
              : { prepareAt: baseline + 1500, compactAt: baseline + 6000 },
          },
        }),
      );

      client = new loaded.RpcClient(options);
      await client.start();
      if (!scenario.compactOnly) {
        await turn("Use the read tool to read pad1.txt. Reply with the word on its last line.");
        assert.match(await lastAssistantText(), /amber/i);
      }
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
        scenario.compactOnly ? ["compact"] : ["prepare", "compact"],
      );
      const found = probes(entries);
      for (const stage of scenario.compactOnly ? ["compact"] : ["prepare", "compact"]) {
        const seen = found.filter((item) => item.stage === stage);
        assert.ok(seen.length > 0, `The ${stage} instruction reached the provider payload.`);
        for (const item of seen) {
          assert.equal(item.role, scenario.role);
          assert.ok(item.index > 0, "The instruction is a mid-conversation item.");
        }
      }
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
      if (scenario.compactOnly) {
        assert.ok(
          found.every((item) => item.stage !== "prepare"),
          "No preparation instruction reached the provider.",
        );
        const recorded = records[0];
        assert.ok(
          recorded?.type === "custom" &&
            typeof recorded.data === "object" &&
            recorded.data !== null &&
            "text" in recorded.data &&
            typeof recorded.data.text === "string" &&
            recorded.data.text.includes("Record the current state in a Markdown state file"),
          "The compaction instruction is the self-contained one.",
        );
      }
      t.diagnostic(
        `Pi ${piVersion} with ${scenario.compat ?? "no compat extension"}: ${scenario.compactOnly ? "the self-contained compact instruction" : "prepare and compact instructions"} reached ${scenario.provider}/${scenario.model} as ${scenario.role} items; the model compacted and resumed.`,
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
 * Each way an accepted request is cancelled, through the packaged CLI and a real model that the
 * user asks to compact. The fixture interrupts at the point a user or extension would.
 */
const cancellations: { mode: CancelMode; notice: RegExp }[] = [
  { mode: "abort", notice: /did not run: The run was aborted\./ },
  { mode: "branch", notice: /did not run: The session branch changed\./ },
  { mode: "fail", notice: /did not run: Compaction cancelled/ },
];
const cancellationScenario = scenarios[0];
const COMPACT_PROMPT =
  "Do not read or write files. Call the compact tool now as your only tool call, with the message: Reply with only the word RESUMED.";

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
      const { loaded, options } = await prepareLive(t, cancellationScenario, cancellation.mode);
      const client: RpcClient = new loaded.RpcClient(options);
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
 * User input sent after the model calls `compact` waits for compaction, then follows the
 * continuation in one turn. The held input conflicts with the continuation, and the user wins.
 */
const HELD_INPUT = "Reply with only the word READY.";
const holds = [
  { when: "after the call is accepted", event: "tool_execution_end", send: "steer" },
  { when: "during compaction", event: "compaction_start", send: "followUp" },
] as const;
for (const hold of holds) {
  test(
    `live packaged Pi CLI holds user input sent ${hold.when} until compaction finishes`,
    { skip: process.env["PI_COMPACT_ASSISTANT_LIVE_TEST"] !== "1", timeout: 600_000 },
    async (t) => {
      assert.ok(cancellationScenario);
      const { loaded, options } = await prepareLive(t, cancellationScenario);
      const client: RpcClient = new loaded.RpcClient(options);
      t.after(async () => client.stop());
      await client.start();
      let sent: Promise<unknown> | undefined;
      client.onEvent((event) => {
        if (sent || event.type !== hold.event) return;
        if (event.type === "tool_execution_end" && event.toolName !== "compact") return;
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
      const entries = await settledEntries(client, (current) => {
        const index = userIndex(current);
        return (
          index >= 0 &&
          current
            .slice(index + 1)
            .some(
              (entry) =>
                entry.type === "message" &&
                entry.message.role === "assistant" &&
                entry.message.stopReason === "stop",
            )
        );
      });
      assert.doesNotMatch(client.getStderr(), /Extension error|Failed to load extension/);
      assert.equal(await sent, "handled", "Pi reports the input as handled, not queued.");
      assert.ok(hasCompactCall(entries), `The model called compact. Entries: ${outline(entries)}`);
      assert.equal(
        entries.some(
          (entry) => entry.type === "custom_message" && entry.customType === NOTICE_TYPE,
        ),
        false,
        `No cancellation notice. Entries: ${outline(entries)}`,
      );
      const compaction = entries.findIndex((entry) => entry.type === "compaction");
      const continuation = entries.findIndex(
        (entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE,
      );
      const input = userIndex(entries);
      assert.ok(
        compaction >= 0 && compaction < continuation && continuation < input,
        `Compaction, then the continuation, then the held input. Entries: ${outline(entries)}`,
      );
      const call = entries.findLastIndex(
        (entry, index) => index < compaction && entry.type === "message",
      );
      const beforeCompaction = entries[call];
      assert.ok(
        beforeCompaction?.type === "message" && beforeCompaction.message.role === "toolResult",
        `The model did not answer the input before compaction. Entries: ${outline(entries)}`,
      );
      const reply = entries
        .slice(input + 1)
        .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
      assert.ok(reply?.type === "message" && reply.message.role === "assistant");
      const replyText = reply.message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      assert.match(replyText, /READY/, "The user's newer input wins over the continuation.");
      t.diagnostic(
        `Pi ${piVersion} with ${cancellationScenario.compat ?? "no compat extension"}: input sent ${hold.when} was held and answered after compaction: ${JSON.stringify(replyText.slice(0, 80))}.`,
      );
    },
  );
}
