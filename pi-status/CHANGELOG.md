# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-08-29

### Added

- **Language resolution** — the extension now resolves the UI and status `language` field following the shared priority: `PI_LANG` env > system language (POSIX env vars **or** the system ICU locale) > English fallback, consistent with the workspace-guard and balance extensions.

## [1.0.0] - 2026-08-15

### Added

- **Initial release** — subscribes to pi's session / agent / tool events and writes the live state to `%TEMP%/pi-status.json`.
- **State machine** — `idle → thinking → working → asking/approval → done`, with a summary that distinguishes the active action (`read`/`write`/`edit`/`search`/`tool`/`output`).
- **Data panel** — cache hit rate, context usage, and balance (from the balance extension).
- **Atomic writes** — temp file + rename so the floating window never reads a partial JSON.
- **Language switching** — `/pi-status en|zh`, persisted to `config.json`.
- **Event-bus collaboration** — listens to `pi-status:approval` / `pi-status:approval-end` from workspace-guard for the approval state.

[Unreleased]: https://example.com/pi-status/compare/v1.1.0...HEAD
[1.1.0]: https://example.com/pi-status/compare/v1.0.0...v1.1.0
[1.0.0]: https://example.com/pi-status/releases/tag/v1.0.0
