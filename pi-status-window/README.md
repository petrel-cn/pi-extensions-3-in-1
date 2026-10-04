# pi-status-window

> A Windows floating window that shows the live running state of pi on your desktop.

**English** | [简体中文](./README.zh-CN.md)

The companion app to the `pi-status` extension. It polls the status JSON that the extension writes and displays a small, always-on-top overlay so you can see what pi is doing without switching to the terminal.

## Screenshots

| State | Description |
|------|--------|
| ![Idle](./image/pi-status-en1.jpg) | Idle — waiting for your instruction |
| ![Thinking](./image/pi-status-en2.jpg) | Thinking — pi is thinking… |

The title bar shows the current state; the status dot (drawn both in the title bar and on the left of the content area) uses one of five colors — 🟡 yellow = waiting, 🔵 blue = thinking, 🟢 green = tool call, 🔴 red = command approval, ⚪ gray = exited. The data panel below shows cache hit rate, context usage, and balance.

## Architecture

```
pi-status (extension)  ──writes──▶  %TEMP%/pi-status.json      ─┐
balance (extension)    ──writes──▶  %TEMP%/pi-balance.json    ──┤  polls 300ms
                                                                ▼
                                                    pi-status-window.exe
```

## Build

Uses the built-in .NET Framework compiler on Windows — no SDK required:

```bat
build.cmd
```

Outputs `bin\pi-status-window.exe`. Windows 10/11 ship with the .NET Framework 4.8 runtime, so the built exe runs with zero dependencies.

## Download

You can also grab a pre-built exe from the [Releases](https://github.com/petrel-cn/pi-extensions-3-in-1/releases) page — download it and run it. No build or runtime setup needed.

## Use

```bat
pi-status-window.exe          # Open the floating window (single instance; re-running just brings it forward)
```

The window is always-on-top. Pin, minimize, and close buttons are in the top-right. Window size / position / pin state are persisted to `%APPDATA%/pi-status-window/config.json`.

## Status dots

Five states, five colors. The dot appears both in the title bar (before the title text) and in the content area (before the description).

| Dot | State | Meaning | Trigger |
|-----|-------|---------|---------|
| 🟡 yellow `#FFC107` | idle | Waiting for your instruction | `session_start` / `agent_settled`, no activity |
| 🔵 blue `#2196F3` | thinking | Pi is thinking | `agent_start` / `thinking_delta` |
| 🟢 green `#43A047` | working | Tool call / output in progress | `text_delta` / `toolcall_*` / `tool_execution_start` |
| 🔴 red `#E53935` | approval | Command approval required | dangerous bash pattern (heuristic) / approval dialog |
| ⚪ gray `#9E9E9E` | closed | Pi has exited | `session_shutdown`, or heartbeat stale for 15 s |

The `asking` state (`ask_question` tool) is folded into `idle`, so a pending question shows the yellow dot. Working-state titles/body are refined per action (reading / writing / editing / searching / running tool).

## Icons

Uses the built-in Segoe Fluent Icons font (`SegoeIcons.ttf`) — no external assets: pin `E718`, minimize `E921`, restore `E923`, close `E8BB`.

## Notes

- In exclusive full-screen games the normal always-on-top window can be hidden (DWM is bypassed); in that case a tray bubble is shown at most once per 60s. Borderless full-screen (the modern default) works normally.
- Balance data comes from the [balance](../balance/) extension; without it, or on a failed query, the window shows "balance unavailable".

## License

[MIT](../LICENSE) — free to use, modify, and redistribute.
