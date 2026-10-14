import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CANCEL_MODE_ENV = "PI_COMPACT_ASSISTANT_LIVE_CANCEL";
export type CancelMode = "abort" | "fail";

/**
 * Live-test fixture that interrupts an accepted `compact` request the way a user or another
 * extension would.
 *
 * - `abort` aborts the run after `compact` returns, like pressing Escape.
 * - `fail` cancels the compaction from `session_before_compact`, so Pi reports a failure.
 */
export default function cancelProbe(pi: ExtensionAPI): void {
  const mode = process.env[CANCEL_MODE_ENV];

  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolName !== "compact" || event.isError) return;
    if (mode === "abort") ctx.abort();
  });

  if (mode === "fail") {
    pi.on("session_before_compact", () => ({ cancel: true }));
  }
}
