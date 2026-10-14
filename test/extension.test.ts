import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  type FauxResponseFactory,
  type Message,
} from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionFactory, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  CONTINUATION_TYPE,
  HELD_WIDGET,
  INSTRUCTION_TYPE,
  NOTICE_TYPE,
  activeInstructions,
} from "../src/extension.ts";
import {
  FOLDING_MODEL_ID,
  SYSTEM_INSTRUCTIONS,
  filler,
  testRuntime,
  waitUntil,
  type RuntimeOptions,
} from "./runtime.ts";

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
    assert.match(
      fourth[1]?.text ?? "",
      /call `compact`\. Make it the only tool call in its response/,
    );
    // After a preparation instruction, the compaction instruction refers to its state file.
    assert.match(fourth[1]?.text ?? "", /Update the state file so it records the current state/);
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

test("messages that share a timestamp keep the instruction at its anchor", async (t) => {
  // Every message gets the same millisecond, as fast or queued messages can.
  t.mock.method(Date, "now", () => 1_791_000_000_000);
  const { runtime, faux, errors } = await testRuntime({ default: { compactAt: 20000 } });
  try {
    const seen: Message[][] = [];
    const record: FauxResponseFactory = (context) => {
      seen.push(context.messages);
      return fauxAssistantMessage("ok");
    };
    faux.setResponses([record, record, record, record]);
    await runtime.session.prompt("first small request");
    await runtime.session.prompt(`second request ${filler(20000)}`);
    await runtime.session.prompt("third small request");
    await runtime.session.prompt("fourth small request");
    const second = laterSystemMessages(seen[1] ?? []);
    assert.equal(second.length, 1);
    assert.match(second[0]?.after ?? "", /^second request/);
    assert.deepEqual(laterSystemMessages(seen[2] ?? []), second);
    assert.deepEqual(laterSystemMessages(seen[3] ?? []), second);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("a single jump past both thresholds records one self-contained compaction instruction", async () => {
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
    // No preparation instruction was posted, so this one asks for the state file itself.
    assert.match(later[0]?.text ?? "", /Record the current state in a Markdown state file/);
    const records = runtime.session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === INSTRUCTION_TYPE);
    assert.equal(records.length, 1);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("without prepareAt, only the self-contained compaction instruction is posted", async () => {
  const { runtime, faux, errors } = await testRuntime({ default: { compactAt: 20000 } });
  try {
    const seen: Message[][] = [];
    const record: FauxResponseFactory = (context) => {
      seen.push(context.messages);
      return fauxAssistantMessage("ok");
    };
    faux.setResponses([record, record, record]);
    await runtime.session.prompt(`first request ${filler(3500)}`);
    await runtime.session.prompt(`second request ${filler(20000)}`);
    await runtime.session.prompt("third small request");

    assert.deepEqual(laterSystemMessages(seen[0] ?? []), []);
    const second = laterSystemMessages(seen[1] ?? []);
    assert.equal(second.length, 1);
    assert.match(second[0]?.text ?? "", /^\[Compaction required\]/);
    assert.match(second[0]?.text ?? "", /Record the current state in a Markdown state file/);
    assert.deepEqual(laterSystemMessages(seen[2] ?? []), second);
    const records = runtime.session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === INSTRUCTION_TYPE);
    assert.equal(records.length, 1);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

/** Later system messages in one request that passes the compaction threshold. */
async function instructionsAfterLargeRequest(
  options: Parameters<typeof testRuntime>[4],
  settings: unknown = SETTINGS,
): Promise<string[]> {
  const { runtime, faux, errors } = await testRuntime(settings, undefined, "print", false, options);
  try {
    let messages: Message[] = [];
    faux.setResponses([
      (context) => {
        messages = context.messages;
        return fauxAssistantMessage("ok");
      },
    ]);
    await runtime.session.prompt(`large request ${filler(21000)}`);
    assert.deepEqual(errors, []);
    return laterSystemMessages(messages).map((message) => message.text);
  } finally {
    await runtime.dispose();
  }
}

/** A stand-in pi-openai-codex-compat package at `version` that registers its settings command. */
async function codexCompatPackage(version: string): Promise<{ entry: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-compact-assistant-codex-compat-"));
  const packageRoot = join(root, "node_modules", "pi-openai-codex-compat");
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "pi-openai-codex-compat", version }),
  );
  const entry = join(packageRoot, "extensions", "index.ts");
  await writeFile(
    entry,
    'export default function (pi) { pi.registerCommand("codex-settings", { description: "Codex settings", handler() {} }); }\n',
  );
  return { entry, root };
}

test("only supported providers and models receive instructions", async () => {
  assert.equal((await instructionsAfterLargeRequest({})).length, 1);
  assert.equal((await instructionsAfterLargeRequest({ provider: "openai-codex" })).length, 1);
  // Another provider, even with an explicit entry, and a model that would fold system messages.
  assert.deepEqual(
    await instructionsAfterLargeRequest(
      { provider: "opencode" },
      { models: { "opencode/faux-1": { compactAt: 20000 } } },
    ),
    [],
  );
  assert.deepEqual(await instructionsAfterLargeRequest({ midConversation: false }), []);
});

test("compact is declared only to supported models the settings enable", async () => {
  const declared = async (settings: unknown, options: RuntimeOptions = {}) => {
    const { runtime, errors } = await testRuntime(settings, undefined, "print", false, options);
    try {
      assert.deepEqual(errors, []);
      return runtime.session.getActiveToolNames().includes("compact");
    } finally {
      await runtime.dispose();
    }
  };
  assert.equal(await declared(SETTINGS), true);
  // Unsupported models.
  assert.equal(await declared(SETTINGS, { provider: "opencode" }), false);
  assert.equal(await declared(SETTINGS, { midConversation: false }), false);
  // Disabled models, including an invalid settings file, which disables every model.
  assert.equal(await declared({ default: false }), false);
  assert.equal(await declared({ models: { "anthropic/faux-1": false } }), false);
  assert.equal(await declared({ enabled: false }), false);
  assert.equal(await declared({ default: "bad" }), false);
});

test("switching models hides compact and declares it again", async () => {
  const { runtime, faux, errors } = await testRuntime(SETTINGS);
  try {
    const declared = () => runtime.session.getActiveToolNames().includes("compact");
    assert.equal(declared(), true);
    const folding = faux.getModel(FOLDING_MODEL_ID);
    assert.ok(folding);
    await runtime.session.setModel(folding);
    assert.equal(declared(), false);
    await runtime.session.setModel(faux.getModel());
    assert.equal(declared(), true);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("Codex models require pi-openai-codex-compat 0.0.23 or later when it is loaded", async () => {
  for (const [version, expected] of [
    ["0.0.22", 0],
    ["0.0.23-alpha.1", 0],
    ["0.0.23", 1],
    ["0.1.0", 1],
  ] as const) {
    const compat = await codexCompatPackage(version);
    try {
      const codex = await instructionsAfterLargeRequest({
        provider: "openai-codex",
        extensionPaths: [compat.entry],
      });
      assert.equal(codex.length, expected, version);
      // Anthropic models do not depend on the Codex extension.
      const anthropic = await instructionsAfterLargeRequest({ extensionPaths: [compat.entry] });
      assert.equal(anthropic.length, 1, version);
    } finally {
      await rm(compat.root, { recursive: true, force: true });
    }
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
    assert.match(
      JSON.stringify(resumed),
      /not a new user request and grants no additional authorization/,
    );
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

const HELD = "newer input";

/** A user message's text, or a custom message's type, for checking session order. */
function label(entry: SessionEntry): string | undefined {
  if (entry.type === "compaction") return "compaction";
  if (entry.type === "custom_message") return entry.customType;
  if (entry.type === "message" && entry.message.role === "user")
    return `user:${text(entry.message)}`;
  if (entry.type === "message" && entry.message.role === "assistant") {
    return `assistant:${text(entry.message)}`;
  }
  return undefined;
}

/**
 * The session order and notices after a user-requested compact call that `interrupt` disturbs.
 * The model answers `READY` to every request except summaries.
 */
async function interruptedRequest(
  interrupt: (pi: Parameters<ExtensionFactory>[0], session: () => AgentSession) => void,
  { ui = false, settle = "notice" }: { ui?: boolean; settle?: "notice" | "continuation" } = {},
) {
  let current: (() => AgentSession) | undefined;
  // A threshold the test never reaches keeps compact declared without instructions.
  const runtime = await testRuntime(
    { default: { compactAt: "99%" } },
    (pi) => {
      interrupt(pi, () => {
        assert.ok(current);
        return current();
      });
    },
    "print",
    false,
    { ui },
  );
  const { faux, errors } = runtime;
  const session = () => runtime.runtime.session;
  current = session;
  try {
    faux.setResponses([fauxAssistantMessage("ok")]);
    await session().prompt(`earlier request ${filler(21000)}`);
    const respond: FauxResponseFactory = (context) => {
      faux.appendResponses([respond]);
      return getCurrentSystemPrompt(context.messages).includes(SYSTEM_INSTRUCTIONS)
        ? fauxAssistantMessage("READY")
        : fauxAssistantMessage("Summary: the earlier request was handled.");
    };
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("compact", { message: "Continue" })),
      respond,
    ]);
    await session().prompt(`compact now ${filler(300)}`);
    const custom = (type: string) =>
      session()
        .sessionManager.getEntries()
        .filter((entry) => entry.type === "custom_message" && entry.customType === type);
    await waitUntil(() => custom(settle === "notice" ? NOTICE_TYPE : CONTINUATION_TYPE).length > 0);
    await session().waitForIdle();
    const entries = session().sessionManager.getBranch();
    assert.deepEqual(errors, []);
    return {
      notices: custom(NOTICE_TYPE).map((entry) =>
        JSON.stringify(entry.type === "custom_message" && entry.content),
      ),
      /** Compactions, custom messages, user messages, and replies after the compact call. */
      order: entries
        .slice(entries.findIndex((entry) => label(entry) === "assistant:") + 1)
        .flatMap((entry) => label(entry) ?? []),
      compacted: session()
        .sessionManager.getEntries()
        .some((entry) => entry.type === "compaction"),
      continued: custom(CONTINUATION_TYPE).length > 0,
      shown: runtime.ui.shown,
      heldWidget: runtime.ui.widgets.get(HELD_WIDGET),
    };
  } finally {
    await runtime.runtime.dispose();
  }
}

test("a failed compaction cancels the request and tells the model", async () => {
  const result = await interruptedRequest((pi) => {
    pi.on("session_before_compact", () => ({ cancel: true }));
  });
  assert.equal(result.notices.length, 1);
  assert.match(result.notices[0] ?? "", /did not run: Compaction cancelled/);
  assert.deepEqual(result.order, [NOTICE_TYPE]);
});

test("input during the run reaches the model before compaction, which still runs", async () => {
  const result = await interruptedRequest(
    (pi, session) => {
      pi.on("tool_execution_end", async (event) => {
        if (event.toolName === "compact") await session().steer(HELD);
      });
    },
    { ui: true, settle: "continuation" },
  );
  assert.deepEqual(result.notices, []);
  assert.deepEqual(result.order, [
    `user:${HELD}`,
    "assistant:READY",
    "compaction",
    CONTINUATION_TYPE,
    "assistant:READY",
  ]);
  assert.deepEqual(result.shown, []);
});

test("input queued before compact runs no longer blocks the request", async () => {
  const result = await interruptedRequest(
    (pi, session) => {
      pi.on("tool_call", async (event) => {
        if (event.toolName === "compact") await session().steer(HELD);
      });
    },
    { settle: "continuation" },
  );
  assert.deepEqual(result.notices, []);
  assert.deepEqual(result.order, [
    `user:${HELD}`,
    "assistant:READY",
    "compaction",
    CONTINUATION_TYPE,
    "assistant:READY",
  ]);
});

test("an extension message during the run no longer cancels the request", async () => {
  const result = await interruptedRequest(
    (pi) => {
      pi.on("tool_execution_end", (event) => {
        if (event.toolName !== "compact") return;
        pi.sendMessage(
          { customType: "test-note", content: "extension note", display: true },
          { triggerTurn: true, deliverAs: "steer" },
        );
      });
    },
    { settle: "continuation" },
  );
  assert.deepEqual(result.notices, []);
  assert.deepEqual(result.order, [
    "test-note",
    "assistant:READY",
    "compaction",
    CONTINUATION_TYPE,
    "assistant:READY",
  ]);
});

test("input during compaction follows the continuation as its own message", async () => {
  const result = await interruptedRequest(
    (pi, session) => {
      pi.on("session_before_compact", async () => {
        await session().followUp(HELD);
      });
    },
    { ui: true, settle: "continuation" },
  );
  assert.deepEqual(result.notices, []);
  // Pi delivers the held message with the continuation or in the next turn.
  assert.deepEqual(
    result.order.filter((item) => !item.startsWith("assistant:")),
    ["compaction", CONTINUATION_TYPE, `user:${HELD}`],
  );
  assert.equal(result.order.at(-1), "assistant:READY");
  assert.deepEqual(result.shown, [`Held until compaction finishes: ${HELD}`]);
  assert.equal(result.heldWidget, undefined);
});

test("held input follows the notice of a failed compaction", async () => {
  const result = await interruptedRequest((pi, session) => {
    pi.on("session_before_compact", async () => {
      await session().followUp(HELD);
      return { cancel: true };
    });
  });
  assert.equal(result.notices.length, 1);
  assert.match(result.notices[0] ?? "", /did not run: Compaction cancelled/);
  assert.deepEqual(
    result.order.filter((item) => !item.startsWith("assistant:")),
    [NOTICE_TYPE, `user:${HELD}`],
  );
  assert.equal(result.order.at(-1), "assistant:READY");
});

test("a branch change before compaction cancels the request", async () => {
  const result = await interruptedRequest((pi, session) => {
    let navigated = false;
    pi.on("agent_settled", async () => {
      if (navigated) return;
      const prompt = session()
        .sessionManager.getBranch()
        .findLast((entry) => entry.type === "message" && entry.message.role === "user");
      if (!prompt || !JSON.stringify(prompt).includes("compact now")) return;
      navigated = true;
      await session().navigateTree(prompt.id, { summarize: false });
    });
  });
  assert.equal(result.notices.length, 1);
  assert.match(result.notices[0] ?? "", /did not run: The session branch changed\./);
  assert.equal(result.compacted, false);
  assert.equal(result.continued, false);
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
