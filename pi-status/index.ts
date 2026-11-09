/**
 * Pi 悬浮状态窗口 —— 状态扩展。Pi floating status window — status extension.
 *
 * 版本：v1.3（与 CHANGELOG.md 顶部一致）
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
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

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
	/** 写入进程 PID，用于多进程下的状态文件归属判定。
	 *  Owning process PID, used for status-file ownership checks across processes. */
	pid: number;
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

/** rename 重试的退避毫秒数（首次失败后最多重试 3 次）。
 *  Windows 上悬浮窗每 300ms 轮询读取 `pi-status.json` 时会短暂持有该文件
 *  （.NET `File.ReadAllText` 的共享模式不含「删除共享」），使覆盖式 rename
 *  瞬时返回 EPERM/EACCES；多实例共用同一 `.tmp` 时还会出现 ENOENT。
 *  读取窗口仅数十微秒，短退避即可几乎必然重试成功。
 *  Backoff delays for rename retries (up to 3 retries after the first failure).
 *  On Windows the floating window's 300 ms polling read briefly holds the file
 *  without delete sharing, so an overwriting rename transiently fails with
 *  EPERM/EACCES; concurrent instances sharing one `.tmp` can also yield ENOENT.
 *  The read window lasts tens of microseconds, so a short backoff suffices. */
const RENAME_RETRY_DELAYS_MS = [3, 10, 25];

/** 可重试的 rename 错误码（均为瞬时占用/竞争，非永久性失败）。
 *  Retryable rename error codes (transient sharing/contention, not permanent). */
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOENT"]);

/** 归属超时：其他进程超过该时长未刷新心跳即视为已退出，状态文件可被接管。
 *  需大于心跳间隔（5 秒），且小于悬浮窗的关闭判定阈值（15 秒）。
 *  Ownership timeout: another process that has not refreshed the heartbeat for
 *  this long is considered gone and its status file may be taken over. Must
 *  exceed the heartbeat interval (5 s) and stay below the window's 15 s close
 *  timeout. */
const OWNER_STALE_MS = 12000;

/** 让位后的冷却时间：避免两个进程在接管临界点反复争抢状态文件。
 *  Cooldown after yielding ownership, so two processes do not keep fighting
 *  over the status file around the takeover boundary. */
const OWNERSHIP_BACKOFF_MS = 10000;

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

/** 本进程是否拥有状态文件（仅主会话拥有；子代理等临时会话永不拥有）。
 *  Whether this process owns the status file (only a primary session does;
 *  ephemeral child sessions never do). */
let ownsDisplay = false;
/** 让位冷却截止时间（毫秒时间戳），冷却期内不再尝试接管。
 *  Timestamp until which takeover attempts pause after yielding ownership. */
let ownershipBackoffUntil = 0;
/** 本进程内是否已有主会话在维护状态文件（同进程多会话时防止互相覆盖）。
 *  Whether a primary session in this process already maintains the status
 *  file (prevents in-process sessions from overwriting each other). */
let primarySessionActive = false;

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

/** 同步休眠缓冲：用 Atomics.wait 实现同步等待，不引入额外依赖。
 *  Buffer for synchronous sleeping via Atomics.wait (no extra dependencies). */
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

/** 同步休眠指定毫秒（阻塞调用线程）。Synchronous sleep of the given ms (blocks the calling thread). */
function sleepSync(ms: number): void {
	Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

/** 判断 rename 失败是否为可重试的瞬时错误。
 *  Whether a rename failure is a retryable transient error. */
function isRetryableRenameError(error: unknown): boolean {
	const code = (error as { code?: string } | null | undefined)?.code;
	return typeof code === "string" && RETRYABLE_RENAME_CODES.has(code);
}

/**
 * 原子写入：先写临时文件再重命名，避免悬浮窗读到半截 JSON。
 * 悬浮窗轮询读取（或多实例共用 `.tmp`）会造成瞬时占用，故对可重试
 * 错误码做短退避重试；全部失败时清理残留临时文件并记录错误。
 * Atomic write: write to a temp file then rename, so the floating window never
 * reads partial JSON. Because the window's polling read (or another instance
 * sharing the `.tmp`) holds the file transiently, retryable error codes are
 * retried with a short backoff; on final failure the leftover temp file is
 * removed and the error is logged.
 */
function writeStateAtomically(payload: StatusPayload): void {
	const tmpPath = `${STATE_PATH}.tmp`;
	const data = JSON.stringify(payload, null, 2);
	let lastError: unknown;

	for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt++) {
		try {
			// 每次重试都重写临时文件：多实例竞争时 `.tmp` 可能已被对方移走。
			// Rewrite the temp file on every attempt: under multi-instance
			// contention the `.tmp` may already have been renamed away.
			writeFileSync(tmpPath, data, "utf8");
			renameSync(tmpPath, STATE_PATH);
			return;
		} catch (error) {
			lastError = error;
			if (!isRetryableRenameError(error)) break;
			if (attempt < RENAME_RETRY_DELAYS_MS.length) sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
		}
	}

	// 清理残留临时文件，避免半成品长期存在；清理失败不掩盖原始错误。
	// Remove the leftover temp file; a cleanup failure must not mask the cause.
	try {
		unlinkSync(tmpPath);
	} catch {
		/* 临时文件可能已不存在。The temp file may already be gone. */
	}
	console.error("[pi-status] failed to write state:", lastError);
}

// ---------------------------------------------------------------------------
// 状态文件归属 Status-file ownership
// ---------------------------------------------------------------------------

/**
 * 构造写盘载荷（统一携带 pid，供归属判定使用）。
 * Build the on-disk payload (always carrying the pid for ownership checks).
 */
function makePayload(
	status: StatusKind,
	summary: StatusSummary | null,
	metrics: Pick<StatusPayload, "cacheHitRate" | "contextPercent">,
): StatusPayload {
	return {
		status,
		language: currentLanguage,
		summary,
		cacheHitRate: metrics.cacheHitRate,
		contextPercent: metrics.contextPercent,
		pid: process.pid,
		ts: Date.now(),
	};
}

/** 状态文件中记录的归属信息。Ownership fields recorded in the status file. */
interface OwnerSnapshot {
	pid: number | undefined;
	ts: number | undefined;
	status: string | undefined;
}

function readOwnerSnapshot(): OwnerSnapshot {
	try {
		const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<StatusPayload>;
		return {
			pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
			ts: typeof parsed.ts === "number" ? parsed.ts : undefined,
			status: typeof parsed.status === "string" ? parsed.status : undefined,
		};
	} catch {
		return { pid: undefined, ts: undefined, status: undefined };
	}
}

/**
 * 本进程能否占用状态文件：文件缺失、属于本进程、已被其他进程释放
 * （closed）或超时未更新时为空闲；否则说明另一个 Pi 进程正在使用它。
 * Whether this process may own the status file: free when the file is missing,
 * already ours, released by another process (closed), or stale; otherwise a
 * live Pi process is using it.
 */
function displayFileAvailable(): boolean {
	const owner = readOwnerSnapshot();
	if (owner.pid === undefined || owner.pid === process.pid) return true;
	if (owner.status === "closed" || owner.ts === undefined) return true;
	return Date.now() - owner.ts >= OWNER_STALE_MS;
}

/**
 * 心跳一次：状态文件空闲时接管；已被其他进程接管时让位并冷却一段时间。
 * One heartbeat tick: claim the file when it is free, keep watching while it
 * belongs to another process, and back off after being superseded.
 */
function heartbeatTick(): void {
	if (Date.now() < ownershipBackoffUntil) return;
	if (!ownsDisplay) {
		if (!displayFileAvailable()) return;
		// 原主人已退出/崩溃：接手显示，从待命态重新开始。
		// Previous owner exited or crashed: take over and restart from idle.
		ownsDisplay = true;
		currentStatus = "idle";
		lastSummary = { action: "idle" };
		writeHeartbeat();
		return;
	}
	if (!displayFileAvailable()) {
		ownsDisplay = false;
		ownershipBackoffUntil = Date.now() + OWNERSHIP_BACKOFF_MS;
		return;
	}
	writeHeartbeat();
}

/**
 * 会话能否成为悬浮窗的主人：交互式（tui/rpc）会话可以；子代理以 print
 * 模式 + 内存会话（无会话文件）运行，不得拥有；持久化的 print/json 会话
 * 保持原有行为。
 * Whether a session may own the floating status: interactive (tui/rpc)
 * sessions may; sub-agent children run in print mode with an in-memory session
 * (no session file) and must not; persisted print/json sessions keep the old
 * behaviour.
 */
function isPrimarySessionCandidate(ctx: ExtensionContext): boolean {
	if (ctx.mode === "tui" || ctx.mode === "rpc") return true;
	try {
		return ctx.sessionManager.getSessionFile() !== undefined;
	} catch {
		return false;
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

	// 非主人会话（如子代理）只维护内存状态，不写全局状态文件，
	// 以免把子会话的进度显示成主会话的状态。
	// Non-owner sessions (e.g. sub-agents) only keep in-memory state; the
	// global status file belongs to the primary session.
	if (!ownsDisplay) return;

	const metrics = ctx
		? computeMetrics(ctx)
		: { cacheHitRate: null, contextPercent: null };
	if (ctx) lastMetrics = metrics;
	const payload = makePayload(status, lastSummary, metrics);
	writeStateAtomically(payload);
	lastWriteAt = payload.ts;
}

/**
 * 心跳：复用最近状态与指标，仅刷新时间戳，供悬浮窗检测进程存活。
 * Heartbeat: reuse the latest status & metrics, refresh only the timestamp
 * so the floating window can detect liveness.
 */
function writeHeartbeat(): void {
	writeStateAtomically(makePayload(currentStatus, lastSummary, lastMetrics));
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
	/**
	 * 本会话是否为主会话：只有主会话才读写全局状态文件。
	 * 子代理以 print 模式 + 内存会话运行（无会话文件），必须跳过，
	 * 否则其 session_start / session_shutdown 会停掉主会话的心跳
	 * 并写入「已关闭」，使悬浮窗误报 Pi 已退出。
	 * Whether this session is the primary one: only the primary session reads
	 * and writes the global status file. Sub-agent children run in print mode
	 * with an in-memory session and must be skipped, otherwise their lifecycle
	 * events would stop the primary heartbeat and write "closed".
	 */
	let isPrimarySession = false;

	// ------------------------------------------------------------------
	// 会话生命周期 Session lifecycle
	// ------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		// 子代理等临时会话：完全不接触全局状态。
		// Ephemeral child sessions never touch the global status.
		if (!isPrimarySessionCandidate(ctx)) {
			isPrimarySession = false;
			return;
		}
		// 同进程内已有其他主会话在维护状态时，本会话只保持旁观。
		// Another primary session in this process already owns the display.
		if (!isPrimarySession && primarySessionActive) {
			isPrimarySession = false;
			return;
		}
		isPrimarySession = true;
		primarySessionActive = true;

		currentLanguage = loadConfig().language;
		// 状态文件无人占用时才接管；被其他 Pi 进程占用时先旁观，待其退出后接手。
		// Claim the file only when it is free; otherwise keep watching and take
		// over once the other Pi process is gone.
		if (displayFileAvailable()) {
			ownsDisplay = true;
			currentStatus = "idle";
			lastSummary = { action: "idle" };
			updateStatus("idle", { action: "idle" }, ctx, true);
		}
		// 启动心跳：Pi 运行期间持续刷新时间戳。
		// Start the heartbeat so the floating window sees a live timestamp.
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = setInterval(() => {
			if (isPrimarySession) heartbeatTick();
		}, HEARTBEAT_MS);
	});

	// 会话关闭（退出/切换/重载）：停止心跳并写入「已关闭」状态。
	// Session shutdown (quit/switch/reload): stop the heartbeat and write a
	// "closed" status so the floating window can show that Pi is offline.
	pi.on("session_shutdown", () => {
		// 子代理等非主人会话：不得清理主会话的心跳，也不得写入「已关闭」。
		// Non-owner sessions must not clear the primary heartbeat or write closed.
		if (!isPrimarySession) return;
		isPrimarySession = false;
		primarySessionActive = false;
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
		if (!ownsDisplay) return;
		ownsDisplay = false;
		// 已被其他 Pi 进程接管时不要写「已关闭」，否则会误报。
		// Do not write closed when another Pi process has taken over the file.
		if (!displayFileAvailable()) return;
		currentStatus = "closed";
		lastSummary = { action: "closed" };
		writeStateAtomically(
			makePayload("closed", { action: "closed" }, { cacheHitRate: null, contextPercent: null }),
		);
	});

	// ------------------------------------------------------------------
	// 代理生命周期 Agent lifecycle
	// ------------------------------------------------------------------

	// agent_start：进入思考状态（开始处理用户输入）。
	// Agent started: enter thinking state.
	pi.on("agent_start", (_event, ctx) => {
		if (!isPrimarySession) return;
		updateStatus("thinking", { action: "thinking" }, ctx);
	});

	// agent_settled：完全结束（无重试/压缩/队列后续），回到待命状态。
	// Agent fully settled (no retry/compaction/queued continuation): back to idle.
	pi.on("agent_settled", (_event, ctx) => {
		if (!isPrimarySession) return;
		updateStatus("idle", { action: "idle" }, ctx);
	});

	// ------------------------------------------------------------------
	// 流式消息 Message streaming
	// ------------------------------------------------------------------

	// thinking_delta：模型思考中。thinking tokens: thinking status.
	// text_delta：代码/文本输出。text tokens: working status.
	pi.on("message_update", (event, ctx) => {
		if (!isPrimarySession) return;
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
		if (!isPrimarySession) return;
		const summary = summaryFromToolArgs(event.toolName, event.args);
		updateStatus("working", summary, ctx);
	});

	// tool_execution_end：工具执行结束 → 回到工作/继续输出。
	// Tool execution finished: stay working.
	pi.on("tool_execution_end", (_event, ctx) => {
		if (!isPrimarySession) return;
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
		if (!isPrimarySession || !ownsDisplay) return;
		const d = data as { pending?: boolean; reason?: string };
		if (d && d.pending) {
			currentStatus = "approval";
			lastSummary = { action: "approval", name: d.reason || "approval" };
			writeStateAtomically(
				makePayload("approval", lastSummary, lastMetrics),
			);
		}
	});
	pi.events.on("pi-status:approval-end", () => {
		if (!isPrimarySession || !ownsDisplay) return;
		if (currentStatus === "approval") {
			currentStatus = "working";
			lastSummary = { action: "output" };
			writeStateAtomically(
				makePayload("working", lastSummary, lastMetrics),
			);
		}
	});

	// ask_question 工具被调用 → 询问状态（Pi 向用户提问）。
	// The ask_question tool is invoked: asking status.
	pi.on("tool_call", (event, ctx) => {
		if (!isPrimarySession) return;
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
