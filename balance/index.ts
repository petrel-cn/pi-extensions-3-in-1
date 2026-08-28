/**
 * 账户余额显示扩展。Account balance display extension.
 *
 * 在底部 footer 中显示当前模型所属提供商的账户余额，
 * 紧跟上下文用量指示（如 "0.0%/1.0M (auto)"）之后。
 * Shows the current model provider's account balance in the footer,
 * right after the context-usage indicator (e.g. "0.0%/1.0M (auto)").
 *
 * 模块化设计 Modular design:
 *   - 前端（本文件）：将余额渲染进 footer，定时刷新，并响应模型切换。
 *     Frontend (this file): renders the balance into the footer, schedules
 *     periodic refreshes, and reacts to model changes.
 *   - 后端（providers/）：每个提供商实现各自的余额查询逻辑，
 *     由分发表（providers/index.ts）根据当前 provider 路由。
 *     Backend (providers/): each provider implements its own balance query.
 *     The dispatcher (providers/index.ts) routes by the active provider id.
 *
 * 命令 Commands:
 *   /balance-interval  - 设置刷新间隔（30 秒 – 5 分钟）set the refresh interval (30s – 5min).
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fetchBalance, supportsProvider } from "./providers/index";
import { loadConfig, saveConfig, INTERVAL_OPTIONS_MS } from "./config";
import { t } from "./i18n.ts";

/** 当前余额显示状态。Current balance display state. */
type BalanceKind = "ok" | "unsupported" | "error";

/** 写入 %TEMP%/pi-balance.json 的载荷（供悬浮窗读取）。Payload written to %TEMP%/pi-balance.json. */
interface BalanceStatePayload {
	/** 渲染后的余额文本，如 "💰 ￥110.00"；为空字符串表示无余额。Rendered balance text. */
	balance: string;
	/** 状态类别。Status kind. */
	kind: BalanceKind;
	/** 写入时间戳（毫秒）。Write timestamp (ms). */
	ts: number;
}

/** 悬浮窗读取的余额 JSON 路径。Balance JSON path read by the floating window. */
const BALANCE_STATE_PATH = join(tmpdir(), "pi-balance.json");

export default function (pi: ExtensionAPI) {
	// ------------------------------------------------------------------
	// 模块状态 Module state
	// ------------------------------------------------------------------

	/** 渲染后的余额文本，如 "💰 ￥110.00 $5.00"。为空时不显示。Rendered balance text. */
	let balanceText = "";
	/** 纯金额文本（无 emoji），供悬浮窗 JSON 使用。Plain amount text (no emoji) for the window JSON. */
	let balanceAmount = "";
	/** 余额文本在 footer 中的样式。How to style the balance text in the footer. */
	let balanceKind: BalanceKind = "unsupported";
	/** 定时刷新定时器。Periodic refresh timer. */
	let timer: ReturnType<typeof setInterval> | undefined;
	/** 防止刷新请求重叠。Guards against overlapping refresh requests. */
	let inFlight = false;
	/** 从 setFooter 捕获的 TUI 句柄，用于触发重绘。TUI handle for re-renders. */
	let tuiRef: TUI | undefined;

	/**
	 * 将当前余额状态原子写入 %TEMP%/pi-balance.json，供悬浮窗读取。
	 * 写入纯金额（不含 emoji），避免 GDI+ 渲染乱码。
	 * Atomically write the current balance state for the floating window.
	 * Writes the plain amount (no emoji) to avoid GDI+ rendering artifacts.
	 */
	function writeBalanceState(): void {
		const tmpPath = `${BALANCE_STATE_PATH}.tmp`;
		const payload: BalanceStatePayload = {
			balance: balanceAmount,
			kind: balanceKind,
			ts: Date.now(),
		};
		try {
			writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
			renameSync(tmpPath, BALANCE_STATE_PATH);
		} catch (error) {
			console.error("[balance] failed to write state:", error);
		}
	}

	// ------------------------------------------------------------------
	// 辅助函数（与内置 footer 渲染保持一致）Helpers (mirror the built-in footer)
	// ------------------------------------------------------------------

	function formatTokens(count: number): string {
		if (count < 1000) return count.toString();
		if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
		if (count < 1000000) return `${Math.round(count / 1000)}k`;
		if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
		return `${Math.round(count / 1000000)}M`;
	}

	function formatCwdForFooter(cwd: string, home?: string): string {
		if (!home) return cwd;
		const resolvedCwd = resolve(cwd);
		const resolvedHome = resolve(home);
		const relativeToHome = relative(resolvedHome, resolvedCwd);
		const isInsideHome =
			relativeToHome === "" ||
			(relativeToHome !== ".." &&
				!relativeToHome.startsWith(`..${sep}`) &&
				!isAbsolute(relativeToHome));
		if (!isInsideHome) return cwd;
		return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
	}

	function sanitizeStatusText(text: string): string {
		return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
	}

	// ------------------------------------------------------------------
	// 余额刷新 Balance refresh
	// ------------------------------------------------------------------

	/**
	 * 查询当前活动模型所属提供商的余额并更新显示状态。刷新期间保留上一次的值。
	 * Query the balance for the active model's provider and update the display state.
	 * Keeps the previous value while a refresh is running.
	 */
	async function refreshBalance(ctx: ExtensionContext): Promise<void> {
		if (inFlight) return;
		inFlight = true;
		try {
			const model = ctx.model;
			if (!model) {
				balanceText = "";
				balanceAmount = "";
				balanceKind = "unsupported";
				return;
			}
			const provider = model.provider;
			if (!supportsProvider(provider)) {
				balanceText = "💰 N/A";
				balanceAmount = "";
				balanceKind = "unsupported";
				return;
			}

			// 从 pi 的认证存储中解析提供商的 API key 与 base URL。
			// Resolve the provider's API key and base URL from pi's auth store.
			let apiKey = "";
			let baseUrl = model.baseUrl || "";
			try {
				const auth = await ctx.modelRegistry.getProviderAuth(provider);
				if (auth?.auth?.apiKey) apiKey = auth.auth.apiKey;
				if (auth?.auth?.baseUrl) baseUrl = auth.auth.baseUrl;
			} catch (error) {
				console.log("[balance] auth resolution failed:", error);
			}

			if (!apiKey) {
				balanceText = "💰 N/A";
				balanceAmount = "";
				balanceKind = "unsupported";
				return;
			}

			const result = await fetchBalance({
				provider,
				apiKey,
				baseUrl,
				// 超时保护：请求挂起时自动中断，避免 inFlight 卡死导致刷新永久停止。
				signal: AbortSignal.timeout(10_000),
			});
			if (result.ok) {
				balanceText = `💰 ${result.balances.map((b) => `${b.symbol}${b.amount}`).join(" ")}`;
				balanceAmount = result.balances.map((b) => `${b.symbol}${b.amount}`).join(" ");
				balanceKind = "ok";
			} else {
				balanceText = `💰 ${t("fetchFailed")}`;
				balanceAmount = "";
				balanceKind = "error";
				console.log("[balance] fetch failed:", result.error);
			}
		} finally {
			inFlight = false;
			tuiRef?.requestRender();
			writeBalanceState();
		}
	}

	// ------------------------------------------------------------------
	// Footer
	// ------------------------------------------------------------------

	/**
	 * 安装自定义 footer：复刻内置的三行布局（目录 / 统计+模型 / 扩展状态），
	 * 并在统计行的上下文用量指示之后插入余额。
	 * Install a custom footer that mirrors the built-in three-line layout
	 * (pwd / stats+model / extension statuses) and inserts the balance
	 * right after the context-usage indicator on the stats line.
	 */
	function setupFooter(ctx: ExtensionContext): void {
		ctx.ui.setFooter((tui, theme, footerData) => {
			tuiRef = tui;
			return {
				invalidate() {
					// 空操作：git 分支缓存由 pi 的 FooterDataProvider 负责。
					// No-op: git branch caching is handled by pi's FooterDataProvider.
				},
				render(width: number): string[] {
					// --- 累计用量统计（与内置一致）cumulative usage totals ---
					const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const usage = entry.message.usage;
							totals.input += usage.input;
							totals.output += usage.output;
							totals.cacheRead += usage.cacheRead;
							totals.cacheWrite += usage.cacheWrite;
							totals.cost += usage.cost.total;
						} else if (
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.usage
						) {
							const usage = entry.message.usage;
							totals.input += usage.input;
							totals.output += usage.output;
							totals.cacheRead += usage.cacheRead;
							totals.cacheWrite += usage.cacheWrite;
							totals.cost += usage.cost.total;
						} else if (
							(entry.type === "branch_summary" || entry.type === "compaction") &&
							entry.usage
						) {
							const usage = entry.usage;
							totals.input += usage.input;
							totals.output += usage.output;
							totals.cacheRead += usage.cacheRead;
							totals.cacheWrite += usage.cacheWrite;
							totals.cost += usage.cost.total;
						}
					}

					// --- 汇总缓存命中率（整个会话的 cacheRead 占全部 prompt tokens 比例）。
					// Aggregate cache hit rate: cacheRead share of all prompt tokens in the session.
					const totalPromptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
					const cacheHitRate =
						totalPromptTokens > 0 ? (totals.cacheRead / totalPromptTokens) * 100 : undefined;

					// --- 上下文用量（与内置一致）context usage ---
					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent =
						contextUsage?.percent === null || contextUsage?.percent === undefined
							? "?"
							: contextPercentValue.toFixed(1);

					// --- 目录行 pwd line ---
					let pwd = formatCwdForFooter(
						ctx.sessionManager.getCwd(),
						process.env.HOME || process.env.USERPROFILE,
					);
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					// --- 统计片段 stats parts ---
					const statsParts: string[] = [];
					if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
					if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
					if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
					if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
					if (
						(totals.cacheRead > 0 || totals.cacheWrite > 0) &&
						cacheHitRate !== undefined
					) {
						statsParts.push(`CH${cacheHitRate.toFixed(1)}%`);
					}
					// 订阅制提供商不显示费用（与内置一致，但去掉了扩展无法访问的 modelRuntime 检查）。
					// Subscription-backed providers skip cost display (mirror built-in, minus
					// the modelRuntime check which is not exposed to extensions).
					const usingSubscription = ctx.model ? ctx.model.provider === "kimi-coding" : false;
					if (totals.cost || usingSubscription) {
						statsParts.push(`$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
					}
					// 上下文百分比。"(auto)" 与默认的自动压缩状态保持一致，扩展无法读取该状态。
					// "(auto)" mirrors the default auto-compact state, which extensions cannot read.
					const autoIndicator = " (auto)";
					const contextPercentDisplay =
						contextPercent === "?"
							? `?/${formatTokens(contextWindow)}${autoIndicator}`
							: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
					let contextPercentStr: string;
					if (contextPercentValue > 90) {
						contextPercentStr = theme.fg("error", contextPercentDisplay);
					} else if (contextPercentValue > 70) {
						contextPercentStr = theme.fg("warning", contextPercentDisplay);
					} else {
						contextPercentStr = contextPercentDisplay;
					}
					statsParts.push(contextPercentStr);

					// --- 余额（紧跟上下文用量之后插入）balance ---
					if (balanceText) {
						if (balanceKind === "unsupported") {
							statsParts.push(theme.fg("dim", balanceText));
						} else if (balanceKind === "error") {
							statsParts.push(theme.fg("warning", balanceText));
						} else {
							statsParts.push(balanceText);
						}
					}

					// --- 右侧：模型名 + 提供商/思考等级 right side ---
					const modelName = ctx.model?.id || "no-model";
					let rightSideWithoutProvider = modelName;
					if (ctx.model?.reasoning) {
						const thinkingLevel = ctx.thinkingLevel || "off";
						rightSideWithoutProvider =
							thinkingLevel === "off"
								? `${modelName} • thinking off`
								: `${modelName} • ${thinkingLevel}`;
					}
					let rightSide = rightSideWithoutProvider;
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
					}

					// --- 组装统计行（与内置一致）compose stats line ---
					let statsLeft = statsParts.join(" ");
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}
					const minPadding = 2;
					if (
						footerData.getAvailableProviderCount() > 1 &&
						ctx.model &&
						statsLeftWidth + minPadding + visibleWidth(rightSide) > width
					) {
						rightSide = rightSideWithoutProvider;
					}
					const rightSideWidth = visibleWidth(rightSide);
					const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
					let statsLine: string;
					if (totalNeeded <= width) {
						const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
						statsLine = statsLeft + padding + rightSide;
					} else {
						const availableForRight = width - statsLeftWidth - minPadding;
						if (availableForRight > 0) {
							const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
							const truncatedRightWidth = visibleWidth(truncatedRight);
							const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
							statsLine = statsLeft + padding + truncatedRight;
						} else {
							statsLine = statsLeft;
						}
					}
					const dimStatsLeft = theme.fg("dim", statsLeft);
					const remainder = statsLine.slice(statsLeft.length);
					const dimRemainder = theme.fg("dim", remainder);
					const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
					const lines = [pwdLine, dimStatsLeft + dimRemainder];

					// --- 扩展状态区（保留 "⏸ plan" 等）extension statuses ---
					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const sortedStatuses = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text));
						lines.push(truncateToWidth(sortedStatuses.join(" "), width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	}

	// ------------------------------------------------------------------
	// 定时器 Timer
	// ------------------------------------------------------------------

	function restartTimer(ctx: ExtensionContext): void {
		if (timer) clearInterval(timer);
		const interval = loadConfig().refreshIntervalMs;
		timer = setInterval(() => {
			void refreshBalance(ctx);
		}, interval);
	}

	// ------------------------------------------------------------------
	// 生命周期 Lifecycle
	// ------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		setupFooter(ctx);
		await refreshBalance(ctx);
		restartTimer(ctx);
	});

	pi.on("session_shutdown", () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		tuiRef = undefined;
	});

	// 模型（进而提供商）切换时立即刷新。
	// Refresh immediately when the model (and therefore provider) changes.
	pi.on("model_select", async (_event, ctx) => {
		void refreshBalance(ctx);
	});

	// ------------------------------------------------------------------
	// 命令 Command
	// ------------------------------------------------------------------

	pi.registerCommand("balance-interval", {
		description: "设置余额刷新间隔（30 秒 – 5 分钟）Set the balance refresh interval (30s – 5min)",
		handler: async (_args, ctx) => {
			const config = loadConfig();
			const options = INTERVAL_OPTIONS_MS.map((ms) => {
				const label = ms >= 60000 ? `${ms / 60000} 分钟 (min)` : `${ms / 1000} 秒 (sec)`;
				return ms === config.refreshIntervalMs ? `${label}（当前 current）` : label;
			});
			const choice = await ctx.ui.select("选择余额刷新间隔 Balance refresh interval:", options);
			if (!choice) return;
			const index = options.indexOf(choice);
			if (index < 0) return;
			const newMs = INTERVAL_OPTIONS_MS[index];
			saveConfig({ refreshIntervalMs: newMs });
			restartTimer(ctx);
			ctx.ui.notify(`余额刷新间隔 Balance refresh interval: ${newMs / 1000} 秒 (s)`, "info");
		},
	});
}
