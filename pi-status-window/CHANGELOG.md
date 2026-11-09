# Changelog

All notable changes to pi-status-window are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-11-09

### Added

- Auto-close: when Pi stays in the "closed" state for `autoCloseSeconds`
  (default 60 s), the window and its tray icon exit automatically. Set
  `autoCloseSeconds` to `0` in `%APPDATA%/pi-status-window/config.json` to
  disable it.
- The remaining time is shown in the content area while the countdown runs.

### Fixed

- A status file without a `ts` field is no longer treated as an expired
  heartbeat, which used to show Pi as closed and could trigger the auto-close.
- A missing or unreadable status file no longer keeps the previous "closed"
  countdown running.
- Out-of-range timestamps (for example microsecond values) no longer throw
  from the poll tick.

## [0.2.0]

### Changed

- Status indicator expanded from three colors to five, one per Pi state:
  idle (yellow), thinking (blue), working (green), approval (red) and
  closed (gray).

## [0.1.0]

### Added

- Initial release: an always-on-top floating window that polls
  `pi-status.json` and shows Pi's current state, cache hit rate, context usage
  and account balance.
