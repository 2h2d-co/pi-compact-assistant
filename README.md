# pi-compact-assistant

Pi extension that lets the model compact its own conversation at a good moment, before Pi's
automatic compaction interrupts it.

- It checks context usage before every model request, including requests between tool calls.
- At a **preparation threshold**, it tells the model to keep working and to record the work's
  state in a Markdown file.
- At a **compaction threshold**, it tells the model to update that file now, then call the
  **`compact`** tool with the file's path and the next step.
- `compact` runs Pi's compaction after the turn ends, then delivers the model's continuation
  message and resumes the agent.

The instructions are system messages. Anthropic receives them as `system` messages and OpenAI
Codex as `developer` messages, in place in the conversation.

## Requirements and loading

Tested with Pi **1.1.0** and Node.js **22.23.3**. The package requires Pi `>=1.1.0 <1.2.0` and
Node.js `>=22.19.0`. The extension refuses to load on a Pi older than 1.1.0, because Pi does not
enforce the peer range when it installs packages.

**Pi's virtual models are not supported.** Pi's experimental virtual models, registered with
`pi.registerVirtualModel()`, are not tested with this package.

From this checkout:

```sh
mise run init
mise exec -- pi -e ./extensions/index.ts
```

This does not change your Pi configuration. Keep other extensions enabled, including any required
provider or system-prompt extensions.

## Settings

Settings are read from `~/.pi/agent/pi-compact-assistant.json` when a session starts. Run
`/reload` after changing the file. A missing file uses the defaults.

```json
{
  "enabled": true,
  "default": { "prepareAt": "70%", "compactAt": "80%" },
  "models": {
    "anthropic/claude-opus-5-5": { "prepareAt": 450000, "compactAt": 500000 },
    "openai-codex/gpt-6.1-sol": { "prepareAt": "60%", "compactAt": "75%" },
    "openai-codex/gpt-5.3-codex-spark": false
  }
}
```

| Setting   | Value                                                           | Default                                      |
| --------- | --------------------------------------------------------------- | -------------------------------------------- |
| `enabled` | `true` or `false`                                               | `true`                                       |
| `default` | Thresholds for models without an entry, or `false` to skip them | `{ "prepareAt": "70%", "compactAt": "80%" }` |
| `models`  | Thresholds or `false`, keyed by exact `provider/modelId`        | `{}`                                         |

A threshold is a whole token count, such as `450000`, or a percentage of the model's context
window, such as `"70%"`. A model entry needs both `prepareAt` and `compactAt`, and `compactAt`
must resolve above `prepareAt`. Keys are exact and case-sensitive.

An invalid file disables the extension for the session. Interactive and RPC sessions show an error. Thresholds that are
invalid for one model skip that model.

### Keep Pi's automatic compaction as a backstop

Pi compacts automatically when context exceeds `contextWindow - reserveTokens`. Keep that trigger
above `compactAt` so the model has room to compact first. Pi still compacts if the model ignores
the instruction. For example, compact Opus 5.5 at 500,000 tokens with this extension and let Pi
compact at 600,000:

```json
{
  "compaction": {
    "modelOverrides": {
      "anthropic/claude-opus-5-5": { "reserveTokens": 400000 }
    }
  }
}
```

## Instructions

Each stage is recorded once per compaction cycle as a custom session entry. The entry stores the
rendered text and the context entry it follows. Before each request, the extension adds the
recorded instructions as system messages directly after those entries. The instructions:

- are not stored as conversation messages, so summaries and later prompts never contain them;
- stay at the same position in later requests, so prompt-cache prefixes stay valid;
- stop after a compaction, until usage reaches a threshold again; and
- contain no usage figures, so their text is the same in every session.

The preparation instruction, `[Compaction preparation]`, tells the model not to stop or wrap up
early, because compaction does not end the task. The model records the goal, constraints,
decisions, changed files, validation results, running processes, open questions, and next step in
a Markdown state file and updates it when the state changes materially. It reuses the task's
state file or creates one where project instructions keep working notes, or outside tracked
files. It never puts the state in project documentation and never stages or commits the file.
Until the `[Compaction required]` instruction appears, it calls `compact` only at the user's
request.

`[Compaction required]` tells the model to act now: finish only a half-applied change, update the
state file, then call `compact` as the only tool call in its response, with the file's absolute
path and the exact next step. A model that cannot or may not write files skips the file and puts
the full state in the message. After compaction, the continuation tells the model to read the
named state file before acting.

The extension records which instructions it posted in each compaction cycle. If usage passes
both thresholds at once, so the preparation instruction was never posted, it posts a
self-contained `[Compaction required]` instruction instead. That instruction asks the model to
record the state in a Markdown state file under the same rules before calling `compact`.

Pi sends later system messages in place only to models that accept them mid-conversation. Pi 1.1.0
marks Claude Fable 5, Fable 5.1, Opus 4.8, Opus 5, Opus 5.5, Sonnet 5.5, and Haiku 5.5, and the
Codex GPT-5.5, GPT-5.6, GPT-6, and GPT-6.1 models this way. For other models, Pi folds the instruction into the leading
system prompt. That changes the prompt prefix once per stage, which invalidates the prompt cache
for that request.

## `compact`

```ts
{
  message: string;        // required
  instructions?: string;  // optional
}
```

- `message` is delivered after compaction succeeds and starts the next turn. It gives the
  absolute path of the Markdown state file and the exact next step. The file holds the rest of
  the state. Without a state file, the message holds the full state. If no work is pending, it
  says so.
- `instructions` guides the summarizer. It is passed to Pi's compaction as custom instructions.
  Pi's own summary, `pi-anthropic-compat` native compaction, and `pi-openai-codex-compat` remote
  compaction all apply them; live probes confirmed each native path. The instructions should only
  select or emphasize conversation content. Anthropic's native compaction refused an instruction
  to state a fact that was not in the conversation, and a refusal cancels the compaction.

The model must call `compact` alone. The tool ends the tool batch. After the run settles, the
extension compacts the session, appends the message as an agent-authored continuation, and
resumes the agent. The continuation states that it is not a new user request or authorization.

The request is cancelled, and the model is told, when:

- the run is aborted;
- the user sends input or queues a message before compaction finishes;
- the session branch changes or the conversation advances; or
- compaction fails or another extension cancels it.

Cancelled requests are never retried or replayed. `compact` changes conversation context only,
never files, processes, or permissions.

## Compat extensions

- **`pi-anthropic-compat`**: the native Anthropic compaction handles `compact`. Live tests pass
  with Claude Fable 5.1.
- **`pi-openai-codex-compat`** 0.0.23 or later: Codex remote compaction handles `compact`, and the
  instructions reach Codex as developer messages. Live tests pass with GPT-6.1 Sol. Version 0.0.22
  and earlier drop the instructions, because they build Codex requests only from the stored session.
- Without a compat extension, Pi's built-in Codex provider receives the instructions as developer
  messages, and Pi writes the summary. Live tests pass with GPT-6.1 Sol.

## Development

```sh
mise run init
mise run check
npm test
npm run test:live
npm run pack:dry
```

`npm test` runs offline tests with Pi's real session runtime and a scripted provider.

`npm run test:live` packs the extension and runs the packaged Pi CLI against real providers. It
uses your Pi login through an isolated agent directory, loads the pinned system prompt patcher and
the provider's compat extension, and checks that both instructions reach the provider payload, the
model calls `compact`, compaction runs, and the agent resumes with earlier facts intact. Release
validation runs it against the exact release archive.

## Packaging

`.github/npm-package-files` is the authoritative package-content allowlist used by the local release
command and both CI jobs. Update it whenever the intended published file set changes.

## Release staging

Repository setup:

1. When `new` creates the GitHub repository, it automatically protects `main` and `v*` tags and
   restricts `npm-publish` to `v*` tags without a deployment reviewer or administrator bypass.
2. Configure npm trusted publishing for `2h2d-co/pi-compact-assistant` using
   `.github/workflows/publish.yml` and the `npm-publish` environment.
3. Replace `.github/release-signers` if release commits use a different SSH signing key.

Release flow:

1. Run `npm run release -- X.Y.Z` from a clean, synchronized `main`. It runs the live test against
   the exact staged archive before signing.
2. The release command packs the package from the staged Git index, records its SHA-256 in the
   SSH-signed release commit, rebuilds the commit to prove reproducibility, and creates a lightweight
   `vX.Y.Z` tag.
3. Inspect the commit and tag, then push them atomically with
   `git push --atomic origin main vX.Y.Z`.
4. A read-only CI job tests, packs, and inspects the package without publishing credentials.
5. A separate credentialed job verifies the signed commit and exact package digest before attesting
   and staging that archive through npm trusted publishing.
6. A final job creates the immutable GitHub release for the tag from the same verified archive,
   its checksum, and the version's `CHANGELOG.md` section (`Unreleased` for prereleases).
7. Approve the staged package on npmjs.com or with `npm stage approve <stage-id>`.

Stable versions use `latest`; prereleases derive a non-`latest` dist-tag such as `alpha`, `beta`, or
`rc` from their first prerelease identifier.
