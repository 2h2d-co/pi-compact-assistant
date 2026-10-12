import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  type FauxResponseFactory,
  type Message,
} from "@earendil-works/pi-ai";
import {
  CONTINUATION_TYPE,
  INSTRUCTION_TYPE,
  NOTICE_TYPE,
  activeInstructions,
} from "../src/extension.ts";
import { SYSTEM_INSTRUCTIONS, filler, testRuntime, waitUntil } from "./runtime.ts";

const SETTINGS = { default: { prepareAt: 3000, compactAt: 20000 } };

function text(message: Message): string {
  if (message.role === "assistant") {
    return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  }
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** Later system messages (index > 0) with their preceding message's text. */
function laterSystemMessages(messages: readonly Message[]) {
  return messages.flatMap((message, index) => {
    const previous = messages[index - 1];
    return previous && message.role === "system"
      ? [{ text: text(message), after: text(previous).slice(0, 30) }]
      : [];
  });
}

test("records each stage once and keeps its system message at a fixed position", async () => {
  const { runtime, faux, errors } = await testRuntime(SETTINGS);
  try {
    const seen: Message[][] = [];
    const record: FauxResponseFactory = (context) => {
      seen.push(context.messages);
      return fauxAssistantMessage("ok");
    };
    faux.setResponses([record, record, record, record]);
    await runtime.session.prompt("first small request");
    await runtime.session.prompt(`second request ${filler(3500)}`);
    await runtime.session.prompt("third small request");
    await runtime.session.prompt(`fourth request ${filler(20000)}`);

    assert.deepEqual(laterSystemMessages(seen[0] ?? []), []);
    const second = laterSystemMessages(seen[1] ?? []);
    assert.equal(second.length, 1);
    assert.match(second[0]?.text ?? "", /^\[Compaction preparation\]/);
    assert.match(second[0]?.after ?? "", /^second request/);
    // The prepare instruction stays directly after the message it was anchored to.
    assert.deepEqual(laterSystemMessages(seen[2] ?? []), second);
    const fourth = laterSystemMessages(seen[3] ?? []);
    assert.equal(fourth.length, 2);
    assert.deepEqual(fourth[0], second[0]);
    assert.match(fourth[1]?.text ?? "", /^\[Compaction required\]/);
    assert.match(fourth[1]?.text ?? "", /call the `compact` tool alone/);
    assert.match(fourth[1]?.after ?? "", /^fourth request/);
    // The serialized bytes of an earlier request prefix remain unchanged.
    const prefix = seen[2]?.length ?? 0;
    assert.equal(JSON.stringify(seen[3]?.slice(0, prefix)), JSON.stringify(seen[2]));

    const records = runtime.session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === INSTRUCTION_TYPE);
    assert.equal(records.length, 2);
    // Instructions are request-local: the stored transcript and prompt do not contain them.
    assert.doesNotMatch(
      JSON.stringify(runtime.session.sessionManager.buildSessionProjection().messages),
      /\[Compaction preparation\]\\n|\[Compaction required\]\\n/,
    );
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("a single jump past both thresholds records only the compaction instruction", async () => {
  const { runtime, faux, errors } = await testRuntime(SETTINGS);
  try {
    let messages: Message[] = [];
    faux.setResponses([
      (context) => {
        messages = context.messages;
        return fauxAssistantMessage("ok");
      },
    ]);
    await runtime.session.prompt(`large request ${filler(21000)}`);
    const later = laterSystemMessages(messages);
    assert.equal(later.length, 1);
    assert.match(later[0]?.text ?? "", /^\[Compaction required\]/);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("instructions are evaluated between tool calls within one run", async () => {
  const { runtime, faux, errors } = await testRuntime(SETTINGS, (pi) => {
    pi.registerTool({
      name: "read_large",
      label: "Read large",
      description: "Return a large result",
      parameters: Type.Object({}),
      execute: () =>
        Promise.resolve({
          content: [{ type: "text", text: `large result ${filler(3500)}` }],
          details: undefined,
        }),
    });
  });
  try {
    let messages: Message[] = [];
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_large", {})),
      (context) => {
        messages = context.messages;
        return fauxAssistantMessage("done");
      },
    ]);
    await runtime.session.prompt("read it");
    const later = laterSystemMessages(messages);
    assert.equal(later.length, 1);
    assert.match(later[0]?.text ?? "", /^\[Compaction preparation\]/);
    assert.match(later[0]?.after ?? "", /^large result/);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("the compact tool compacts, then delivers its message and resumes", async () => {
  const { runtime, faux, errors } = await testRuntime(SETTINGS);
  try {
    faux.setResponses([fauxAssistantMessage("ok")]);
    await runtime.session.prompt(`large request ${filler(21000)}`);
    let summaryRequest = "";
    let resumed: Message[] = [];
    let resumedPrompt = "";
    const resume: FauxResponseFactory = (context) => {
      const serialized = JSON.stringify(context.messages);
      if (!serialized.includes("Agent-authored continuation after compaction")) {
        summaryRequest = serialized;
        faux.appendResponses([resume]);
        return fauxAssistantMessage("Summary: the large request was handled.");
      }
      resumed = context.messages;
      resumedPrompt = getCurrentSystemPrompt(context.messages);
      return fauxAssistantMessage("Continued after compaction");
    };
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("compact", {
          message: "Next step: run the validation suite. Do not change the schema.",
          instructions: "Preserve the schema restriction.",
        }),
      ),
      resume,
    ]);
    await runtime.session.prompt(`continue ${filler(300)}`);
    await waitUntil(() =>
      runtime.session.messages.some(
        (message) => message.role === "assistant" && text(message) === "Continued after compaction",
      ),
    );
    await runtime.session.waitForIdle();

    assert.match(summaryRequest, /Preserve the schema restriction/);
    const branch = runtime.session.sessionManager.getBranch();
    const compaction = branch.findIndex((entry) => entry.type === "compaction");
    const continuation = branch.findIndex(
      (entry) => entry.type === "custom_message" && entry.customType === CONTINUATION_TYPE,
    );
    assert.ok(compaction >= 0 && compaction < continuation);
    assert.match(JSON.stringify(resumed), /Do not change the schema/);
    assert.match(JSON.stringify(resumed), /not a new user request or additional authorization/);
    assert.deepEqual(laterSystemMessages(resumed), []);
    assert.deepEqual(activeInstructions(branch), []);
    assert.match(resumedPrompt, new RegExp(SYSTEM_INSTRUCTIONS));
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("the compact tool must be the only tool call", async () => {
  const { runtime, faux, errors } = await testRuntime(SETTINGS);
  try {
    let results = "";
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("compact", { message: "Continue" }),
        fauxToolCall("compact", { message: "Continue again" }),
      ]),
      (context) => {
        results = JSON.stringify(context.messages.filter((m) => m.role === "toolResult"));
        return fauxAssistantMessage("Understood");
      },
    ]);
    await runtime.session.prompt("compact");
    await runtime.session.waitForIdle();
    assert.match(results, /Call compact alone/);
    assert.equal(
      runtime.session.sessionManager.getBranch().some((entry) => entry.type === "compaction"),
      false,
    );
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("an aborted run cancels the accepted request and tells the model", async () => {
  const { runtime, faux, errors } = await testRuntime(SETTINGS, (pi) => {
    pi.on("tool_execution_end", (_event, ctx) => {
      ctx.abort();
    });
  });
  try {
    faux.setResponses([fauxAssistantMessage(fauxToolCall("compact", { message: "Continue" }))]);
    await runtime.session.prompt("compact");
    await runtime.session.waitForIdle();
    const branch = runtime.session.sessionManager.getBranch();
    assert.equal(
      branch.some((entry) => entry.type === "compaction"),
      false,
    );
    const notice = branch.find(
      (entry) => entry.type === "custom_message" && entry.customType === NOTICE_TYPE,
    );
    assert.ok(notice);
    assert.match(JSON.stringify(notice), /The run was aborted/);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("models set to false and invalid settings leave requests unchanged", async () => {
  for (const settings of [
    { default: false },
    { models: { "faux/faux-1": false } },
    { default: { prepareAt: 6000, compactAt: 3000 } },
    { default: { prepareAt: "bad", compactAt: 3000 } },
  ]) {
    const { runtime, faux, errors } = await testRuntime(settings);
    try {
      let messages: Message[] = [];
      faux.setResponses([
        (context) => {
          messages = context.messages;
          return fauxAssistantMessage("ok");
        },
      ]);
      await runtime.session.prompt(`large request ${filler(21000)}`);
      assert.deepEqual(laterSystemMessages(messages), [], JSON.stringify(settings));
      assert.deepEqual(errors, []);
    } finally {
      await runtime.dispose();
    }
  }
});
