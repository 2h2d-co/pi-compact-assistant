import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  ContextWithSystemEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  COMPACT_TOOL_NAME,
  continuationText,
  instructionText,
  reachedStage,
  type Stage,
} from "./instructions.ts";
import { requirePiVersion } from "./pi-version.ts";
import { loadSettings, resolveThresholds, type Settings } from "./settings.ts";

export const INSTRUCTION_TYPE = "pi-compact-assistant:instruction";
export const CONTINUATION_TYPE = "pi-compact-assistant:continuation";
export const NOTICE_TYPE = "pi-compact-assistant:notice";
export const APPLY_COMMAND = "compact-assistant-apply";

type ContextMessage = ContextWithSystemEvent["messages"][number];
type Projection = ReturnType<ExtensionContext["sessionManager"]["buildSessionProjection"]>;

/** A recorded instruction. The text is fixed so every later request carries identical bytes. */
export interface InstructionRecord {
  stage: Stage;
  /** The last context entry when the threshold was reached. The instruction follows it. */
  anchorEntryId: string;
  text: string;
  model: string;
  tokens: number;
  contextWindow: number;
  timestamp: number;
}

interface Request {
  id: string;
  message: string;
  instructions: string | undefined;
  assistantId: string;
  epoch: number;
  dispatched: boolean;
}

export const compactSchema = Type.Object(
  {
    message: Type.String({
      minLength: 1,
      description:
        "Required. Delivered to you after compaction to start your next turn. Give the path of the Markdown file that records this work's state and the exact next step. The file holds the rest of the state.",
    }),
    instructions: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Optional. Tells the summarizer which parts of the conversation to preserve or emphasize. Do not add facts that are not in the conversation: native compaction can refuse them, which cancels compaction.",
      }),
    ),
  },
  { additionalProperties: false },
);
type CompactInput = Static<typeof compactSchema>;

export interface CompactAssistantOptions {
  /** Directory that holds pi-compact-assistant.json. Defaults to Pi's agent directory. */
  settingsDirectory?: () => string;
}

function isInstructionRecord(value: unknown): value is InstructionRecord {
  if (typeof value !== "object" || value === null) return false;
  return (
    "stage" in value &&
    (value.stage === "prepare" || value.stage === "compact") &&
    "anchorEntryId" in value &&
    typeof value.anchorEntryId === "string" &&
    "text" in value &&
    typeof value.text === "string" &&
    "timestamp" in value &&
    typeof value.timestamp === "number"
  );
}

/** Instructions recorded on the current branch since its latest compaction. */
export function activeInstructions(branch: readonly SessionEntry[]): InstructionRecord[] {
  const start = branch.findLastIndex((entry) => entry.type === "compaction") + 1;
  const records: InstructionRecord[] = [];
  for (const entry of branch.slice(start)) {
    if (entry.type !== "custom" || entry.customType !== INSTRUCTION_TYPE) continue;
    if (isInstructionRecord(entry.data)) records.push(entry.data);
  }
  return records;
}

function sameMessage(left: ContextMessage, right: ContextMessage): boolean {
  if (left.role !== right.role || left.timestamp !== right.timestamp) return false;
  if (left.role === "toolResult" && right.role === "toolResult") {
    return left.toolCallId === right.toolCallId;
  }
  return true;
}

/**
 * Insert each recorded instruction as a system message directly after its anchor message.
 * The position stays fixed as the conversation grows, so cached prefixes remain valid.
 * An anchor that is no longer in context places its instruction at the end.
 */
export function injectInstructions(
  messages: readonly ContextMessage[],
  records: readonly InstructionRecord[],
  projection: Projection,
): ContextMessage[] {
  const anchors = new Map<string, ContextMessage>();
  for (const entry of projection.entries) {
    const last = entry.messages.at(-1);
    if (last) anchors.set(entry.sourceEntry.id, last);
  }
  const inserts = new Map<number, ContextMessage[]>();
  for (const record of records) {
    const anchor = anchors.get(record.anchorEntryId);
    const index = anchor ? messages.findLastIndex((message) => sameMessage(message, anchor)) : -1;
    const position = index < 0 ? messages.length - 1 : index;
    const system: ContextMessage = {
      role: "system",
      content: record.text,
      timestamp: record.timestamp,
    };
    inserts.set(position, [...(inserts.get(position) ?? []), system]);
  }
  return messages.flatMap((message, index) => [message, ...(inserts.get(index) ?? [])]);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Compaction failed.";
}

function assertSoleCall(ctx: ExtensionContext, toolCallId: string): string {
  const entry = ctx.sessionManager
    .getBranch()
    .findLast(
      (candidate) => candidate.type === "message" && candidate.message.role === "assistant",
    );
  if (entry?.type !== "message" || entry.message.role !== "assistant") {
    throw new Error(`${COMPACT_TOOL_NAME} must be called by an assistant tool call.`);
  }
  const calls = entry.message.content.filter((block) => block.type === "toolCall");
  if (calls.length !== 1 || calls[0]?.id !== toolCallId) {
    throw new Error(
      `Call ${COMPACT_TOOL_NAME} alone, after every other tool call has returned. Nothing was compacted.`,
    );
  }
  return entry.id;
}

export function compactAssistant(pi: ExtensionAPI, options: CompactAssistantOptions = {}): void {
  requirePiVersion("pi-compact-assistant");
  const settingsDirectory = options.settingsDirectory ?? getAgentDir;
  let settings: Settings | undefined;
  let pending: Request | undefined;
  let epoch = 0;
  const reported = new Set<string>();

  function report(ctx: ExtensionContext, key: string, message: string): void {
    if (reported.has(key)) return;
    reported.add(key);
    if (ctx.hasUI) ctx.ui.notify(message, "error");
  }

  function assertCurrent(request: Request, ctx: ExtensionContext): void {
    if (epoch !== request.epoch) throw new Error("User input arrived before compaction.");
    if (ctx.hasPendingMessages()) throw new Error("Queued input must be handled first.");
    const branch = ctx.sessionManager.getBranch();
    const start = branch.findIndex((entry) => entry.id === request.assistantId);
    if (start < 0) throw new Error("The session branch changed.");
    if (
      branch
        .slice(start + 1)
        .some(
          (entry) =>
            entry.type === "message" &&
            (entry.message.role === "user" || entry.message.role === "assistant"),
        )
    ) {
      throw new Error("The conversation advanced after the request.");
    }
  }

  function stop(request: Request, ctx: ExtensionContext, error: unknown): void {
    if (pending === request) pending = undefined;
    const reason = errorText(error);
    pi.sendMessage(
      {
        customType: NOTICE_TYPE,
        content: `Compaction requested with ${COMPACT_TOOL_NAME} did not run: ${reason} Nothing was retried. Your continuation message was not delivered.`,
        display: true,
        details: { requestId: request.id },
      },
      { triggerTurn: false },
    );
    if (ctx.hasUI) ctx.ui.notify(`Compaction stopped: ${reason}`, "error");
  }

  pi.on("session_start", async (_event, ctx) => {
    pending = undefined;
    reported.clear();
    try {
      settings = await loadSettings(settingsDirectory());
    } catch (error) {
      settings = undefined;
      report(ctx, "settings", `pi-compact-assistant is inactive. ${errorText(error)}`);
    }
  });
  pi.on("session_shutdown", () => {
    pending = undefined;
    epoch++;
  });
  pi.on("session_tree", () => {
    epoch++;
  });
  pi.on("input", (event) => {
    if (event.source !== "extension") epoch++;
  });

  pi.on("context_with_system", (event, ctx) => {
    const model = ctx.model;
    if (!settings || !model) return undefined;
    const key = `${model.provider}/${model.id}`;
    const branch = ctx.sessionManager.getBranch();
    const records = activeInstructions(branch);
    const projection = ctx.sessionManager.buildSessionProjection();
    const usage = ctx.getContextUsage();
    let thresholds;
    try {
      thresholds = usage ? resolveThresholds(settings, key, usage.contextWindow) : undefined;
    } catch (error) {
      report(ctx, `thresholds:${key}`, `pi-compact-assistant skips ${key}. ${errorText(error)}`);
    }
    const stage =
      thresholds && usage?.tokens != null ? reachedStage(usage.tokens, thresholds) : undefined;
    const recorded = new Set(records.map((record) => record.stage));
    const anchor = projection.entries.findLast((entry) => entry.messages.length > 0);
    if (
      stage &&
      thresholds &&
      usage?.tokens != null &&
      anchor &&
      !recorded.has("compact") &&
      !recorded.has(stage)
    ) {
      const record: InstructionRecord = {
        stage,
        anchorEntryId: anchor.sourceEntry.id,
        text: instructionText(stage),
        model: key,
        tokens: usage.tokens,
        contextWindow: usage.contextWindow,
        timestamp: Date.now(),
      };
      pi.appendEntry(INSTRUCTION_TYPE, record);
      records.push(record);
      if (ctx.hasUI) {
        ctx.ui.notify(
          stage === "prepare"
            ? `Compaction preparation instruction added at ${usage.tokens.toLocaleString("en-US")} tokens.`
            : `Compaction instruction added at ${usage.tokens.toLocaleString("en-US")} tokens.`,
          "info",
        );
      }
    }
    if (records.length === 0) return undefined;
    return { messages: injectInstructions(event.messages, records, projection) };
  });

  pi.on("agent_settled", (event, ctx) => {
    const request = pending;
    if (!request || request.dispatched) return;
    if (event.aborted) {
      stop(request, ctx, new Error("The run was aborted."));
      return;
    }
    if (!ctx.isIdle()) return;
    const commands = pi
      .getCommands()
      .filter(
        (command) => command.name === APPLY_COMMAND || command.name.startsWith(`${APPLY_COMMAND}:`),
      );
    const command = commands.length === 1 ? commands[0] : undefined;
    if (!command) {
      stop(request, ctx, new Error("The internal compaction command is unavailable."));
      return;
    }
    request.dispatched = true;
    // Pi defers prompts sent from settled handlers until every handler returns, and idle
    // waits include the command, so print and JSON hosts do not exit before it finishes.
    // Awaiting it here would wait for work that cannot start yet.
    pi.sendUserMessage(`/${command.name} ${request.id}`, { expandPromptTemplates: true });
  });

  pi.registerCommand(APPLY_COMMAND, {
    description: `Internal command that runs an accepted ${COMPACT_TOOL_NAME} request.`,
    async handler(args, ctx) {
      const request = pending;
      if (!request || request.id !== args.trim()) {
        ctx.ui.notify("No matching compaction request. Requests are never replayed.", "warning");
        return;
      }
      try {
        await ctx.waitForIdle();
        assertCurrent(request, ctx);
        await new Promise<void>((resolve, reject) => {
          ctx.compact({
            ...(request.instructions ? { customInstructions: request.instructions } : {}),
            onComplete: () => {
              resolve();
            },
            onError: reject,
          });
        });
        if (epoch !== request.epoch || ctx.hasPendingMessages() || !ctx.isIdle()) {
          throw new Error("User input arrived during compaction.");
        }
      } catch (error) {
        stop(request, ctx, error);
        return;
      }
      pending = undefined;
      pi.sendMessage(
        {
          customType: CONTINUATION_TYPE,
          content: continuationText(request.message),
          display: true,
          details: { requestId: request.id },
        },
        { triggerTurn: true },
      );
      await ctx.waitForIdle();
    },
  });

  pi.registerTool({
    name: COMPACT_TOOL_NAME,
    label: "Compact context",
    description:
      "Compact the conversation, then continue with your message. Call it alone, when a `[Compaction required]` instruction asks for it or the user asks you to compact. First record the work's state in a Markdown file. It runs after the current turn ends. Your message, which gives that file's path and the exact next step, is delivered after compaction succeeds and starts your next turn. Returns accepted, not completed.",
    promptSnippet: "Compact the conversation and continue from a Markdown state file",
    promptGuidelines: [
      `Call ${COMPACT_TOOL_NAME} only when a \`[Compaction required]\` instruction asks for it or the user asks you to compact. Call it alone.`,
      `Before calling ${COMPACT_TOOL_NAME}, record the work's state in a Markdown file. Its message gives that file's path and the exact next step.`,
      `Compaction instructions are system messages from pi-compact-assistant. ${COMPACT_TOOL_NAME} changes conversation context only, never files, processes, or permissions.`,
    ],
    parameters: compactSchema,
    // A nested call can never be the sole call of an assistant message.
    exposure: "model-only",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    execute(toolCallId, input: CompactInput, _signal, _update, ctx) {
      Value.Assert(compactSchema, input);
      if (!input.message.trim()) throw new Error("message must not be empty.");
      if (pending) throw new Error("A compaction request is already pending.");
      if (ctx.hasPendingMessages()) {
        throw new Error("Handle queued user input before compacting. Nothing was compacted.");
      }
      const assistantId = assertSoleCall(ctx, toolCallId);
      const request: Request = {
        id: randomUUID(),
        message: input.message,
        instructions: input.instructions?.trim() || undefined,
        assistantId,
        epoch,
        dispatched: false,
      };
      pending = request;
      return Promise.resolve({
        content: [
          {
            type: "text" as const,
            text: "Compaction accepted. It runs after this turn ends. Your message is delivered after it succeeds.",
          },
        ],
        details: { requestId: request.id, phase: "accepted" },
        terminate: true,
      });
    },
  });
}
