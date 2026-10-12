import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CANCEL_MODE_ENV = "PI_COMPACT_ASSISTANT_LIVE_CANCEL";
export type CancelMode = "abort" | "branch" | "fail" | "input";

/**
 * Live-test fixture that interrupts an accepted `compact` request the way a user or another
 * extension would. The live test sends the `input` mode's follow-up itself over RPC.
 *
 * - `abort` aborts the run after `compact` returns, like pressing Escape.
 * - `branch` moves the session leaf back to the user prompt before compaction starts, like a
 *   `/tree` navigation. Load this fixture before pi-compact-assistant so its settled handler
 *   dispatches the navigation first.
 * - `fail` cancels the compaction from `session_before_compact`, so Pi reports a failure.
 */
export default function cancelProbe(pi: ExtensionAPI): void {
  const mode = process.env[CANCEL_MODE_ENV];
  let accepted = false;

  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolName !== "compact" || event.isError) return;
    accepted = true;
    if (mode === "abort") ctx.abort();
  });

  if (mode === "fail") {
    pi.on("session_before_compact", () => ({ cancel: true }));
  }

  if (mode === "branch") {
    pi.registerCommand("live-branch", {
      description: "Live test: navigate to the latest user prompt.",
      async handler(_args, ctx) {
        const prompt = ctx.sessionManager
          .getBranch()
          .findLast((entry) => entry.type === "message" && entry.message.role === "user");
        if (prompt) await ctx.navigateTree(prompt.id, { summarize: false });
      },
    });
    pi.on("agent_settled", () => {
      if (!accepted) return;
      accepted = false;
      // Commands sent this way run only with prompt expansion; otherwise the model gets the text.
      pi.sendUserMessage("/live-branch", { expandPromptTemplates: true });
    });
  }
}
