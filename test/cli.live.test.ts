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
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";
import manifest from "../package.json" with { type: "json" };
import { CONTINUATION_TYPE, INSTRUCTION_TYPE } from "../src/extension.ts";
import { SETTINGS_FILE_NAME } from "../src/settings.ts";
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
const scenarios = [
  {
    provider: "anthropic",
    model: "claude-fable-5-1",
    role: "system",
    compat: "pi-anthropic-compat",
    settings: { file: "pi-anthropic-compat.json", value: { enabled: true, keepRecentTokens: 0 } },
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
        await writeFile(
          join(agent, scenario.settings.file),
          JSON.stringify(scenario.settings.value),
        );
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
        env: { PI_CODING_AGENT_DIR: agent, PI_TELEMETRY: "0" },
        args: [
          "--thinking",
          "low",
          "--session",
          join(temporary, "session.jsonl"),
          "-e",
          packageRoot,
          ...(scenario.compat ? ["-e", join(root, "node_modules", scenario.compat)] : []),
          "-e",
          join(root, "node_modules/pi-system-prompt-patcher"),
          "-e",
          join(root, "test/wire-probe.ts"),
        ],
      };
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
            [`${scenario.provider}/${scenario.model}`]: {
              prepareAt: baseline + 1500,
              compactAt: baseline + 6000,
            },
          },
        }),
      );

      client = new loaded.RpcClient(options);
      await client.start();
      await turn("Use the read tool to read pad1.txt. Reply with the word on its last line.");
      assert.match(await lastAssistantText(), /amber/i);
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

      const records = entries.filter(
        (entry) => entry.type === "custom" && entry.customType === INSTRUCTION_TYPE,
      );
      assert.deepEqual(
        records.map((entry) =>
          entry.type === "custom" &&
          typeof entry.data === "object" &&
          entry.data !== null &&
          "stage" in entry.data
            ? entry.data.stage
            : undefined,
        ),
        ["prepare", "compact"],
      );
      const found = probes(entries);
      for (const stage of ["prepare", "compact"]) {
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
      t.diagnostic(
        `Pi ${piVersion} with ${scenario.compat ?? "no compat extension"}: prepare and compact instructions reached ${scenario.provider}/${scenario.model} as ${scenario.role} items; the model compacted and resumed.`,
      );
    },
  );
}
