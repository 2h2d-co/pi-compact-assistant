import assert from "node:assert/strict";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { runPrintMode } from "@earendil-works/pi-coding-agent";
import { CONTINUATION_TYPE } from "../src/extension.ts";
import { filler, testRuntime } from "./runtime.ts";

// Loads the packaged entry, which reads pi-compact-assistant.json from PI_CODING_AGENT_DIR.
const outputMode = process.argv[2] === "json" ? "json" : "text";
const { runtime, faux } = await testRuntime(
  { default: { prepareAt: 3000, compactAt: 20000 } },
  undefined,
  "print",
  true,
);
let instructed = false;
faux.setResponses([
  (context) => {
    instructed = JSON.stringify(context.messages).includes("[Compaction required]");
    return fauxAssistantMessage("Large request handled.");
  },
]);
await runtime.session.prompt(`large request ${filler(21000)}`);
assert.ok(instructed);
const resume: FauxResponseFactory = (context) => {
  if (!JSON.stringify(context.messages).includes("Agent-authored continuation after compaction")) {
    faux.appendResponses([resume]);
    return fauxAssistantMessage("Compaction summary");
  }
  return fauxAssistantMessage("print-compaction-completed");
};
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("compact", { message: "Continue the plan" })),
  resume,
]);
const code = await runPrintMode(runtime, {
  mode: outputMode,
  initialMessage: `Compact now ${filler(300)}`,
});
assert.equal(code, 0);
const branch = runtime.session.sessionManager.getBranch();
assert.equal(branch.filter((entry) => entry.type === "compaction").length, 1);
assert.equal(
  branch.filter(
    (entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE,
  ).length,
  1,
);
assert.equal(faux.getPendingResponseCount(), 0);
assert.equal(runtime.session.messages.at(-1)?.role, "assistant");
