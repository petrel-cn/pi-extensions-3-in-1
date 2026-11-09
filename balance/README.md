# balance

> A pi extension that shows the current model provider's account balance in the pi footer.

**English** | [简体中文](./README.zh-CN.md)

![Balance shown in the pi footer](image/balance.jpg)

`balance` displays the account balance of the provider backing the active model, right after the context-usage indicator in pi's bottom footer (e.g. `16.8%/1.0M (auto)`).

## Features

- **Footer display** — shows the balance in the footer's stats line, just after the context usage indicator.
- **Modular backends** — the frontend only renders; each provider implements its own balance query through a dispatcher. Built-in modules cover `deepseek` (currency balance) and `workbuddy` (wb2api credits); other providers fall back to a stub (shown as `💰 N/A`). Adding another provider is a matter of registering one module.
- **Multi-currency / credits** — currency symbols are detected from the API response (`CNY → ￥`, `USD → $`); all currencies are shown, space-separated. WorkBuddy credits are shown as `4451c` (no currency symbol) and only sum **available accounts** (not disabled, not paused, credits above `credit_floor`).
- **Configurable refresh** — default 60s, selectable 30s–300s via `/balance-interval`; persisted to `config.json` next to the extension.
- **Machine-readable output** — additionally writes a plain amount (no emoji) to `%TEMP%/pi-balance.json`, so other tools or the [pi-status-window](../../pi-status-window/) floating window can consume it.
- **Resilient state writes** — `%TEMP%/pi-balance.json` is written atomically (temp file + rename). On Windows a concurrently polling reader can hold the file open for a few microseconds, so a failed rename is retried with a short backoff (3/10/25 ms) rather than surfacing an error.
- **Bilingual** — follows the system/PI_LANG language, falling back to English (see [Language](#language--internationalization)).

## File layout

```
balance/
├── index.ts          # entry: footer rendering, refresh timer, model-switch handling, /balance-interval
├── i18n.ts           # zh/en dictionary and t()
├── config.ts         # refresh interval + workbuddy data-source config (default 60s, clamped to 30s–300s)
├── config.json       # persisted config (refresh interval + workbuddy.panelDir/stateFile, created on first run)
└── providers/
    ├── index.ts      # dispatcher: provider → query module (+ whether it requires an API key)
    ├── deepseek.ts   # deepseek balance query (GET /user/balance, Bearer auth)
    ├── workbuddy.ts  # WorkBuddy credits query (GET /status first, panel state.json fallback)
    └── stub.ts       # placeholder for other providers (returns unsupported)
```

## Install

```bash
# From any local path (extension directory)
pi install /absolute/path/to/balance

# Relative to the current project
pi install ./balance
```

Then `/reload` in pi to activate the extension. When published on npm or git, you will also be able to:

```bash
pi install npm:@petrel-cn/balance     # or
pi install git:github.com/petrel-cn/pi-extensions-3-in-1@v1.2.0
```

> Extensions run with full system permissions. Only install sources you trust.

## Usage

| Command | Effect |
|---------|--------|
| `/balance-interval` | Interactively set the refresh interval (30s – 5 min); persisted to `config.json` |

The balance is displayed automatically in the footer. It refreshes on `session_start`, on a timer, and immediately when the model (and therefore provider) changes.

## Configuration

The extension reads `config.json` next to itself (created on first run):

```json
{
  "refreshIntervalMs": 60000,
  "workbuddy": {
    "panelDir": "",
    "stateFile": ""
  }
}
```

- `refreshIntervalMs` — refresh interval in milliseconds. Allowed range 30s–300s; clamped to these bounds if out of range.
- `workbuddy.panelDir` — directory of the local wb2api panel. Used to resolve its `config.json` (for the API key and `state_file`) and the default `data/state.json`.
- `workbuddy.stateFile` — explicit path to the panel state file; leave empty to resolve it from the panel configuration.

## Language / Internationalization

`balance` is bilingual (Chinese / English) and self-contained. Language is resolved with the following priority:

1. `PI_LANG` environment variable (`zh` or `en`)
2. System language — POSIX env vars (`LANG` / `LC_ALL`) **or** the system ICU locale (most reliable on Windows, e.g. `zh-CN`)
3. Fallback: **English**

The `💰 Fetch failed` message (shown when a balance query fails) follows this resolution: `获取失败` in Chinese, `Fetch failed` in English. Non-Chinese users always see English.

## Dependencies

- **Weak (depends on nothing)** — `balance` uses only pi's public extension API and Node built-ins.
- **Consumed by** — writes `%TEMP%/pi-balance.json` for the [pi-status-window](../../pi-status-window/) floating window (weak); missing it does not affect the footer display.
- Runtime deps: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` (provided by pi; list in `peerDependencies`).

## Compatibility

- pi version: tested against `1.5.x` (uses `setFooter`, `modelRegistry.getProviderAuth`).
- Node.js: `>= 20`.

## Non-interactive mode

- `ctx.ui.setFooter` renders nothing outside TUI mode (`json` / `print` / `rpc`), so the footer produces no output there.
- Balance queries, the refresh timer and the `%TEMP%/pi-balance.json` write do not depend on the UI and behave the same.

## Notes

- The deepseek balance query is `GET {baseUrl}/user/balance`; the WorkBuddy credits query is `GET {baseUrl}/status` with a panel `state.json` fallback. Credentials are resolved from the panel config or pi's credential store (`ctx.modelRegistry.getProviderAuth`) and are never hard-coded.
- Failed queries show `💰 Fetch failed` in a warning colour; a missing key or an unsupported provider shows `💰 N/A`.
- The cache-hit rate is computed over the whole session as `cacheRead / (input + cacheRead + cacheWrite)`, consistent with `pi-status`.

## Implementation note

`balance` replaces pi's built-in footer via `ctx.ui.setFooter()`. The pi footer is **globally unique** — only one custom footer is active at a time. If another extension also calls `setFooter()`, they overwrite each other (the later-loaded one wins) and one of them loses its display. Extensions that render a footer should either cooperate within a single footer component or explicitly disable/replace `balance` to avoid conflicts.

## License

[MIT](../LICENSE) — free to use, modify, and redistribute.
