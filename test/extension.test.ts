import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Type } from "typebox";
import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  getInitialSystemMessage,
  getSystemMessageText,
  type FauxResponseFactory,
  type Message,
} from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionFactory, SessionEntry } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import {
  CONTINUATION_TYPE,
  HELD_WIDGET,
  INSTRUCTION_TYPE,
  NOTICE_TYPE,
  activeInstructions,
  renderInstruction,
} from "../src/extension.ts";
import {
  FOLDING_MODEL_ID,
  SYSTEM_INSTRUCTIONS,
  filler,
  testRuntime,
  waitUntil,
  type RuntimeOptions,
} from "./support/runtime.ts";

const SETTINGS = { default: { compactAt: 20000 } };

function text(message: Message): string {
  if (message.role === "assistant") {
    return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  }
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/**
 * Later system messages (index > 0) that carry text, with the text of the nearest earlier
 * message that has text. Tool declaration changes are system messages without text.
 */
function laterSystemMessages(messages: readonly Message[]) {
  return messages.flatMap((message, index) => {
    const previous = messages.slice(0, index).findLast((earlier) => text(earlier));
    return index > 0 && message.role === "system" && text(message)
      ? [{ text: text(message), after: (previous ? text(previous) : "").slice(0, 30) }]
      : [];
  });
}

/** Whether a request declares `compact`. */
function declaresCompact(messages: readonly Message[]): boolean {
  return getCurrentTools(messages).some((tool) => tool.name === "compact");
}

test("records the instruction once and keeps its system message at a fixed position", async () => {
  const { runtime, faux, errors } = await testRuntime(SETTINGS);
  try {
    const seen: Message[][] = [];
    const record: FauxResponseFactory = (context) => {
      seen.push(context.messages);
      return fauxAssistantMessage("ok");
    };
    faux.setResponses([record, record, record, record]);
    await runtime.session.prompt(`first request ${filler(3500)}`);
    await runtime.session.prompt("second small request");
    await runtime.session.prompt(`third request ${filler(20000)}`);
    await runtime.session.prompt("fourth small request");

    // Below compactAt, requests carry no instruction.
    assert.deepEqual(laterSystemMessages(seen[0] ?? []), []);
    assert.deepEqual(laterSystemMessages(seen[1] ?? []), []);
    const third = laterSystemMessages(seen[2] ?? []);
    assert.equal(third.length, 1);
    assert.match(third[0]?.text ?? "", /^\[Compaction required\]/);
    assert.match(
      third[0]?.text ?? "",
      /call `compact`\. Make it the only tool call in its response/,
    );
    assert.match(third[0]?.after ?? "", /^third request/);
    // The instruction stays directly after the message it was anchored to.
    assert.deepEqual(laterSystemMessages(seen[3] ?? []), third);
    // `compact` is declared only with the instruction, after the leading message.
    assert.deepEqual(seen.map(declaresCompact), [false, false, true, true]);
    const initial = getInitialSystemMessage(seen[3] ?? [])?.toolsAdded ?? [];
    assert.equal(
      initial.some((tool) => tool.name === "compact"),
      false,
    );
    // The instructions are later system messages. The leading system prompt stays unchanged.
    for (const request of seen) {
      const leading = request[0];
      assert.ok(leading?.role === "system");
      assert.equal(JSON.stringify(leading), JSON.stringify(seen[0]?.[0]));
      assert.match(getSystemMessageText(leading), new RegExp(SYSTEM_INSTRUCTIONS));
      assert.doesNotMatch(getSystemMessageText(leading), /\[Compaction/);
    }
    // The serialized bytes of an earlier request prefix remain unchanged.
    const prefix = seen[2]?.length ?? 0;
    assert.equal(JSON.stringify(seen[3]?.slice(0, prefix)), JSON.stringify(seen[2]));

    const records = runtime.session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === INSTRUCTION_TYPE);
    assert.equal(records.length, 1);
    // Instructions are request-local: the stored transcript and prompt do not contain them.
    assert.doesNotMatch(
      JSON.stringify(runtime.session.sessionManager.buildSessionProjection().messages),
      /\[Compaction required\]\\n/,
    );
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

/**
 * Pi's default expand binding. The interactive TUI installs Pi's keybindings. Offline tests install
 * this one.
 */
const EXPAND_KEY = {
  "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
} as const;

/** A theme that leaves text unstyled, so rendered lines compare as plain text. */
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function rendered(entry: SessionEntry | undefined, expanded: boolean): string {
  assert.ok(entry?.type === "custom");
  const component = renderInstruction(entry, { expanded }, plainTheme);
  assert.ok(component, "The instruction entry renders.");
  return (
    component
      // Wide enough that no instruction line wraps.
      .render(1000)
      // The box pads each line by one column.
      .map((line) => stripVTControlCharacters(line).replace(/^ /, "").trimEnd())
      .join("\n")
      .trim()
  );
}

test("the TUI draws the recorded instruction in the transcript instead of a notice", async (t) => {
  const previous = getKeybindings();
  setKeybindings(new KeybindingsManager(EXPAND_KEY));
  t.after(() => {
    setKeybindings(previous);
  });
  const { runtime, faux, errors, ui } = await testRuntime(SETTINGS, undefined, "tui", false, {
    ui: true,
  });
  try {
    faux.setResponses([fauxAssistantMessage("ok")]);
    await runtime.session.prompt(`large request ${filler(20000)}`);
    assert.equal(
      runtime.session.extensionRunner.getEntryRenderer(INSTRUCTION_TYPE),
      renderInstruction,
    );
    const entries = runtime.session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === INSTRUCTION_TYPE);
    assert.equal(entries.length, 1);
    const [instruction] = entries;

    const collapsed = rendered(instruction, false);
    assert.match(
      collapsed,
      /^\[Compaction required\] Added at [\d,]+ tokens, \d+% of the 100,000-token context window\. ctrl\+o to view the instruction$/,
    );
    assert.doesNotMatch(collapsed, /\n/);
    const expanded = rendered(instruction, true);
    assert.ok(instruction?.type === "custom" && typeof instruction.data === "object");
    assert.ok(instruction.data !== null && "text" in instruction.data);
    assert.ok(typeof instruction.data.text === "string");
    // Expanded, the box shows the exact instruction after the summary line.
    assert.ok(expanded.endsWith(instruction.data.text), expanded);
    assert.doesNotMatch(expanded, /to view the instruction/);
    assert.deepEqual(ui.notices, []);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("RPC clients get a notice for the recorded instruction", async () => {
  const { runtime, faux, errors, ui } = await testRuntime(SETTINGS, undefined, "rpc", false, {
    ui: true,
  });
  try {
    faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
    await runtime.session.prompt(`first request ${filler(20000)}`);
    await runtime.session.prompt("second request");
    assert.deepEqual(ui.notices.length, 1);
    assert.match(ui.notices[0] ?? "", /^Compaction instruction added at [\d,]+ tokens\.$/);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("the renderer skips data that is not an instruction record", () => {
  assert.equal(
    renderInstruction({ data: { stage: "later" } }, { expanded: true }, plainTheme),
    undefined,
  );
});

test("preparation instructions recorded by earlier versions are skipped", async () => {
  const { runtime, faux, errors } = await testRuntime(SETTINGS);
  try {
    const seen: Message[][] = [];
    const record: FauxResponseFactory = (context) => {
      seen.push(context.messages);
      return fauxAssistantMessage("ok");
    };
    faux.setResponses([record, record]);
    await runtime.session.prompt("first small request");
    const manager = runtime.session.sessionManager;
    const anchor = manager.getBranch().findLast((entry) => entry.type === "message");
    assert.ok(anchor);
    const stale = {
      stage: "prepare",
      anchorEntryId: anchor.id,
      text: "[Compaction preparation]\nRecord the state in a Markdown state file now.",
      model: "anthropic/faux-1",
      tokens: 3000,
      contextWindow: 100_000,
      timestamp: 1,
    };
    manager.appendCustomEntry(INSTRUCTION_TYPE, stale);
    await runtime.session.prompt("second small request");
    assert.deepEqual(laterSystemMessages(seen[1] ?? []), []);
    assert.equal(declaresCompact(seen[1] ?? []), false);
    assert.deepEqual(activeInstructions(manager.getBranch()), []);
    assert.equal(renderInstruction({ data: stale }, { expanded: true }, plainTheme), undefined);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("the collapsed instruction shows no hint when no key expands it", (t) => {
  const previous = getKeybindings();
  setKeybindings(new KeybindingsManager(EXPAND_KEY, { "app.tools.expand": [] }));
  t.after(() => {
    setKeybindings(previous);
  });
  const component = renderInstruction(
    {
      data: {
        stage: "compact",
        anchorEntryId: "anchor",
        text: "[Compaction required]\nCall compact.",
        model: "anthropic/faux-1",
        tokens: 80_000,
        contextWindow: 100_000,
        timestamp: 1,
      },
    },
    { expanded: false },
    plainTheme,
  );
  assert.deepEqual(
    component
      ?.render(200)
      .map((line) => stripVTControlCharacters(line).trim())
      .filter(Boolean),
    ["[Compaction required] Added at 80,000 tokens, 80% of the 100,000-token context window."],
  );
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
  /** Whether a session declares `compact` before and in a request past the threshold. */
  const declared = async (settings: unknown, options: RuntimeOptions = {}) => {
    const { runtime, faux, errors } = await testRuntime(
      settings,
      undefined,
      "print",
      false,
      options,
    );
    try {
      const before = runtime.session.getActiveToolNames().includes("compact");
      let messages: Message[] = [];
      faux.setResponses([
        (context) => {
          messages = context.messages;
          return fauxAssistantMessage("ok");
        },
      ]);
      await runtime.session.prompt(`large request ${filler(21000)}`);
      assert.deepEqual(errors, []);
      return [before, declaresCompact(messages)];
    } finally {
      await runtime.dispose();
    }
  };
  assert.deepEqual(await declared(SETTINGS), [false, true]);
  // Unsupported models.
  assert.deepEqual(await declared(SETTINGS, { provider: "opencode" }), [false, false]);
  assert.deepEqual(await declared(SETTINGS, { midConversation: false }), [false, false]);
  // Disabled models, including an invalid settings file, which disables every model.
  assert.deepEqual(await declared({ default: false }), [false, false]);
  assert.deepEqual(await declared({ models: { "anthropic/faux-1": false } }), [false, false]);
  assert.deepEqual(await declared({ enabled: false }), [false, false]);
  assert.deepEqual(await declared({ default: "bad" }), [false, false]);
});

test("a message that passes compactAt after the tool batch delays the instruction one request", async () => {
  const { runtime, faux, errors } = await testRuntime({ default: { compactAt: 20000 } }, (pi) => {
    pi.registerTool({
      name: "queue_large",
      label: "Queue large",
      description: "Queue a large steering message",
      parameters: Type.Object({}),
      execute: () => {
        // Steering arrives after the tool batch ends, so only the request sees its tokens.
        pi.sendUserMessage(`large steering ${filler(21000)}`, { deliverAs: "steer" });
        return Promise.resolve({ content: [{ type: "text", text: "queued" }], details: undefined });
      },
    });
  });
  try {
    const seen: Message[][] = [];
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("queue_large", {})),
      (context) => {
        seen.push(context.messages);
        return fauxAssistantMessage(fauxToolCall("queue_large", {}));
      },
      (context) => {
        seen.push(context.messages);
        return fauxAssistantMessage("done");
      },
    ]);
    await runtime.session.prompt("queue it");
    // The first request past compactAt has no `compact`, so it gets no instruction that asks
    // for it. The tool and the instruction arrive together with the next request.
    assert.deepEqual(laterSystemMessages(seen[0] ?? []), []);
    assert.equal(declaresCompact(seen[0] ?? []), false);
    const next = laterSystemMessages(seen[1] ?? []);
    assert.equal(next.length, 1);
    assert.match(next[0]?.text ?? "", /^\[Compaction required\]/);
    assert.equal(declaresCompact(seen[1] ?? []), true);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("any compaction withdraws compact", async () => {
  const { runtime, faux, errors } = await testRuntime(SETTINGS);
  try {
    faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
    await runtime.session.prompt(`large request ${filler(21000)}`);
    await runtime.session.prompt(`second request ${filler(300)}`);
    assert.equal(runtime.session.getActiveToolNames().includes("compact"), true);
    faux.setResponses([fauxAssistantMessage("Summary: the large request was handled.")]);
    await runtime.session.compact();
    assert.equal(runtime.session.getActiveToolNames().includes("compact"), false);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("switching models hides compact and declares it again", async () => {
  const { runtime, faux, errors } = await testRuntime(SETTINGS);
  try {
    const declared = () => runtime.session.getActiveToolNames().includes("compact");
    faux.setResponses([fauxAssistantMessage("ok")]);
    await runtime.session.prompt(`large request ${filler(21000)}`);
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
          content: [{ type: "text", text: `large result ${filler(21000)}` }],
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
    assert.match(later[0]?.text ?? "", /^\[Compaction required\]/);
    assert.match(later[0]?.after ?? "", /^large result/);
    assert.equal(declaresCompact(messages), true);
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
    assert.equal(declaresCompact(resumed), false);
    assert.equal(runtime.session.getActiveToolNames().includes("compact"), false);
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
    await runtime.session.prompt(`compact ${filler(21000)}`);
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
    await runtime.session.prompt(`compact ${filler(21000)}`);
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
  const runtime = await testRuntime(
    { default: { compactAt: 20000 } },
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

test("the extension adds no command to the command menu", async () => {
  let commands: string[] = [];
  const { runtime, errors } = await testRuntime(SETTINGS, (pi) => {
    pi.on("session_start", () => {
      commands = pi.getCommands().map((command) => command.name);
    });
  });
  try {
    assert.deepEqual(commands, []);
    assert.deepEqual(errors, []);
  } finally {
    await runtime.dispose();
  }
});

test("models set to false and invalid settings leave requests unchanged", async () => {
  for (const settings of [
    { default: false },
    { models: { "faux/faux-1": false } },
    { default: { compactAt: 0 } },
    { default: { compactAt: "bad" } },
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
