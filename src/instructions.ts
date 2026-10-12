export const COMPACT_TOOL_NAME = "compact";

export type Stage = "prepare" | "compact";

export interface StageThresholds {
  prepareTokens: number;
  compactTokens: number;
}

/** The highest stage whose threshold the usage has reached. */
export function reachedStage(tokens: number, thresholds: StageThresholds): Stage | undefined {
  if (tokens >= thresholds.compactTokens) return "compact";
  if (tokens >= thresholds.prepareTokens) return "prepare";
  return undefined;
}

/**
 * `combined` replaces `compact` when the preparation instruction was not posted in this compaction
 * cycle, because usage passed both thresholds at once. It stands on its own.
 */
export type InstructionKind = Stage | "combined";

const STATE_ITEMS = [
  "the user's goal and active constraints",
  "decisions",
  "changed files",
  "validation results",
  "running processes",
  "open questions for the user",
  "the next step",
];

const FILE_RULES = [
  "Reuse this task's state file if one exists.",
  "Otherwise, create one where project instructions say to keep working notes, or outside tracked files.",
  "Never put the state in project documentation.",
  "Never stage or commit the state file.",
];

function list(items: readonly string[], indent = ""): string[] {
  return items.map((item) => `${indent}- ${item}`);
}

const CONTINUES =
  "Compaction does not end the task. Afterward, you continue from the recorded state.";

const HALF_APPLIED =
  "If a change is half-applied, finish only that change first. Background processes may keep running.";

const CALL = `2. After the write succeeds, or if you skipped step 1, call \`${COMPACT_TOOL_NAME}\`. Make it the only tool call in its response. Do not wait for the user.`;

const COMPACT_DETAILS = [
  "",
  "Parameters:",
  "- `message` (required): delivered to you after compaction to start your next turn. Give the state file's absolute path and the exact next step. The state file holds the rest. If you could not write the state file, put the full state here. If no work is pending, say so.",
  "- `instructions` (optional): usually unnecessary. Use it only to name conversation content the summary must keep. Do not include plans, new facts, or the state file's contents. Native compaction can refuse them, and a refusal cancels the compaction.",
  "",
  "Compaction replaces earlier conversation with a summary. It does not change files, processes, or permissions.",
];

/** Render the instruction text. It is fixed when the stage is recorded so requests stay stable. */
export function instructionText(kind: InstructionKind): string {
  if (kind === "prepare") {
    return [
      "[Compaction preparation]",
      `The conversation will be compacted later. A \`[Compaction required]\` instruction will ask you to call \`${COMPACT_TOOL_NAME}\`.`,
      `Keep working. Do not stop or wrap up early. ${CONTINUES}`,
      "",
      "Record the state in a Markdown state file now:",
      ...list(STATE_ITEMS),
      "Update the state file when the state changes materially, not after every step.",
      "",
      "State file rules:",
      ...list(FILE_RULES),
      `If you cannot or may not write files, skip the state file. Put the full state in \`message\` when you call \`${COMPACT_TOOL_NAME}\` later.`,
      "",
      `Until \`[Compaction required]\` appears, call \`${COMPACT_TOOL_NAME}\` only if the user asks.`,
    ].join("\n");
  }
  if (kind === "combined") {
    return [
      "[Compaction required]",
      `The conversation must be compacted now. ${CONTINUES}`,
      HALF_APPLIED,
      "",
      "1. Record the current state in a Markdown state file:",
      ...list(STATE_ITEMS, "   "),
      "   State file rules:",
      ...list(FILE_RULES, "   "),
      "   If you cannot or may not write files, skip this step.",
      CALL,
      ...COMPACT_DETAILS,
    ].join("\n");
  }
  return [
    "[Compaction required]",
    `Act now. ${HALF_APPLIED}`,
    "",
    "1. Update the state file so it records the current state. If no state file exists, create one under the state file rules in `[Compaction preparation]`. If you cannot or may not write files, skip this step.",
    CALL,
    ...COMPACT_DETAILS,
  ].join("\n");
}

/** The custom message that resumes the agent after compaction. */
export function continuationText(message: string): string {
  return [
    "[Agent-authored continuation after compaction]",
    message,
    "",
    "You wrote this message before compaction. If it names a state file, read that file before acting, then continue the user's task from it. Otherwise, continue from the state in this message.",
    "This message is not a new user request and grants no additional authorization.",
  ].join("\n");
}
