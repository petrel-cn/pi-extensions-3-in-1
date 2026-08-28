# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.5.0] - 2026-08-29

### Added

- **Bilingual `i18n`** — new `i18n.ts` resolves the display language (`PI_LANG` env → system locale → English fallback).
- The `💰 Fetch failed` message now follows the language (`获取失败` / `Fetch failed`), consistent with the workspace-guard extension.

### Changed

- Footer fallback message is now locale-aware instead of hard-coded Chinese.

## [1.4.0] - 2026-08-15

### Fixed

- **Cache-hit rate could always show 100%** — it used the *last* assistant message's hit rate, which is 100% when that message was all-cache (input = 0, cacheRead > 0). Now computed over the whole session as `cacheRead / (input + cacheRead + cacheWrite)`, consistent with the stats shown by pi-status.

## [1.3.0] - 2026-08-15

### Changed

- `%TEMP%/pi-balance.json` now writes the **plain amount** (no emoji) instead of the rendered text, to avoid `💰` rendering as a tofu box in the Windows GDI+ floating window.
- The footer `balanceText` still includes the `💰` emoji for the terminal; the `balanceAmount` field is for the machine-readable JSON.
- All fallback branches (no model / no key / unsupported) clear `balanceAmount`.

## [1.2.0] - 2026-08-15

### Added

- **Floating-window balance output** — `refreshBalance`'s `finally` block now atomically writes the current balance state to `%TEMP%/pi-balance.json` (format: `{ "balance", "kind": "ok|unsupported|error", "ts" }`) for the [pi-status-window](../pi-status-window/) floating window to poll. When the file is absent, the window shows "balance unavailable".

## [1.1.0] - 2026-08-13

### Added

- **Request timeout** — `refreshBalance` passes `signal: AbortSignal.timeout(10_000)` to the balance fetch. Previously a hanging API request would keep the `inFlight` guard set, permanently stopping refreshes. The timeout frees `inFlight` and shows `Fetch failed` / `获取失败`.

## [1.0.0] - 2026-08-13

### Added

- **Initial release** — shows the active model provider's account balance in the footer, right after the context-usage indicator.
- **Modular providers** — `providers/index.ts` dispatches by provider; a `deepseek` module is included, others fall back to a stub.
- **Multi-currency** — `CNY → ￥`, `USD → $`; all currencies shown, space-separated.
- **Refresh** — default 60s; `/balance-interval` lets you select 30s–300s; persisted to `config.json`.
- **Auth** — API key resolved via `ctx.modelRegistry.getProviderAuth`, never hard-coded.
- **Styling** — failed queries show a warning-colored message; no key / unsupported provider shows `💰 N/A`.
- **Documentation** — bilingual (Chinese/English) source comments.

[Unreleased]: https://example.com/balance/compare/v1.5.0...HEAD
[1.5.0]: https://example.com/balance/compare/v1.4.0...v1.5.0
[1.4.0]: https://example.com/balance/compare/v1.3.0...v1.4.0
[1.3.0]: https://example.com/balance/compare/v1.2.0...v1.3.0
[1.2.0]: https://example.com/balance/compare/v1.1.0...v1.2.0
[1.1.0]: https://example.com/balance/compare/v1.0.0...v1.1.0
[1.0.0]: https://example.com/balance/releases/tag/v1.0.0
