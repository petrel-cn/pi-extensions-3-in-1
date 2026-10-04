# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-09-29

### Fixed

- **Transient rename failure while the floating window polls the state file** — the window reads `%TEMP%/pi-status.json` every 300 ms, and .NET's `File.ReadAllText` opens it without delete sharing, so an overwriting rename could fail for the duration of that read window (tens of microseconds). `writeStateAtomically` now retries the rename up to three times with a short backoff (`EPERM` / `EACCES` / `EBUSY` / `ENOENT`; delays of 3/10/25 ms through a synchronous `Atomics.wait` sleep, rewriting the temp file on each attempt) and removes a leftover `.tmp` before reporting a permanent failure.

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
- **Heartbeat** — the state file's timestamp is refreshed every 5 seconds while pi is running, so a consumer can detect a killed or crashed pi without relying on event ordering.
