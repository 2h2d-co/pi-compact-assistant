# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Monitor context usage before every model request and add a compaction preparation instruction,
  then a compaction instruction, as request-local system messages when per-model thresholds are
  reached. Anthropic receives them as system messages and OpenAI Codex as developer messages on
  models that accept mid-conversation instructions. The preparation instruction tells the model to
  keep working and record the work's state in a Markdown file; the compaction instruction tells it
  to update that file and call `compact`.
- Add the `compact` tool. The model calls it alone with a required continuation message, which
  gives the Markdown state file's path and the exact next step, and optional summarizer
  instructions. The extension compacts after the turn ends, then delivers the
  message and resumes the agent.
- Read token or percentage thresholds from `~/.pi/agent/pi-compact-assistant.json`, with exact
  `provider/modelId` entries and a default for other models.
