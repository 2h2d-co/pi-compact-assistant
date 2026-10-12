# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Monitor context usage before every model request and add a compaction preparation instruction,
  then a compaction instruction, as request-local system messages when per-model thresholds are
  reached. Anthropic receives them as system messages and OpenAI Codex as developer messages on
  models that accept mid-conversation instructions. The preparation instruction tells the model to
  keep working and record the work's state in a Markdown state file outside project documentation
  and Git. The compaction instruction tells it to update that file now and call `compact`. When
  usage passes both thresholds at once, a self-contained compaction instruction covers both steps.
  A model that cannot write files puts the state in its continuation message.
- Add the `compact` tool. The model calls it alone with a required continuation message, which
  gives the Markdown state file's absolute path and the exact next step, and optional summarizer
  instructions. The continuation tells the model to read the state file before acting. After a
  failed or cancelled compaction, the tool guidelines tell the model to check the reason before
  retrying. The extension compacts after the turn ends, then delivers the
  message and resumes the agent.
- Read token or percentage thresholds from `~/.pi/agent/pi-compact-assistant.json`, with exact
  `provider/modelId` entries and a default for other models.
