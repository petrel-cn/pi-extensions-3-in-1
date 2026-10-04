# pi-status

> 一个记录 pi 实时运行状态、并以机器可读 JSON 输出的扩展，供桌面悬浮窗显示。

**简体中文** | [English](./README.md)

![pi-status 悬浮窗](image/pi-status-zh1.jpg)

`pi-status` 订阅 pi 的会话 / 代理 / 工具事件，将当前状态写入 `%TEMP%/pi-status.json`。配套的 Windows 程序 [pi-status-window](../pi-status-window/) 轮询该文件，以桌面悬浮窗的形式显示运行状态。

## 作用

本扩展是**数据生产者**：它监听 pi 的生命周期事件，翻译成一个精简、结构化的状态对象，任何程序都能消费。它自身**没有 UI**——可见的悬浮窗是独立的 [pi-status-window](../pi-status-window/) 程序。

## 文件结构

```
pi-status/
├── index.ts      # 入口：事件订阅 + 状态机 + JSON 原子写入 + /pi-status 命令
├── config.json   # 语言配置（/pi-status zh|en 写入，自动生成，已 git-ignore）
├── README.md     # 本说明
└── CHANGELOG.md  # 修改记录
```

## 状态机

```
idle → thinking → working → asking / approval → done
```

| 状态 | 触发 |
|------|------|
| `idle` | `session_start` 后无活动 |
| `thinking` | `agent_start` / `thinking_delta` |
| `working` | `text_delta`（代码输出）/ `tool_execution_start` |
| `asking` | `ask_question` 工具被调用 |
| `approval` | 危险 bash 模式（启发式）+ 与 workspace-guard 的事件总线协作 |
| `done` | `agent_settled` |

摘要区分活动动作：`read` / `write` / `edit` / `search` / `tool` / `output`。

## 数据面板

数据面板显示：

- **缓存命中率** —— `cacheRead / (input + cacheRead + cacheWrite)`。
- **上下文** —— `ctx.getContextUsage().percent`。
- **余额** —— 读取 [balance](../balance/) 扩展写入的 `%TEMP%/pi-balance.json`（本扩展不负责产生余额）。

## 安装

```bash
# 任意本地路径（扩展目录）
pi install /absolute/path/to/pi-status

# 相对当前项目
pi install ./pi-status
```

然后在 pi 中 `/reload` 激活。发布到 npm 或 git 后，也可：

```bash
pi install npm:@petrel-cn/pi-status     # 或
pi install git:github.com/petrel-cn/pi-extensions-3-in-1@v1
```

> 扩展拥有完整系统权限。仅安装来源可信的扩展。

## 使用

| 命令 | 作用 |
|------|------|
| `/pi-status` | 显示使用说明（含语言切换方式） |
| `/pi-status en` | 切换为英语（默认） |
| `/pi-status zh` | 切换为中文 |

语言持久化到扩展旁的 `config.json`。

## 状态 JSON 格式

```json
{
  "status": "working",
  "language": "en",
  "summary": { "action": "tool", "name": "npm test -- --watch" },
  "cacheHitRate": 58.8,
  "contextPercent": 15,
  "ts": 1750000000000
}
```

- `summary` 为语义化结构，由悬浮窗按当前 `language` 本地化渲染。
- 原子写入（临时文件 + 重命名），悬浮窗不会读到半截 JSON；重命名因轮询读者正持有该文件而失败时，按短退避（3/10/25 ms）重试。
- Pi 运行期间每 5 秒刷新一次文件时间戳（心跳），消费者无需依赖事件时序即可识别被强杀或崩溃的 pi。

## 语言与国际化

本扩展的命令描述与状态 `language` 字段，与其它扩展采用相同的解析逻辑：

1. `PI_LANG` 环境变量（`zh` 或 `en`）
2. 系统语言 —— POSIX 环境变量（`LANG` / `LC_ALL`）**或** 系统 ICU locale（Windows 上无 `LANG` 时最可靠，如 `zh-CN`）
3. 兜底：**英文**

`language` 字段告知悬浮窗用哪个 locale 渲染摘要。

## 依赖关系

- **弱依赖（不依赖任何扩展）** —— 仅使用 pi 的公开扩展 API 与 Node 内置模块。
- **读取** `%TEMP%/pi-balance.json`（[balance](../balance/) 扩展写入；弱依赖：缺失时显示「余额不可用」）。
- **监听** —— [workspace-guard](../workspace-guard/) 广播的 `pi-status:approval` / `pi-status:approval-end` 事件（弱依赖：缺失时退回启发式检测）。
- **被消费方** —— [pi-status-window](../pi-status-window/) 悬浮窗程序。
- 运行时依赖：`@earendil-works/pi-coding-agent`（由 pi 提供；列出在 `peerDependencies`）。

## 非交互模式行为

本扩展不依赖任何 UI 方法（不使用 `notify` / `setStatus` / `setWidget` / `setFooter`），在 `json` / `print` / `rpc` 模式下状态写入照常工作。

## 兼容性

- pi 版本：已在 `0.84.x` 上测试。
- Node.js：`>= 20`。

## 说明

- 审批状态优先取 [workspace-guard](../workspace-guard/) 的 `pi-status:approval` 事件总线；该扩展缺失时退回危险 bash 命令的启发式检测，及时性较差。
- 余额数据由 [balance](../balance/) 扩展提供，本扩展不查询任何 API。
- 悬浮窗为独立项目，需另行部署。
- 重命名重试使用 `Atomics.wait` 同步休眠，其精度受系统定时器粒度限制（Windows 上实际约 15ms）。极端情况下（连续 3 次都失败）会阻塞主线程约 40~60ms；心跳每 5s 一次，实际无感。

## 许可协议

[MIT](../LICENSE) —— 允许自由使用、修改与再分发。
