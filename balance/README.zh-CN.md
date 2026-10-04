# balance

> 一个在 pi 底部 footer 中显示当前模型提供商账户余额的扩展。

**简体中文** | [English](./README.md)

![在 pi footer 中显示的账户余额](image/balance.jpg)

`balance` 在 pi 的底部 footer 中、紧跟上下文用量指示（如 `16.8%/1.0M (auto)`）之后，显示当前活动模型所属提供商的账户余额。

## 特性

- **footer 显示** —— 在 footer 的统计行、上下文用量指示之后显示余额。
- **模块化后端** —— 前端只负责显示；每个提供商通过分发表实现各自的余额查询。已内置 `deepseek` 模块，其他提供商回退到 stub（显示 `💰 N/A`）。如需显示其他渠道的余额，可自行添加。
- **多币种** —— 货币符号按接口返回自动识别（`CNY → ￥`、`USD → $`）；多币种全部显示，空格分隔。
- **可配置刷新** —— 默认 60s，可通过 `/balance-interval` 选择 30s–300s；持久化到扩展旁的 `config.json`。
- **机器可读输出** —— 额外写入纯金额（无 emoji）到 `%TEMP%/pi-balance.json`，供其他工具或 [pi-status-window](../../pi-status-window/) 悬浮窗消费。
- **稳健的状态写入** —— `%TEMP%/pi-balance.json` 采用原子写入（临时文件 + 重命名）。Windows 上并发轮询的读者会短暂持有该文件，重命名失败时按短退避（3/10/25 ms）重试，而不是直接报错。
- **双语** —— 跟随系统 / `PI_LANG` 语言，兜底英文（见 [语言与国际化](#语言--国际化)）。

## 文件结构

```
balance/
├── index.ts          # 入口：footer 渲染 + 定时刷新 + 模型切换响应 + /balance-interval 命令
├── i18n.ts           # 中英双语字典与 t()
├── config.ts         # 刷新间隔配置读写（默认 60s，钳制 30s–300s）
├── config.json       # 配置持久化（首次运行生成，已 git-ignore）
└── providers/
    ├── index.ts      # 分发表：provider → 查询模块（新提供商在此注册）
    ├── deepseek.ts   # deepseek 余额查询（GET /user/balance，Bearer 认证）
    └── stub.ts       # 其他 provider 占位（返回 unsupported）
```

## 安装

```bash
# 任意本地路径（扩展目录）
pi install /absolute/path/to/balance

# 相对当前项目
pi install ./balance
```

然后在 pi 中 `/reload` 激活。发布到 npm 或 git 后，也可：

```bash
pi install npm:@petrel-cn/balance     # 或
pi install git:github.com/petrel-cn/pi-extensions-3-in-1@v1.1.0
```

> 扩展拥有完整系统权限。仅安装来源可信的扩展。

## 使用

| 命令 | 作用 |
|------|------|
| `/balance-interval` | 交互式设置刷新间隔（30 秒 – 5 分钟）；持久化到 `config.json` |

余额会自动显示在 footer 中。它会随 `session_start` 刷新、按定时器刷新，并在模型（进而提供商）切换时立即刷新。

## 配置

扩展读取自身旁的 `config.json`（首次运行创建）：

```json
{
  "refreshIntervalMs": 60000
}
```

- `refreshIntervalMs` —— 刷新间隔（毫秒）。允许范围 30s–300s；超出会被钳制到该范围。

## 语言与国际化

`balance` 为双语（中文 / 英文），且自包含。语言解析优先级如下：

1. `PI_LANG` 环境变量（`zh` 或 `en`）
2. 系统语言 —— POSIX 环境变量（`LANG` / `LC_ALL`）**或** 系统 ICU locale（Windows 上无 `LANG` 时最可靠，如 `zh-CN`）
3. 兜底：**英文**

查询失败时显示的 `💰 Fetch failed` 文案遵循上述规则：中文显示 `获取失败`、英文显示 `Fetch failed`。非中文用户始终看到英文。

## 依赖关系

- **弱依赖（不依赖任何扩展）** —— `balance` 仅使用 pi 的公开扩展 API 与 Node 内置模块。
- **被消费方** —— 为 [pi-status-window](../../pi-status-window/) 悬浮窗写入 `%TEMP%/pi-balance.json`（弱依赖）；缺失不影响 footer 显示。
- 运行时依赖：`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`（由 pi 提供；列出在 `peerDependencies`）。

## 兼容性

- pi 版本：已在 `0.84.x` 上测试（使用 `setFooter`、`modelRegistry.getProviderAuth`）。
- Node.js：`>= 20`。

## 非交互模式行为

- `ctx.ui.setFooter` 在非 TUI 模式（`json` / `print` / `rpc`）下不渲染，footer 无输出。
- 余额查询、定时刷新与 `%TEMP%/pi-balance.json` 写入不依赖 UI，行为不受影响。

## 说明

- 余额查询为 `GET {baseUrl}/user/balance`；API key 从 pi 的认证存储（`ctx.modelRegistry.getProviderAuth`）解析，不硬编码。
- 查询失败显示警告色的 `💰 获取失败`；无 key 或不支持的提供商显示 `💰 N/A`。
- 缓存命中率按整个会话汇总计算：`cacheRead / (input + cacheRead + cacheWrite)`，与 `pi-status` 一致。

## 实现说明

`balance` 通过 `ctx.ui.setFooter()` **替换**了 pi 的内置 footer。pi 的 footer 是**全局唯一**的，同一时刻只有一份自定义 footer 生效。若其他扩展也调用 `setFooter()`，会互相覆盖（后加载者覆盖先加载者），导致其中一个显示丢失。渲染 footer 的扩展应：在同一个 footer 组件里合作渲染，或明确禁用/替换 `balance`，以免冲突。

## 许可协议

[MIT](../LICENSE) —— 允许自由使用、修改与再分发。
