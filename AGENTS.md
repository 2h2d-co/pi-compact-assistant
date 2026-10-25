# pi-compact-assistant

- This package adds context-threshold compaction instructions and the `compact` tool. Keep it
  focused on compaction. Session navigation and handoff experiments belong in
  `pi-session-tools`.
- Support Pi `>=1.4.0 <1.5.0`. Keep Pi peer ranges bounded below the next Pi minor release and pin
  development dependencies to the version actually tested. Do not keep fallbacks for Pi versions
  below the minimum.
- Pi extensions run with full system permissions; keep side effects explicit and documented.
- Use the public Pi extension API. Do not mutate session JSONL or runtime internals.
- Keep instructions request-local and anchored. Never persist them as conversation or system
  messages: compaction snapshots replay persisted system content into the next prompt.
- Keep an instruction's text and position identical across requests so prompt-cache prefixes stay
  valid.
- Test instructions at the provider boundary. Live tests must cover Anthropic and Codex through
  the packaged Pi CLI with the system prompt patcher and the provider's compat extension.
  They also cover a real pi-anthropic-compat cancellation whose published reason reaches the
  notice. Anthropic scenarios assert that the request adding `compact` and the native summary
  request read the prompt cache, including a session that starts with a `!` shell command.
- Keep the continuation message separate from summarizer instructions. Never replay a cancelled
  compaction request.
- Run `mise run check` before committing meaningful code changes. It runs `hk check --all --check`,
  `npm test`, `npm audit`, and `npm run pack:dry`.
- Keep `.github/npm-package-files` synchronized with every intentional package-content change;
  local release validation and both CI jobs enforce it exactly.
- Use Conventional Commits and maintain `CHANGELOG.md` in Keep a Changelog style; add entries for
  `feat:` and `fix:` changes under `Unreleased`.
- Keep changelog entries under `Unreleased` for prereleases and move them into a release section
  only for stable releases.
- Use `npm run release -- <version>` to build the release package locally, run the live test
  against it, create an SSH-signed `release: v<version>` commit containing its
  `Npm-Artifact-SHA256` trailer, verify a clean rebuild, and create the matching lightweight tag.
- Push the release commit and tag atomically; do not use `git tag -a`, `git tag -s`, `git tag -m`,
  or `cog bump --annotated`.
- Push stable or prerelease `v<version>` tags and let CI build and stage the package with trusted
  publishing and provenance, then create the immutable GitHub release from the verified archive
  and the version's changelog section. Never create GitHub releases by hand. Stable versions use
  `latest`; prereleases derive a non-`latest` dist-tag from their first prerelease identifier.
- Publication and installation into a user's live Pi configuration are separate operations.
- Live tests report every error they meet as a test diagnostic, even when they pass: extension error and warning notices, extension errors, and failed responses. Use `test/support/error-log.ts`. Summarize failed responses by stop reason, HTTP status, and error category; never print provider error text or credentials.
- Keep tests in `test/*.test.ts`, code that tests import or load into Pi in `test/support/`, and test data in `test/fixtures/`.
