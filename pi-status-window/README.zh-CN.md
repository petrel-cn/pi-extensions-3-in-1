# pi-status-window

> 一个在桌面上实时显示 pi 运行状态的 Windows 悬浮窗程序。

**简体中文** | [English](./README.md)

这是 [pi-status](../pi-status/) 扩展的配套程序。它轮询扩展写入的状态 JSON，以一个小型、置顶的悬浮窗显示 pi 正在做什么，无需切回终端即可一目了然。

## 截图

| 状态 | 说明 |
|------|------|
| ![待命中](../pi-status/image/pi-status-zh1.jpg) | 待命中 —— Pi 正在等待您的指令 |
| ![思考中](../pi-status/image/pi-status-zh2.jpg) | 思考中 —— Pi 正在进行思考… |

标题栏显示当前状态；图钉圆点颜色表示状态（黄 = 询问，红 = 审批，绿 = 完成）。下方数据显示缓存命中率、上下文与余额。

## 架构

```
pi-status 扩展  ──写──▶  %TEMP%/pi-status.json    ─┐
balance  扩展   ──写──▶  %TEMP%/pi-balance.json  ──┤ 轮询 300ms
                                                   ▼
                                        pi-status-window.exe
```

## 构建

使用 Windows 自带的 .NET Framework 编译器，无需 SDK：

```bat
build.cmd
```

输出 `bin\pi-status-window.exe`。Windows 10/11 自带 .NET Framework 4.8 运行时，编译出的 exe 零依赖可直接运行。

## 下载

也可以直接从 [Releases](https://github.com/petrel-cn/pi-extensions/releases) 页面下载预编译的 exe —— 下载后直接运行即可，无需构建或安装运行时。

## 使用

```bat
pi-status-window.exe          # 打开悬浮窗（单实例；重复运行仅唤起已有实例）
```

窗口置顶。右上角为图钉、最小化、关闭按钮。窗口尺寸 / 位置 / 置顶状态持久化到 `%APPDATA%/pi-status-window/config.json`。

## 状态机

| 状态 | 触发 | 圆点 |
|------|------|------|
| idle | `session_start` 后无活动 | 无 |
| thinking | `agent_start` / `thinking_delta` | 无 |
| working | `text_delta` / `tool_execution_start` | 无 |
| asking | `ask_question` 工具 | 黄 |
| approval | 危险 bash 模式（启发式） | 红 |
| done | `agent_settled` | 绿 |

## 图标

使用系统自带 Segoe Fluent Icons 图标字体（`SegoeIcons.ttf`），零外部素材：图钉 `E718`、最小化 `E921`、还原 `E923`、关闭 `E8BB`。

## 说明

- 独占全屏游戏下普通置顶窗口不可见（DWM 被绕过），此时每 60 秒最多弹一次托盘气泡提醒；无边框全屏（现代游戏默认）可正常显示。
- 余额数据来自 [balance](../balance/) 扩展；未启用或查询失败时显示「余额不可用」。

## 许可协议

[MIT](../LICENSE) —— 允许自由使用、修改与再分发。
