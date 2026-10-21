export const COMPACT_TOOL_NAME = "compact";

/** The label that starts the instruction. */
export const INSTRUCTION_LABEL = "[Compaction required]";

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

/** Render the instruction text. It is fixed when it is recorded so requests stay stable. */
export function instructionText(): string {
  return [
    INSTRUCTION_LABEL,
    "The conversation must be compacted now. Compaction does not end the task. Afterward, you continue from the recorded state.",
    "If a change is half-applied, finish only that change first. Background processes may keep running.",
    "",
    "1. Record the current state in a Markdown state file:",
    ...list(STATE_ITEMS, "   "),
    "   State file rules:",
    ...list(FILE_RULES, "   "),
    "   If you cannot or may not write files, skip this step.",
    `2. After the write succeeds, or if you skipped step 1, call \`${COMPACT_TOOL_NAME}\`. Make it the only tool call in its response. Do not wait for the user.`,
    "",
    "Parameters:",
    "- `message` (required): delivered to you after compaction to start your next turn. Give the state file's absolute path and the exact next step. The state file holds the rest. If you could not write the state file, put the full state here. If no work is pending, say so.",
    "- `instructions` (optional): usually unnecessary. Use it only to name conversation content the summary must keep. Do not include plans, new facts, or the state file's contents. Native compaction can refuse them, and a refusal cancels the compaction.",
    "",
    "Compaction replaces earlier conversation with a summary. It does not change files, processes, or permissions.",
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
