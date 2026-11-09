# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-10-22

### Fixed

- **Sub-agent shutdown no longer makes the floating window report pi as closed.** Sub-agents (SDK runner, same process) can load the parent session's extensions; the extension loader caches factories per cwd, so parent and child shared the same module-level heartbeat timer and status. A child `session_shutdown` cleared the parent timer and wrote `status=closed`, leaving the window stuck on "closed" until the next parent event.
  - Temporary sessions (`print` mode with no session file, such as SDK sub-agents) are now recognized as non-owner sessions: they do not register writes, do not start a heartbeat, and never write `closed` on exit. Only one owner session per process maintains the state.
  - The status JSON gains a `pid` field. Before writing, ownership is checked: while another process has a fresh heartbeat (<12 s) this process observes; it takes over when the other process is `closed` or its heartbeat is stale (>=12 s), with a 10 s cooldown after yielding to avoid contention.
  - Heartbeats moved to `heartbeatTick`; `session_shutdown` writes `closed` only when this process is the owner.
  - Non-owner sessions keep their state in memory only and never touch the shared file.

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
