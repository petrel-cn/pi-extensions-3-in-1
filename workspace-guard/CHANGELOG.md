# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.6.0] - 2026-09-25

### Added

- **Bounded approval dialogs** — long commands no longer overflow the approval prompt. Two pure helpers land in `core.ts` (`clampLines()`, `clampChars()`) and `index.ts` applies a fixed preview policy to all three approval dialogs:
  - command preview and target-path list: **20 lines or fewer are shown in full; longer ones show the first 16 lines, an omission marker, and the last 3 lines** (20 lines in total, `⋯ (N lines omitted)` / `⋯ (N more targets not shown)`);
  - prose (the LLM explanation and the local-template effect text): **never re-wrapped by the extension** — the terminal wraps it to whatever width the window actually has, and it is only cut in the pathological case of more than 1000 characters (a safety valve that normal 200–400 character explanations never hit);
  - no terminal size is read at all: the extension does no width estimation and no forced wrapping, so a wrapped-then-rewrapped mess can never happen at any window width.
- **New i18n keys** — `clamp.omittedLines`, `clamp.omittedTargets` (zh + en).

### Fixed

- **Approval prompts taller than the terminal were unreadable.** The built-in `select` dialog has no height cap and no internal scrolling, and in regular TUI mode its viewport is pinned to the bottom of the buffer, so only the tail stayed visible; the terminal's own scrollbar spans the whole session scrollback and can only jump between the extremes, leaving the beginning of the command unreachable. Dialog contents are now clamped before display, so the command's first lines and its closing lines are both visible.

## [2.5.0] - 2026-09-25

### Added

- **`llmExtraRules` in `config.json`** (optional `string[]`) — extra audit rules appended to the dangerous-command LLM system prompt, one bullet per entry, under a dedicated section that states it takes precedence over the rest of the prompt. Lets a deployment inject its own risk policy (for example directory-specific exemptions) without patching the extension.
- **`readConfig()` export** in `i18n.ts` — tolerant `config.json` reader, shared by the language persistence logic and the extra-rules lookup.

### Changed

- **Prompt assembly split** — `llmSystemPrompt()` is now a thin wrapper around `llmBasePrompt()` (the unchanged base prompt). With no extra rules configured the resulting system prompt is identical to the previous release, and the extra-rules section is the only addition otherwise.
- **`setLanguage()` merge-write** — `config.json` is updated field by field instead of being overwritten wholesale, so `/wsguard lang` no longer drops other settings such as `llmExtraRules`.

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
