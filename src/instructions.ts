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

/** Render the instruction text. It is fixed when the stage is recorded so requests stay stable. */
export function instructionText(stage: Stage): string {
  if (stage === "prepare") {
    return [
      "[Compaction preparation]",
      `The conversation will be compacted soon. A later \`[Compaction required]\` instruction will ask you to call the \`${COMPACT_TOOL_NAME}\` tool.`,
      "Keep working. Do not stop or wrap up early: work continues after compaction as long as its state is recorded.",
      "Record the state in a Markdown file now and keep it current as you work: the user's goal and active constraints, decisions, changed files, validation results, running processes, and the next step. Use the Markdown file that already tracks this work, or create one.",
      `Do not call \`${COMPACT_TOOL_NAME}\` yet.`,
    ].join("\n");
  }
  return [
    "[Compaction required]",
    `At the first suitable moment, after your in-progress tool calls return and before you start new work, update the Markdown file that tracks this work so it records the current state. Then call the \`${COMPACT_TOOL_NAME}\` tool alone. Do not wait for the user.`,
    "- `message` (required) is delivered to you after compaction and starts your next turn. Give the path of that Markdown file and the exact next step. The file holds the rest of the state.",
    "- `instructions` (optional) tells the summarizer which parts of the conversation to preserve or emphasize. Do not add facts that are not in the conversation.",
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
