# pi-extensions

> 一套为 [pi](https://github.com/earendil-works/pi-coding-agent) 打造的扩展及配套桌面程序合集。

**简体中文** | [English](./README.md)

## 包含内容

| 组件 | 类型 | 说明 |
|------|------|------|
| [balance](./balance/README.md) | pi 扩展 | 在 pi 底部 footer 中显示当前模型提供商的账户余额。 |
| [workspace-guard](./workspace-guard/README.md) | pi 扩展 | 将写文件操作约束在当前工作区内，工作区外写入需审批。 |
| [pi-status](./pi-status/README.md) | pi 扩展 | 将 pi 的实时运行状态以机器可读 JSON 输出。 |
| [pi-status-window](./pi-status-window/README.md) | Windows 程序 | 置顶悬浮窗，在桌面显示 pi 状态（轮询 pi-status 的 JSON）。 |

## 安装

**Git 或 npm（整套）：**

```bash
pi install git:github.com/petrel-cn/pi-extensions@v1
pi install npm:@petrel-cn/pi-extensions
```

**npm（按组件）：**

```bash
pi install npm:@petrel-cn/balance
pi install npm:@petrel-cn/workspace-guard
pi install npm:@petrel-cn/pi-status
```

然后在 pi 中 `/reload` 激活。悬浮窗程序 `pi-status-window` 是独立的 Windows 可执行文件——见其 [README](./pi-status-window/README.md) 自行构建，或从 Releases 页面下载预编译二进制。

> 扩展拥有完整系统权限。仅安装来源可信的扩展。

## 依赖关系

各组件**弱耦合**——每个都能独立工作；缺失某个配套只会让某项功能降级，**不会**拖垮另一个：

```
workspace-guard ──广播审批事件──▶  pi-status ──写 JSON──▶  pi-status-window
balance ──────────写 %TEMP%/pi-balance.json ──▶  pi-status / pi-status-window
```

- **balance** 不依赖任何扩展；其他组件消费它的 `%TEMP%/pi-balance.json`（弱依赖）。
- **workspace-guard** 不依赖任何扩展；它广播 `pi-status:approval` 事件（弱依赖）。
- **pi-status** 无需任何依赖即可运行；它消费 balance 的 JSON 与 workspace-guard 的事件（弱依赖）。
- **pi-status-window** 需要 pi-status（可选 balance）提供数据。

详见各组件的 README。

## 环境要求

- pi 版本：`0.84.x`
- Node.js：`>= 20`
- Windows 10/11（`pi-status-window` 程序需要）

## 许可协议

[MIT](./LICENSE)
