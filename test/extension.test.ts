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
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
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

/** Whether a model request ends with the held user input or the continuation. */
function answersHeldInput(messages: readonly Message[]): boolean {
  const last = messages.at(-1);
  return (
    last !== undefined &&
    (text(last) === HELD || text(last).includes("Agent-authored continuation after compaction"))
  );
}

/**
 * Notices, branch shape, and the model's last request after a user-requested compact call that
 * `interrupt` disturbs. The model answers `READY` to held input or a continuation.
 */
async function interruptedRequest(
  interrupt: (pi: Parameters<ExtensionFactory>[0], session: () => AgentSession) => void,
  { ui = false } = {},
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
    let answered: Message[] | undefined;
    const respond: FauxResponseFactory = (context) => {
      if (!answersHeldInput(context.messages)) {
        return fauxAssistantMessage("Summary: the earlier request was handled.");
      }
      answered = context.messages;
      return fauxAssistantMessage("READY");
    };
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("compact", { message: "Continue" })),
      respond,
      respond,
    ]);
    await session().prompt(`compact now ${filler(300)}`);
    const custom = (type: string) =>
      session()
        .sessionManager.getEntries()
        .filter((entry) => entry.type === "custom_message" && entry.customType === type);
    await waitUntil(
      () => answered !== undefined || (custom(NOTICE_TYPE).length > 0 && session().isIdle),
    );
    await session().waitForIdle();
    const entries = session().sessionManager.getEntries();
    assert.deepEqual(errors, []);
    return {
      notices: custom(NOTICE_TYPE).map((entry) =>
        JSON.stringify(entry.type === "custom_message" && entry.content),
      ),
      compacted: entries.some((entry) => entry.type === "compaction"),
      continued: custom(CONTINUATION_TYPE).length > 0,
      /** The request that answered held input or the continuation. */
      answered: answered?.map((message) => ({ role: message.role, text: text(message) })),
      /** Assistant texts in session order. */
      replies: entries.flatMap((entry) =>
        entry.type === "message" && entry.message.role === "assistant" ? [text(entry.message)] : [],
      ),
      heldWidget: runtime.ui.widgets.get(HELD_WIDGET),
      shown: runtime.ui.shown,
      editorText: runtime.ui.editorText,
    };
  } finally {
    await runtime.runtime.dispose();
  }
}

/** Hold user input right after the compact tool accepts the request. */
function steerAfterAccept(pi: Parameters<ExtensionFactory>[0], session: () => AgentSession) {
  pi.on("tool_execution_end", async (event) => {
    if (event.toolName === "compact") await session().steer(HELD);
  });
}

test("a failed compaction cancels the request and tells the model", async () => {
  const result = await interruptedRequest((pi) => {
    pi.on("session_before_compact", () => ({ cancel: true }));
  });
  assert.equal(result.notices.length, 1);
  assert.match(result.notices[0] ?? "", /did not run: Compaction cancelled/);
  assert.equal(result.compacted, false);
  assert.equal(result.continued, false);
});

test("user input after the compact call waits, then follows the continuation", async () => {
  const result = await interruptedRequest(steerAfterAccept, { ui: true });
  assert.deepEqual(result.notices, []);
  assert.equal(result.compacted, true);
  assert.equal(result.continued, true);
  // The model did not answer the input before compaction, and answered it once afterward.
  assert.deepEqual(result.replies, ["ok", "", "READY"]);
  const [continuation, input] = result.answered?.slice(-2) ?? [];
  assert.match(continuation?.text ?? "", /Agent-authored continuation after compaction/);
  assert.match(continuation?.text ?? "", /Where they conflict, follow the user's message\./);
  assert.deepEqual(input, { role: "user", text: HELD });
  assert.deepEqual(result.shown, [`Held until compaction finishes: ${HELD}`]);
  assert.equal(result.heldWidget, undefined);
});

test("user input during compaction waits, then follows the continuation", async () => {
  const result = await interruptedRequest((pi, session) => {
    pi.on("session_before_compact", async () => {
      await session().followUp(HELD);
    });
  });
  assert.deepEqual(result.notices, []);
  assert.equal(result.compacted, true);
  assert.equal(result.continued, true);
  assert.deepEqual(result.replies, ["ok", "", "READY"]);
  assert.deepEqual(result.answered?.at(-1), { role: "user", text: HELD });
});

test("held input is delivered after a failed compaction's notice", async () => {
  const result = await interruptedRequest((pi, session) => {
    steerAfterAccept(pi, session);
    pi.on("session_before_compact", () => ({ cancel: true }));
  });
  assert.equal(result.notices.length, 1);
  assert.match(result.notices[0] ?? "", /did not run: Compaction cancelled/);
  assert.equal(result.compacted, false);
  assert.equal(result.continued, false);
  const [notice, input] = result.answered?.slice(-2) ?? [];
  assert.match(notice?.text ?? "", /did not run: Compaction cancelled/);
  assert.deepEqual(input, { role: "user", text: HELD });
});

test("held input returns to the editor when the run is aborted", async () => {
  const result = await interruptedRequest(
    (pi, session) => {
      pi.on("tool_execution_end", async (event, ctx) => {
        if (event.toolName !== "compact") return;
        await session().steer(HELD);
        ctx.abort();
      });
    },
    { ui: true },
  );
  assert.equal(result.notices.length, 1);
  assert.match(result.notices[0] ?? "", /did not run: The run was aborted\./);
  assert.equal(result.compacted, false);
  assert.equal(result.answered, undefined);
  assert.equal(result.editorText, HELD);
  assert.equal(result.heldWidget, undefined);
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
