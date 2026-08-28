/**
 * Pi 悬浮状态窗口 —— 状态扩展。Pi floating status window — status extension.
 *
 * 订阅 Pi 的会话/代理/工具事件，将运行状态写入临时目录的状态 JSON，
 * 供 Windows 悬浮窗程序（pi-status-window）轮询显示。
 * Subscribes to Pi session/agent/tool events and writes runtime status to a
 * status JSON in the temp directory, polled by the Windows floating window app.
 *
 * 状态机 State machine:
 *   idle → thinking → working → asking / approval → done
 *
 * 数据面板 Data panel:
 *   cacheHitRate（缓存命中率）· contextPercent（上下文）· balance（余额，由 balance 扩展写入 pi-balance.json）
 *
 * 命令 Commands:
 *   /pi-status      - 显示使用说明（含语言切换方式）show usage (incl. language switch)
 *   /pi-status en   - 切换为英语 switch to English（默认 default）
 *   /pi-status zh   - 切换为中文 switch to Chinese
 *
 * 语言 Language: 默认 en，持久化到扩展目录 config.json。
 * Defaults to "en", persisted to config.json next to the extension.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// 类型 Types
// ---------------------------------------------------------------------------

/** 六种运行状态。Six runtime statuses. */
type StatusKind = "idle" | "thinking" | "working" | "asking" | "approval" | "done" | "closed";

/** 界面语言。Display language. */
type Language = "en" | "zh";

/**
 * 语义化摘要：由悬浮窗按当前语言本地化渲染。
 * Semantic summary; localized by the floating window using the current language.
 */
interface StatusSummary {
	/** 动作类别 action category: idle|thinking|tool|file|output|asking|approval|done */
	action: string;
	/** 相关对象名（工具名/文件名/原因），可省略。Related object name (tool/file/reason), optional. */
	name?: string;
}

/** 写入 %TEMP%/pi-status.json 的载荷。Payload written to %TEMP%/pi-status.json. */
interface StatusPayload {
	/** 当前状态 current status */
	status: StatusKind;
	/** 界面语言 display language */
	language: Language;
	/** 语义化摘要 semantic summary */
	summary: StatusSummary | null;
	/** 缓存命中率（百分比），未知为 null。Cache hit rate (percent), null when unknown. */
	cacheHitRate: number | null;
	/** 上下文占用百分比，未知为 null。Context usage percent, null when unknown. */
	contextPercent: number | null;
	/** 写入时间戳（毫秒）。Write timestamp (ms). */
	ts: number;
}

/** 语言配置。Language config. */
interface StatusConfig {
	language: Language;
}

// ---------------------------------------------------------------------------
// 常量 Constants
// ---------------------------------------------------------------------------

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(EXT_DIR, "config.json");
const STATE_PATH = join(tmpdir(), "pi-status.json");

const DEFAULT_CONFIG: StatusConfig = { language: "en" };

/** 危险命令模式（用于审批状态启发式检测，与 workspace-guard 保持一致）。
 *  Dangerous command patterns (heuristic for approval status, consistent with workspace-guard). */
const DANGEROUS_PATTERNS: Array<{ re: RegExp; label: string }> = [
	{ re: /\brm\s+-rf\b/i, label: "rm -rf" },
	{ re: /\bsudo\b/i, label: "sudo" },
	{ re: /\bchmod\s+777\b/i, label: "chmod 777" },
	{ re: /\bchown\b/i, label: "chown" },
	{ re: /\bmkfs\b/i, label: "mkfs" },
	{ re: /\bdd\s+of=\//i, label: "dd to root" },
	{ re: /\bshutdown\b/i, label: "shutdown" },
	{ re: /\breboot\b/i, label: "reboot" },
];

// ---------------------------------------------------------------------------
// 模块状态 Module state
// ---------------------------------------------------------------------------

let currentStatus: StatusKind = "idle";
let currentLanguage: Language = DEFAULT_CONFIG.language;
let lastSummary: StatusSummary | null = null;
let lastWriteAt = 0;
/** 最近一次写入的指标快照（心跳复用以避免丢失）。Latest metrics snapshot (reused by heartbeat). */
let lastMetrics: Pick<StatusPayload, "cacheHitRate" | "contextPercent"> = {
	cacheHitRate: null,
	contextPercent: null,
};

/** 心跳定时器：Pi 运行期间每 5 秒刷新一次状态文件时间戳，
 *  供悬浮窗检测进程是否存活（心跳停止 → 悬浮窗显示「已关闭」）。
 *  Heartbeat timer: refreshes the status file timestamp every 5 s while Pi
 *  runs, so the floating window can detect liveness (heartbeat stop → closed). */
const HEARTBEAT_MS = 5000;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

// ---------------------------------------------------------------------------
// 配置 Config
// ---------------------------------------------------------------------------

function loadConfig(): StatusConfig {
	try {
		const raw = readFileSync(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<StatusConfig>;
		return { language: parsed.language === "zh" ? "zh" : "en" };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function saveConfig(config: StatusConfig): void {
	try {
		writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
	} catch (error) {
		console.error("[pi-status] failed to save config:", error);
	}
}

// ---------------------------------------------------------------------------
// 状态写入 Status writing
// ---------------------------------------------------------------------------

/** 原子写入：先写临时文件再重命名，避免悬浮窗读到半截 JSON。
 *  Atomic write: write to a temp file then rename, so the floating window never reads partial JSON. */
function writeStateAtomically(payload: StatusPayload): void {
	const tmpPath = `${STATE_PATH}.tmp`;
	try {
		writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
		renameSync(tmpPath, STATE_PATH);
	} catch (error) {
		console.error("[pi-status] failed to write state:", error);
	}
}

/**
 * 计算缓存命中率与上下文占用（复用 balance 扩展的统计写法）。
 * Compute cache hit rate and context usage (mirrors the balance extension's stats logic).
 */
function computeMetrics(ctx: ExtensionContext): Pick<StatusPayload, "cacheHitRate" | "contextPercent"> {
	let input = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let latestCacheHitRate: number | undefined;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			input += usage.input;
			cacheRead += usage.cacheRead;
			cacheWrite += usage.cacheWrite;
			const latestPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			if (latestPromptTokens > 0) {
				latestCacheHitRate = (usage.cacheRead / latestPromptTokens) * 100;
			}
		} else if (
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.usage
		) {
			const usage = entry.message.usage;
			input += usage.input;
			cacheRead += usage.cacheRead;
			cacheWrite += usage.cacheWrite;
		} else if (
			(entry.type === "branch_summary" || entry.type === "compaction") &&
			entry.usage
		) {
			const usage = entry.usage;
			input += usage.input;
			cacheRead += usage.cacheRead;
			cacheWrite += usage.cacheWrite;
		}
	}

	// 汇总缓存命中率：全部 prompt tokens 中 cacheRead 占比。
	// Aggregate cache hit rate: cacheRead share of all prompt tokens.
	const totalPromptTokens = input + cacheRead + cacheWrite;
	const cacheHitRate =
		totalPromptTokens > 0 ? (cacheRead / totalPromptTokens) * 100 : null;

	const contextUsage = ctx.getContextUsage();
	const contextPercent = contextUsage?.percent ?? null;

	return { cacheHitRate, contextPercent };
}

/**
 * 更新状态并写入 JSON。
 * Update the status and write the JSON.
 *
 * 同状态内的文本增量事件（token 级）不落盘以免写风暴；
 * 状态切换、摘要变化或 force 时才写。
 * Token-level text delta events within the same status are not persisted
 * to avoid write storms; only status transitions, summary changes, or
 * force writes occur.
 */
function updateStatus(
	status: StatusKind,
	summary: StatusSummary | null,
	ctx?: ExtensionContext,
	force = false,
): void {
	const statusChanged = status !== currentStatus;
	const summaryChanged = summary != null && !sameSummary(summary, lastSummary);
	if (!statusChanged && !summaryChanged && !force) return;
	currentStatus = status;
	if (summary) lastSummary = summary;

	const now = Date.now();
	const payload: StatusPayload = {
		status,
		language: currentLanguage,
		summary: lastSummary,
		cacheHitRate: null,
		contextPercent: null,
		ts: now,
	};

	if (ctx) {
		const metrics = computeMetrics(ctx);
		payload.cacheHitRate = metrics.cacheHitRate;
		payload.contextPercent = metrics.contextPercent;
		lastMetrics = metrics;
	}

	writeStateAtomically(payload);
	lastWriteAt = now;
}

/**
 * 心跳：复用最近状态与指标，仅刷新时间戳，供悬浮窗检测进程存活。
 * Heartbeat: reuse the latest status & metrics, refresh only the timestamp
 * so the floating window can detect liveness.
 */
function writeHeartbeat(): void {
	writeStateAtomically({
		status: currentStatus,
		language: currentLanguage,
		summary: lastSummary,
		cacheHitRate: lastMetrics.cacheHitRate,
		contextPercent: lastMetrics.contextPercent,
		ts: Date.now(),
	});
}

/** 两个摘要是否相同（用于避免同状态内重复落盘）。
 *  Whether two summaries are equal (avoids redundant writes within a status). */
function sameSummary(a: StatusSummary | null, b: StatusSummary | null): boolean {
	if (a == null && b == null) return true;
	if (a == null || b == null) return false;
	return a.action === b.action && a.name === b.name;
}

// ---------------------------------------------------------------------------
// 摘要构建 Summary builders
// ---------------------------------------------------------------------------

/** 从工具执行参数构建简洁摘要。Build a concise summary from tool args. */
function summaryFromToolArgs(toolName: string, args: unknown): StatusSummary | null {
	if (!args || typeof args !== "object") {
		return { action: "tool", name: toolName };
	}
	const a = args as Record<string, unknown>;

	switch (toolName) {
		case "bash": {
			const command = typeof a.command === "string" ? a.command : "";
			// 截取命令首行前 60 字符作为摘要。First line, capped at 60 chars.
			const firstLine = command.split(/\r?\n/)[0]?.trim() ?? "";
			const snippet = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
			return snippet ? { action: "tool", name: snippet } : { action: "tool", name: "bash" };
		}
		case "read": {
			const p = typeof a.path === "string" ? a.path : "";
			return p ? { action: "read", name: p } : { action: "read", name: "file" };
		}
		case "write": {
			const p = typeof a.path === "string" ? a.path : "";
			return p ? { action: "write", name: p } : { action: "write", name: "file" };
		}
		case "edit": {
			const p = typeof a.path === "string" ? a.path : "";
			return p ? { action: "edit", name: p } : { action: "edit", name: "file" };
		}
		case "grep":
		case "find":
		case "ls": {
			const p = typeof a.path === "string" ? a.path : typeof a.pattern === "string" ? a.pattern : "";
			return p ? { action: "search", name: p } : { action: "search", name: toolName };
		}
		default:
			return { action: "tool", name: toolName };
	}
}

/** 检测 bash 命令是否命中危险模式（启发式进入审批状态）。
 *  Detect whether a bash command hits dangerous patterns (heuristic for approval status). */
function dangerousPatternLabel(command: string): string | undefined {
	for (const { re, label } of DANGEROUS_PATTERNS) {
		if (re.test(command)) return label;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// 扩展入口 Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// ------------------------------------------------------------------
	// 会话生命周期 Session lifecycle
	// ------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		currentLanguage = loadConfig().language;
		currentStatus = "idle";
		lastSummary = { action: "idle" };
		updateStatus("idle", { action: "idle" }, ctx, true);
		// 启动心跳：Pi 运行期间持续刷新时间戳。
		// Start the heartbeat so the floating window sees a live timestamp.
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_MS);
	});

	// 会话关闭（退出/切换/重载）：停止心跳并写入「已关闭」状态。
	// Session shutdown (quit/switch/reload): stop the heartbeat and write a
	// "closed" status so the floating window can show that Pi is offline.
	pi.on("session_shutdown", () => {
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
		currentStatus = "closed";
		lastSummary = { action: "closed" };
		const now = Date.now();
		writeStateAtomically({
			status: "closed",
			language: currentLanguage,
			summary: { action: "closed" },
			cacheHitRate: null,
			contextPercent: null,
			ts: now,
		});
	});

	// ------------------------------------------------------------------
	// 代理生命周期 Agent lifecycle
	// ------------------------------------------------------------------

	// agent_start：进入思考状态（开始处理用户输入）。
	// Agent started: enter thinking state.
	pi.on("agent_start", (_event, ctx) => {
		updateStatus("thinking", { action: "thinking" }, ctx);
	});

	// agent_settled：完全结束（无重试/压缩/队列后续），回到待命状态。
	// Agent fully settled (no retry/compaction/queued continuation): back to idle.
	pi.on("agent_settled", (_event, ctx) => {
		updateStatus("idle", { action: "idle" }, ctx);
	});

	// ------------------------------------------------------------------
	// 流式消息 Message streaming
	// ------------------------------------------------------------------

	// thinking_delta：模型思考中。thinking tokens: thinking status.
	// text_delta：代码/文本输出。text tokens: working status.
	pi.on("message_update", (event, ctx) => {
		const kind = event.assistantMessageEvent.type;
		if (kind === "thinking_delta" || kind === "thinking_start") {
			if (currentStatus !== "thinking") {
				updateStatus("thinking", { action: "thinking" }, ctx);
			}
		} else if (kind === "text_delta" || kind === "text_start") {
			if (currentStatus !== "working") {
				updateStatus("working", { action: "output" }, ctx);
			}
		} else if (kind === "toolcall_start" || kind === "toolcall_delta") {
			if (currentStatus !== "working") {
				updateStatus("working", { action: "tool", name: "…" }, ctx);
			}
		}
	});

	// ------------------------------------------------------------------
	// 工具执行 Tool execution
	// ------------------------------------------------------------------

	// tool_execution_start：工具开始执行 → 工作状态，显示工具名。
	// Tool execution started: working status with the tool name.
	pi.on("tool_execution_start", (event, ctx) => {
		const summary = summaryFromToolArgs(event.toolName, event.args);
		updateStatus("working", summary, ctx);
	});

	// tool_execution_end：工具执行结束 → 回到工作/继续输出。
	// Tool execution finished: stay working.
	pi.on("tool_execution_end", (_event, ctx) => {
		if (currentStatus === "working" || currentStatus === "approval" || currentStatus === "asking") {
			updateStatus("working", { action: "output" }, ctx);
		}
	});

	// ------------------------------------------------------------------
	// 询问与审批 Asking & approval
	// ------------------------------------------------------------------

	// 事件总线协作：workspace-guard 等审批扩展在弹审批框时广播状态。
	// Event-bus collaboration: approval extensions broadcast state while
	// showing their approval dialog.
	pi.events.on("pi-status:approval", (data) => {
		const d = data as { pending?: boolean; reason?: string };
		if (d && d.pending) {
			currentStatus = "approval";
			lastSummary = { action: "approval", name: d.reason || "approval" };
			writeStateAtomically({
				status: "approval",
				language: currentLanguage,
				summary: lastSummary,
				cacheHitRate: null,
				contextPercent: null,
				ts: Date.now(),
			});
		}
	});
	pi.events.on("pi-status:approval-end", () => {
		if (currentStatus === "approval") {
			currentStatus = "working";
			lastSummary = { action: "output" };
			writeStateAtomically({
				status: "working",
				language: currentLanguage,
				summary: lastSummary,
				cacheHitRate: null,
				contextPercent: null,
				ts: Date.now(),
			});
		}
	});

	// ask_question 工具被调用 → 询问状态（Pi 向用户提问）。
	// The ask_question tool is invoked: asking status.
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "ask_question") {
			updateStatus("asking", { action: "asking" }, ctx);
			return;
		}

		// bash 危险命令启发式 → 审批状态（等待用户确认）。
		// Dangerous bash command heuristic: approval status.
		if (event.toolName === "bash") {
			const command = (event.input as { command?: string }).command ?? "";
			const label = dangerousPatternLabel(command);
			if (label) {
				updateStatus("approval", { action: "approval", name: label }, ctx);
			}
		}
	});

	// ------------------------------------------------------------------
	// 命令 Commands
	// ------------------------------------------------------------------

	pi.registerCommand("pi-status", {
		description:
			"Pi 悬浮状态窗口：/pi-status en 切换英语，/pi-status zh 切换中文（默认 en）| Floating status window: /pi-status en for English, /pi-status zh for Chinese (default en)",
		handler: async (args, ctx) => {
			const arg = (args || "").trim().toLowerCase();
			if (arg === "en" || arg === "zh") {
				currentLanguage = arg;
				saveConfig({ language: arg });
				updateStatus(currentStatus, lastSummary, ctx, true);
				const msg =
					arg === "en"
						? "✅ Language switched to English (悬浮窗将显示英文)"
						: "✅ 语言已切换为中文（The floating window will display Chinese）";
				ctx.ui.notify(msg, "info");
				return;
			}

			// 无参数：显示使用说明。No args: show usage.
			const current = currentLanguage === "zh" ? "中文" : "English";
			ctx.ui.notify(
				`📊 Pi 悬浮状态窗口 (Floating Status Window)\n` +
					`当前语言 Current language: ${current}\n\n` +
					`切换语言 Switch language:\n` +
					`  /pi-status en  → English (默认 default)\n` +
					`  /pi-status zh  → 中文\n\n` +
					`状态文件 Status file: ${STATE_PATH}`,
				"info",
			);
		},
	});
}
