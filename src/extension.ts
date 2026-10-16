import { randomUUID } from "node:crypto";
import { getAgentDir, keyText } from "@earendil-works/pi-coding-agent";
import type {
  ContextWithSystemEvent,
  CustomEntry,
  EntryRenderOptions,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text, type Component } from "@earendil-works/pi-tui";
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
import { isDisabled, loadSettings, resolveThresholds, type Settings } from "./settings.ts";
import { findCodexCompatProblem, unsupportedReason } from "./support.ts";

export const INSTRUCTION_TYPE = "pi-compact-assistant:instruction";
export const CONTINUATION_TYPE = "pi-compact-assistant:continuation";
export const NOTICE_TYPE = "pi-compact-assistant:notice";
export const HELD_WIDGET = "pi-compact-assistant:held";

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

/** User input that arrived after the request was accepted. It is delivered after compaction. */
interface HeldInput {
  text: string;
  images: NonNullable<InputEvent["images"]>;
}

interface Request {
  id: string;
  message: string;
  instructions: string | undefined;
  dispatched: boolean;
  held: HeldInput[];
}

function preview(text: string): string {
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export const compactSchema = Type.Object(
  {
    message: Type.String({
      minLength: 1,
      description:
        "Required. Delivered to you after compaction to start your next turn. Give the Markdown state file's absolute path and the exact next step. The state file holds the rest. If you could not write the state file, put the full state here. If no work is pending, say so.",
    }),
    instructions: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Optional and usually unnecessary. Use it only to name conversation content the summary must keep. Do not include plans, new facts, or the state file's contents. Native compaction can refuse them, and a refusal cancels the compaction.",
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

const STAGE_LABELS: Record<Stage, string> = {
  prepare: "[Compaction preparation]",
  compact: "[Compaction required]",
};

function tokenSummary(record: InstructionRecord): string {
  if (!Number.isFinite(record.tokens)) return "Added to the conversation.";
  const tokens = record.tokens.toLocaleString("en-US");
  if (!Number.isFinite(record.contextWindow) || record.contextWindow <= 0) {
    return `Added at ${tokens} tokens.`;
  }
  const percent = Math.round((record.tokens / record.contextWindow) * 100);
  return `Added at ${tokens} tokens, ${percent}% of the ${record.contextWindow.toLocaleString("en-US")}-token context window.`;
}

/**
 * Draw a recorded instruction in the interactive transcript. Expanded, it shows the exact text
 * the model receives. The entry itself stays out of model context.
 */
export function renderInstruction(
  entry: Pick<CustomEntry, "data">,
  options: EntryRenderOptions,
  theme: Pick<Theme, "fg" | "bg" | "bold">,
): Component | undefined {
  const record = entry.data;
  if (!isInstructionRecord(record)) return undefined;
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  const summary = `${theme.fg("customMessageLabel", theme.bold(STAGE_LABELS[record.stage]))} ${theme.fg("customMessageText", tokenSummary(record))}`;
  const key = keyText("app.tools.expand");
  // Without a bound expand key there is nothing to press, so no hint is shown.
  const hint =
    options.expanded || !key
      ? ""
      : ` ${theme.fg("dim", key)}${theme.fg("muted", " to view the instruction")}`;
  box.addChild(new Text(`${summary}${hint}`, 0, 0));
  if (options.expanded) {
    box.addChild(new Spacer(1));
    box.addChild(new Text(theme.fg("customMessageText", record.text), 0, 0));
  }
  return box;
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

/** The fields {@link sameMessage} compares. */
function messageKey(message: ContextMessage): string {
  return JSON.stringify([
    message.role,
    message.timestamp,
    message.role === "toolResult" ? message.toolCallId : null,
  ]);
}

function sameMessage(left: ContextMessage, right: ContextMessage): boolean {
  if (left.role !== right.role || left.timestamp !== right.timestamp) return false;
  if (left.role === "toolResult" && right.role === "toolResult") {
    return left.toolCallId === right.toolCallId;
  }
  return true;
}

interface Anchor {
  message: ContextMessage;
  /** How many earlier session messages match it, so equal timestamps resolve to the same one. */
  occurrence: number;
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
  const anchors = new Map<string, Anchor>();
  const seen = new Map<string, number>();
  for (const entry of projection.entries) {
    for (const message of entry.messages) {
      const key = messageKey(message);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const last = entry.messages.at(-1);
    if (last) {
      anchors.set(entry.sourceEntry.id, {
        message: last,
        occurrence: (seen.get(messageKey(last)) ?? 1) - 1,
      });
    }
  }
  const inserts = new Map<number, ContextMessage[]>();
  for (const record of records) {
    const anchor = anchors.get(record.anchorEntryId);
    const matches = anchor
      ? messages.flatMap((message, index) => (sameMessage(message, anchor.message) ? [index] : []))
      : [];
    // Several messages can share a role and millisecond. Take the anchor's own occurrence.
    const index = anchor ? (matches[anchor.occurrence] ?? matches.at(-1) ?? -1) : -1;
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

function assertSoleCall(ctx: ExtensionContext, toolCallId: string): void {
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
}

export function compactAssistant(pi: ExtensionAPI, options: CompactAssistantOptions = {}): void {
  requirePiVersion("pi-compact-assistant");
  const settingsDirectory = options.settingsDirectory ?? getAgentDir;
  let settings: Settings | undefined;
  let codexCompatProblem: string | undefined;
  let pending: Request | undefined;
  const reported = new Set<string>();
  pi.registerEntryRenderer(INSTRUCTION_TYPE, renderInstruction);

  function report(ctx: ExtensionContext, key: string, message: string): void {
    if (reported.has(key)) return;
    reported.add(key);
    if (ctx.hasUI) ctx.ui.notify(message, "error");
  }

  /**
   * Whether the model is unsupported or disabled. Without valid settings the extension is
   * inactive, so every model counts as disabled.
   */
  function excluded(model: ExtensionContext["model"]): boolean {
    if (!settings || !model) return true;
    if (unsupportedReason(model, codexCompatProblem)) return true;
    return isDisabled(settings, `${model.provider}/${model.id}`);
  }

  /** Declare `compact` only to supported models the settings enable. */
  function showTool(model: ExtensionContext["model"]): void {
    const active = pi.getActiveTools();
    const shown = active.includes(COMPACT_TOOL_NAME);
    if (excluded(model)) {
      if (shown) pi.setActiveTools(active.filter((name) => name !== COMPACT_TOOL_NAME));
    } else if (!shown) {
      pi.setActiveTools([...active, COMPACT_TOOL_NAME]);
    }
  }

  function showHeld(request: Request, ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(
      HELD_WIDGET,
      request.held.length > 0
        ? request.held.map((input) => `Held until compaction finishes: ${preview(input.text)}`)
        : undefined,
    );
  }

  /**
   * Deliver each held input as its own user message. Call it after the continuation or notice is
   * sent, so the held messages follow it in Pi's steering queue.
   */
  function releaseHeld(request: Request, ctx: ExtensionContext): void {
    const held = request.held.splice(0);
    showHeld(request, ctx);
    for (const input of held) {
      pi.sendUserMessage(
        input.images.length > 0
          ? [{ type: "text", text: input.text }, ...input.images]
          : input.text,
        { deliverAs: "steer", expandPromptTemplates: true },
      );
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
      // With held input the notice starts the next turn and the input follows it. Otherwise the
      // notice waits for the next prompt.
      { triggerTurn: request.held.length > 0, deliverAs: "steer" },
    );
    if (ctx.hasUI) ctx.ui.notify(`Compaction stopped: ${reason}`, "error");
    releaseHeld(request, ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    pending = undefined;
    reported.clear();
    if (ctx.hasUI) ctx.ui.setWidget(HELD_WIDGET, undefined);
    try {
      settings = await loadSettings(settingsDirectory());
    } catch (error) {
      settings = undefined;
      report(ctx, "settings", `pi-compact-assistant is inactive. ${errorText(error)}`);
    }
    codexCompatProblem = await findCodexCompatProblem(pi);
    showTool(ctx.model);
  });
  pi.on("session_shutdown", () => {
    pending = undefined;
  });
  pi.on("session_tree", (_event, ctx) => {
    // Pi restores the tool loadout the branch declared, which may predate a model switch.
    showTool(ctx.model);
  });
  pi.on("model_select", (event) => {
    showTool(event.model);
  });
  // Input that arrives after the run ends would start a run before the continuation, so it
  // waits until compaction finishes, then follows the continuation. Input during the run reaches
  // the model as usual, before compaction.
  pi.on("input", (event, ctx) => {
    const request = pending;
    if (!request?.dispatched) return undefined;
    request.held.push({ text: event.text, images: event.images ?? [] });
    showHeld(request, ctx);
    return { action: "handled" as const };
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
    // Unsupported models get no instructions, including ones recorded under another model.
    const unsupported = unsupportedReason(model, codexCompatProblem);
    if (unsupported) {
      // Models covered only by the default stay quiet; explicit entries and old compat do not.
      if (
        thresholds &&
        (Object.hasOwn(settings.models, key) || unsupported === codexCompatProblem)
      ) {
        report(ctx, `support:${key}`, `pi-compact-assistant skips ${key}. ${unsupported}`);
      }
      return undefined;
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
        // Without a preparation instruction in this cycle, the compaction instruction stands alone.
        text: instructionText(stage === "compact" && !recorded.has("prepare") ? "combined" : stage),
        model: key,
        tokens: usage.tokens,
        contextWindow: usage.contextWindow,
        timestamp: Date.now(),
      };
      pi.appendEntry(INSTRUCTION_TYPE, record);
      records.push(record);
      // The TUI draws the entry in the transcript. RPC clients get a notice instead.
      if (ctx.hasUI && ctx.mode !== "tui") {
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

  pi.on("agent_settled", async (event, ctx) => {
    const request = pending;
    if (!request || request.dispatched) return;
    if (event.aborted) {
      stop(request, ctx, new Error("The run was aborted."));
      return;
    }
    if (!ctx.isIdle()) return;
    request.dispatched = true;
    const compaction = compact(request, ctx);
    // Print and JSON hosts exit once the prompt settles, so they wait here. Pi defers the
    // continuation sent from this handler and runs it before the prompt returns. A UI host does
    // not wait: Pi would also defer the input its editor queued during compaction, and that input
    // would run as its own turn before the continuation.
    if (!ctx.hasUI) await compaction;
  });

  /** Compact, then send the continuation. Failures cancel the request with a notice. */
  async function compact(request: Request, ctx: ExtensionContext): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        ctx.compact({
          ...(request.instructions ? { customInstructions: request.instructions } : {}),
          onComplete: () => {
            resolve();
          },
          onError: reject,
        });
      });
    } catch (error) {
      stop(request, ctx, error);
      return;
    }
    pending = undefined;
    // The continuation starts the next turn, or steers a run another extension started.
    // Queued and held messages follow it as separate messages.
    pi.sendMessage(
      {
        customType: CONTINUATION_TYPE,
        content: continuationText(request.message),
        display: true,
        details: { requestId: request.id },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
    releaseHeld(request, ctx);
  }

  pi.registerTool({
    name: COMPACT_TOOL_NAME,
    label: "Compact context",
    description:
      "Compact the conversation, then continue from your message. Call this tool when a `[Compaction required]` instruction asks for it or when the user asks you to compact. First record the state in a Markdown state file. Then call this tool as the only tool call in its response. The call ends your current turn. Compaction runs when the agent run ends. Messages that arrive before then are delivered to you first. After compaction succeeds, your message is delivered and starts your next turn. The tool result only confirms that the request was accepted.",
    promptSnippet: "Compact the conversation and continue from a Markdown state file",
    promptGuidelines: [
      `Call ${COMPACT_TOOL_NAME} only when a \`[Compaction required]\` instruction asks for it or when the user asks you to compact. Make it the only tool call in its response.`,
      `Before calling ${COMPACT_TOOL_NAME}, record the state in a Markdown state file if you can and may write files. In \`message\`, give the state file's absolute path and the exact next step.`,
      `If compaction fails or is cancelled, check the reason and any newer user input before you try again. Do not repeat an unchanged request. After a summarizer refusal, omit or revise \`instructions\`.`,
      `\`[Compaction preparation]\` and \`[Compaction required]\` are system messages from pi-compact-assistant. ${COMPACT_TOOL_NAME} changes only conversation context. It never changes files, processes, or permissions.`,
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
      if (pending)
        throw new Error("A compaction request is already pending. It runs when this run ends.");
      assertSoleCall(ctx, toolCallId);
      const request: Request = {
        id: randomUUID(),
        message: input.message,
        instructions: input.instructions?.trim() || undefined,
        dispatched: false,
        held: [],
      };
      pending = request;
      return Promise.resolve({
        content: [
          {
            type: "text" as const,
            text: "Compaction accepted. It runs when this run ends. If messages arrive first, handle them as usual and keep the state file current. Your message is delivered after compaction succeeds.",
          },
        ],
        details: { requestId: request.id, phase: "accepted" },
        terminate: true,
      });
    },
  });
}
