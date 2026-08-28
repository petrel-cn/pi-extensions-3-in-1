# pi-extensions

> A collection of pi extensions and a companion desktop app, built for [pi](https://github.com/earendil-works/pi-coding-agent).

**English** | [简体中文](./README.zh-CN.md)

## What's inside

| Component | Type | Description |
|-----------|------|-------------|
| [balance](./balance/README.md) | pi extension | Shows the current model provider's account balance in the pi footer. |
| [workspace-guard](./workspace-guard/README.md) | pi extension | Keeps file writes within the current workspace and prompts for approval on anything outside it. |
| [pi-status](./pi-status/README.md) | pi extension | Exposes pi's live running state as machine-readable JSON. |
| [pi-status-window](./pi-status-window/README.md) | Windows app | Always-on-top floating window that shows pi's status on the desktop (polls the JSON from pi-status). |

## Install

**Git or npm (whole set):**

```bash
pi install git:github.com/petrel-cn/pi-extensions@v1
pi install npm:@petrel-cn/pi-extensions
```

**npm (per component):**

```bash
pi install npm:@petrel-cn/balance
pi install npm:@petrel-cn/workspace-guard
pi install npm:@petrel-cn/pi-status
```

Then `/reload` in pi to activate. The floating window app `pi-status-window` is a separate Windows executable — see its [README](./pi-status-window/README.md) to build it or grab a pre-built binary from the Releases page.

> Extensions run with full system permissions. Only install sources you trust.

## Dependency relationships

The components are **loosely coupled** — each works independently; missing a companion only degrades a feature, never breaks another:

```
workspace-guard ──broadcast approval events──▶  pi-status ──writes JSON──▶  pi-status-window
balance ──────────writes %TEMP%/pi-balance.json ──▶  pi-status / pi-status-window
```

- **balance** depends on nothing; others consume its `%TEMP%/pi-balance.json` (weak).
- **workspace-guard** depends on nothing; it broadcasts `pi-status:approval` events (weak).
- **pi-status** needs nothing to run; it consumes balance's JSON and workspace-guard's events (weak).
- **pi-status-window** needs pi-status (and optionally balance) for its data.

See each component's README for details.

## Requirements

- pi version: `0.84.x`
- Node.js: `>= 20`
- Windows 10/11 (for the `pi-status-window` app)

## License

[MIT](./LICENSE)
