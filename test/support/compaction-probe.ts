import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const HOLD_DIR_ENV = "PI_COMPACT_ASSISTANT_LIVE_HOLD_DIR";
/** Written when compaction starts. */
export const STARTED_FILE = "compaction-started";
/** Written by the test once the input it typed is queued. Compaction continues then. */
export const TYPED_FILE = "input-typed";

/**
 * Live-test fixture that keeps compaction running until the test has typed its input, so the
 * input is submitted during compaction rather than racing it.
 */
export default function compactionProbe(pi: ExtensionAPI): void {
  const directory = process.env[HOLD_DIR_ENV];
  if (!directory) return;
  pi.on("session_before_compact", async () => {
    writeFileSync(join(directory, STARTED_FILE), "");
    for (let attempt = 0; attempt < 600 && !existsSync(join(directory, TYPED_FILE)); attempt++) {
      await setTimeout(100);
    }
  });
}
