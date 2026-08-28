# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.4.0] - 2026-08-29

### Added

- **Bilingual `i18n`** — new `i18n.ts` makes the whole UI Chinese/English:
  - Approval options (`Allow once` / `Allow this session` / `Deny`), dialog titles and prompts.
  - The `/wsguard` command description and status notifications.
  - The LLM system prompt, risk labels, and the local fallback templates in `core.ts`.
- **`/wsguard lang <zh|en>`** — switches and persists the language to `config.json`.
- **Language resolution priority** — `PI_LANG` env > persisted language in `config.json` > system language > English fallback.
- **System-language detection** — reads POSIX env vars (`LANG`/`LC_ALL`) **or** the system ICU locale (most reliable on Windows, e.g. `zh-CN`).
- **Risk parsing** — normalizes to an internal `low/medium/high` enum; the LLM prompt requests `低/中/高` (zh) or `low/medium/high` (en), and the UI renders them accordingly.

## [2.3.0] - 2026-08-15

### Fixed

- **Dangerous commands were approved twice** — after a dangerous command was allowed, execution continued into the outside-workspace check and prompted again. Now, once a dangerous command is approved, the handler returns immediately, so the whole command is covered by a single approval.

## [2.2.0] - 2026-08-15

### Added

- **Approval-state event broadcast** — all three prompts (outside-workspace `write`/`edit`, dangerous command, and outside-workspace `bash`) broadcast `pi-status:approval` before showing and `pi-status:approval-end` after, so the pi-status floating window can display an "approval pending" state. Wrapped in `try/finally` so the end event always fires, avoiding a stuck approval state. Broadcast failures are logged only and never affect the approval itself.

## [2.1.0] - 2026-08-10

### Changed

- **Approval order** — `bash` commands now check for dangerous commands **before** outside-workspace writes. Previously an outside-workspace check ran first, so a command like `rm -rf /tmp/...` only showed "outside-workspace write"; now it shows the dangerous-command prompt first.
- **`/wsguard status` shows the state source** — a new `enabledSource()` distinguishes whose setting is in effect (env var / state.json / default), avoiding confusion when `state.json` says enabled but the env var actually disables the guard.

## [2.0.0] - 2026-08-09

### Added

- **LLM explanation + risk assessment** — generates a natural-language explanation and risk level for dangerous commands, with a fallback to local templates.
- **MSYS path handling** — Git Bash `/d/foo` paths are converted to Windows `D:/foo`, preventing inside-workspace paths from being misjudged as outside.
- **Multi-target command checks** — `rm`/`mv`/`mkdir`/`touch`/`tee`/`install` check all arguments; `cp`/`ln` check only the write target.

## [1.0.0] - 2026-08-08

### Added

- **Initial release** — outside-workspace write approval for `write`/`edit`/`bash`, dangerous-command protection (`rm -r`, `sudo`, `chmod/chown 777`), and the `/wsguard` toggle command with `state.json` persistence.

[Unreleased]: https://example.com/workspace-guard/compare/v2.4.0...HEAD
[2.4.0]: https://example.com/workspace-guard/compare/v2.3.0...v2.4.0
[2.3.0]: https://example.com/workspace-guard/compare/v2.2.0...v2.3.0
[2.2.0]: https://example.com/workspace-guard/compare/v2.1.0...v2.2.0
[2.1.0]: https://example.com/workspace-guard/compare/v2.0.0...v2.1.0
[2.0.0]: https://example.com/workspace-guard/compare/v1.0.0...v2.0.0
[1.0.0]: https://example.com/workspace-guard/releases/tag/v1.0.0
