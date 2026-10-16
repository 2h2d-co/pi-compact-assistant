import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionFactory,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { compactAssistant } from "../src/extension.ts";
import { SETTINGS_FILE_NAME } from "../src/settings.ts";

export const SYSTEM_INSTRUCTIONS = "Base test instructions: Never deploy without approval.";
export const CONTEXT_WINDOW = 100_000;
/** A second scripted model that does not accept mid-conversation system messages. */
export const FOLDING_MODEL_ID = "faux-folding";

export interface RuntimeOptions {
  /** Provider name of the scripted model. Defaults to the supported `anthropic`. */
  provider?: string;
  /** Whether the scripted model accepts mid-conversation system messages. Defaults to true. */
  midConversation?: boolean;
  /** Extension files Pi loads from disk, so their source metadata names real paths. */
  extensionPaths?: string[];
  /** Bind a UI that records the editor text, widgets, and notices. */
  ui?: boolean;
}

/** What the recording UI shows. */
export interface UiState {
  editorText: string;
  widgets: Map<string, string[]>;
  /** Every widget line shown, in order. */
  shown: string[];
  /** Every notice shown, in order. */
  notices: string[];
}

/** Pi spreads the UI and calls only the methods an extension uses. */
function isUi(
  value: Pick<ExtensionUIContext, "setWidget" | "setEditorText">,
): value is ExtensionUIContext {
  return "setWidget" in value && "setEditorText" in value;
}

/** A UI that records the editor text, widgets, and notices, the methods pi-compact-assistant uses. */
function recordingUi(state: UiState): ExtensionUIContext {
  const ui: Pick<ExtensionUIContext, "notify" | "setWidget" | "getEditorText" | "setEditorText"> = {
    notify: (message) => {
      state.notices.push(message);
    },
    setWidget: (name: string, content: unknown) => {
      if (Array.isArray(content)) {
        state.widgets.set(name, content.map(String));
        state.shown.push(...content.map(String));
      } else {
        state.widgets.delete(name);
      }
    },
    getEditorText: () => state.editorText,
    setEditorText: (value) => {
      state.editorText = value;
    },
  };
  assert.ok(isUi(ui));
  return ui;
}

/**
 * A real Pi runtime with an offline scripted provider, a private temporary agent home, and
 * the extension's settings file written there. Pi's automatic compaction is off.
 */
export async function testRuntime(
  settings: unknown,
  extra?: ExtensionFactory,
  mode: "tui" | "rpc" | "print" | "json" = "print",
  entry = false,
  options: RuntimeOptions = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-compact-assistant-runtime-"));
  const agentDir = join(cwd, "agent");
  const inherited = process.env["PI_CODING_AGENT_DIR"];
  if (entry && !inherited) throw new Error("Entry tests require PI_CODING_AGENT_DIR.");
  const settingsDirectory = entry && inherited ? inherited : join(cwd, "settings");
  if (settings !== undefined) {
    await mkdir(settingsDirectory, { recursive: true });
    await writeFile(join(settingsDirectory, SETTINGS_FILE_NAME), JSON.stringify(settings));
  }
  const faux = fauxProvider({
    provider: options.provider ?? "anthropic",
    models: [
      { id: "faux-1", contextWindow: CONTEXT_WINDOW },
      { id: FOLDING_MODEL_ID, contextWindow: CONTEXT_WINDOW },
    ],
  });
  for (const model of faux.models) {
    Object.assign(model, {
      compat: {
        supportsMidConvoSystemMessages:
          model.id !== FOLDING_MODEL_ID && (options.midConversation ?? true),
      },
    });
  }
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const errors: string[] = [];
  const ui: UiState = { editorText: "", widgets: new Map(), shown: [], notices: [] };
  const createRuntime: CreateAgentSessionRuntimeFactory = async (sessionOptions) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false, keepRecentTokens: 100, reserveTokens: 100 },
        retry: { enabled: false },
      }),
      resourceLoaderOptions: {
        systemPromptOverride: () => SYSTEM_INSTRUCTIONS,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        // The packaged entry reads its settings from Pi's agent directory.
        additionalExtensionPaths: [
          ...(entry ? [fileURLToPath(new URL("../extensions/index.ts", import.meta.url))] : []),
          ...(options.extensionPaths ?? []),
        ],
        extensionFactories: [
          {
            name: "offline-provider",
            factory: (pi) => {
              pi.registerProvider(faux.provider);
            },
          },
          ...(entry
            ? []
            : [
                {
                  name: "pi-compact-assistant",
                  factory: (pi: Parameters<ExtensionFactory>[0]) => {
                    compactAssistant(pi, { settingsDirectory: () => settingsDirectory });
                  },
                },
              ]),
          ...(extra ? [{ name: "test-events", factory: extra }] : []),
        ],
      },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager: sessionOptions.sessionManager,
        ...(sessionOptions.sessionStartEvent
          ? { sessionStartEvent: sessionOptions.sessionStartEvent }
          : {}),
        model: faux.getModel(),
        noTools: "builtin",
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: SessionManager.create(cwd, join(cwd, "sessions")),
  });
  const bind = async (session: AgentSession) => {
    await session.bindExtensions({
      ...(options.ui ? { uiContext: recordingUi(ui) } : {}),
      mode,
      onError: (error) => {
        errors.push(error.error);
      },
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        navigateTree: (id, options) => session.navigateTree(id, options),
        newSession: (options) => runtime.newSession(options),
        fork: (id, options) => runtime.fork(id, options),
        switchSession: (file, options) => runtime.switchSession(file, options),
        reload: async () => {
          throw new Error("Test does not implement reload.");
        },
      },
    });
  };
  runtime.setRebindSession(bind);
  await bind(runtime.session);
  assert.equal(errors.length, 0, errors.join("\n"));
  return { runtime, faux, errors, cwd, settingsDirectory, ui };
}

export async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await setTimeout(10);
  }
  throw new Error("Timed out waiting for session operation.");
}

/** About `tokens` estimated tokens of text (Pi estimates four characters per token). */
export function filler(tokens: number): string {
  return "word ".repeat(Math.ceil((tokens * 4) / 5));
}
