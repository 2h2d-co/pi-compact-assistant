# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Declare the `compact` tool only once usage reaches `compactAt`, with the `[Compaction required]`
  instruction, and withdraw it after every compaction. Models no longer see the tool or its
  guidance before the threshold, so they no longer compact on their own. The model can no longer
  compact at the user's request before the threshold. The tool has no system prompt guidelines;
  the instructions, the tool description, and the cancellation notice carry its guidance.
  Anthropic receives the tool inside the conversation, so the cached prefix stays valid. With
  `pi-openai-codex-compat`, adding the tool costs one prompt-cache miss.

## [0.0.3] - 2026-10-17

### Changed

- Require Pi `>=1.3.0 <1.4.0`.
- The interactive TUI shows each recorded compaction instruction in the transcript as a box with
  its stage and token count, instead of a passing status line. Expanding tool output shows the
  exact instruction text. The box stays out of model context, and it reappears when a session is
  resumed. RPC clients still get a notice.

## [0.0.2] - 2026-10-15

### Changed

- Require Pi `>=1.2.0 <1.3.0`.

## [0.0.1] - 2026-10-15

### Added

- Monitor context usage before every model request and add a compaction preparation instruction,
  then a compaction instruction, as request-local system messages when per-model thresholds are
  reached. Each instruction stays at its position in later requests, even when several messages
  share a timestamp. Only `anthropic` and `openai-codex` models that accept mid-conversation
  system messages are instructed: Anthropic receives them as system messages and OpenAI Codex as
  developer messages. Codex models also require a loaded `pi-openai-codex-compat` to be 0.0.23 or
  later. The preparation instruction tells the model to
  keep working and record the work's state in a Markdown state file outside project documentation
  and Git. The compaction instruction tells it to update that file now and call `compact`. When
  usage passes both thresholds at once, a self-contained compaction instruction covers both steps.
  A model that cannot write files puts the state in its continuation message.
- Add the `compact` tool. The model calls it alone with a required continuation message, which
  gives the Markdown state file's absolute path and the exact next step, and optional summarizer
  instructions. The continuation tells the model to read the state file before acting. After a
  failed or cancelled compaction, the tool guidelines tell the model to check the reason before
  retrying. The extension compacts after the turn ends, then delivers the message and resumes the
  agent. Queued messages never cancel the request: messages queued before the run ends reach the
  model before compaction, and user input that arrives later waits until compaction finishes.
  After compaction, the continuation comes first and every other message follows it as a
  separate message. An aborted run or a failed compaction cancels the request with a notice, and
  held input follows the notice. The extension adds no command.
  The tool is declared only to supported models that the settings enable.
- Read token or percentage thresholds from `~/.pi/agent/pi-compact-assistant.json`, with exact
  `provider/modelId` entries and a default for other models. `prepareAt` is optional; without
  it, only the self-contained compaction instruction is posted.
