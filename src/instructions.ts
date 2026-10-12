export const COMPACT_TOOL_NAME = "compact";

export type Stage = "prepare" | "compact";

export interface Usage {
  tokens: number;
  contextWindow: number;
}

export interface StageThresholds {
  prepareTokens: number;
  compactTokens: number;
}

function amount(tokens: number): string {
  return tokens.toLocaleString("en-US");
}

function usageText(usage: Usage): string {
  const percent = ((usage.tokens / usage.contextWindow) * 100).toFixed(1);
  return `Context usage is about ${amount(usage.tokens)} of ${amount(usage.contextWindow)} tokens (${percent}%).`;
}

/** The highest stage whose threshold the usage has reached. */
export function reachedStage(tokens: number, thresholds: StageThresholds): Stage | undefined {
  if (tokens >= thresholds.compactTokens) return "compact";
  if (tokens >= thresholds.prepareTokens) return "prepare";
  return undefined;
}

/** Render the instruction text. It is fixed when the stage is recorded so requests stay stable. */
export function instructionText(stage: Stage, usage: Usage, thresholds: StageThresholds): string {
  if (stage === "prepare") {
    return [
      "[Compaction preparation]",
      `${usageText(usage)} The conversation will be compacted at about ${amount(thresholds.compactTokens)} tokens. A later instruction will ask you to call the \`${COMPACT_TOOL_NAME}\` tool.`,
      "Prepare now:",
      "- Bring the current step to a stable point. Avoid starting large new explorations.",
      "- Keep track of what the continuation will need: the user's goal and active constraints, decisions, changed files, validation results, running processes, and the next step.",
      `Do not call \`${COMPACT_TOOL_NAME}\` yet.`,
    ].join("\n");
  }
  return [
    "[Compaction required]",
    `${usageText(usage)} This reached the compaction threshold of ${amount(thresholds.compactTokens)} tokens.`,
    `At the first suitable moment, call the \`${COMPACT_TOOL_NAME}\` tool alone: after your in-progress tool calls return, and before you start new work. Do not wait for the user.`,
    "- `message` (required) is delivered to you after compaction and starts your next turn. Make it self-contained: the user's goal and active constraints, completed work, validation results, running processes, and the exact next step.",
    "- `instructions` (optional) tells the summarizer what to preserve.",
    "Compaction replaces earlier conversation with a summary. It does not change files, processes, or permissions.",
  ].join("\n");
}

/** The custom message that resumes the agent after compaction. */
export function continuationText(message: string): string {
  return [
    "[Agent-authored continuation after compaction]",
    message,
    "",
    "You wrote this message before compaction. It is not a new user request or additional authorization.",
  ].join("\n");
}
