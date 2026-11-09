/**
 * WorkBuddy（wb2api 反代网关）余额模块。WorkBuddy balance provider module.
 *
 * WorkBuddy 采用积分（credits）制，上游没有货币化余额接口，因此本模块不请求
 * 余额 API，而是读取本地 wb2api-panel 的账号池数据，汇总**可用账号**的积分：
 *   - 首选 `GET {baseUrl}/status`：网关内存态，最实时（含 disabled / paused / credit_floor）
 *   - 回退 `{panelDir}/{state_file}`：面板配置的 state.json（余额刷新任务定时落盘）
 *   - 可用账号 = 未禁用（`!disabled`）且未暂停选号（`!paused`）且积分高于 `credit_floor`
 *
 * WorkBuddy bills in credits and exposes no monetary balance endpoint, so this
 * module sums the credits of *usable* accounts from the local wb2api-panel pool:
 * the gateway's `/status` (live, preferred), falling back to the snapshot file
 * named by the panel's `state_file`. Usable = not disabled, not paused, and
 * above `credit_floor`.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { loadConfig, type WorkbuddyConfig } from "../config";
import type { BalanceResult } from "./deepseek";

/** 面板账号字段（`/status` 与 `state.json` 同名字段）。Panel account fields. */
interface PanelAccount {
	/** 剩余积分。Remaining credits. */
	credits?: number;
	/** 是否已禁用（终态）。Whether the account is disabled (terminal). */
	disabled?: boolean;
	/** 是否暂停选号（运维临时态）。Whether the account is paused out of rotation. */
	paused?: boolean;
}

/** `GET /status` 响应中本模块关心的字段。Fields of `/status` this module needs. */
interface PanelStatusResponse {
	accounts?: PanelAccount[];
	credit_floor?: number;
}

/** `state.json` 中本模块关心的字段。Fields of `state.json` this module needs. */
interface PanelStateFile {
	accounts?: Record<string, PanelAccount>;
}

/** 面板 config.json 中本模块关心的字段。Fields of the panel's config.json. */
interface PanelConfigFile {
	/** 网关 api_key（`/status` 的 Bearer 凭证，可空表示放行）。Gateway api_key. */
	api_key?: string;
	state_file?: string;
	pool?: { credit_floor?: number };
}

/** 可用积分的汇总结果。Summary of usable credits. */
export interface UsableCredits {
	/** 可用账号积分合计。Total credits of usable accounts. */
	credits: number;
	/** 可用账号数。Number of usable accounts. */
	usable: number;
	/** 账号总数。Total number of accounts. */
	total: number;
}

/** 面板配置摘要。Panel config summary. */
interface PanelConfigSummary {
	/** 网关 api_key（可空）。Gateway api_key (may be empty). */
	apiKey: string;
	/** 池状态文件绝对路径。Absolute path of the pool state file. */
	stateFile: string;
	/** 选号积分下限（低于或等于该值的账号不参与派发）。Credit floor for selection. */
	creditFloor: number;
}

/** 把未知异常转成可读信息。Turn an unknown throwable into a readable message. */
function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 去掉 base URL 末尾的斜杠与版本号，得到网关根地址。
 * Strip trailing slashes and a "/v1" suffix from a base URL.
 */
function stripVersion(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * 汇总可用账号积分：跳过禁用、暂停选号、积分不高于下限的账号。
 * Sum the credits of usable accounts, skipping disabled/paused accounts and
 * accounts whose credits do not exceed the floor.
 */
export function sumUsableCredits(accounts: PanelAccount[], creditFloor: number): UsableCredits {
	let credits = 0;
	let usable = 0;
	for (const account of accounts) {
		if (account.disabled || account.paused) continue;
		const remaining = Number(account.credits);
		if (!Number.isFinite(remaining) || remaining <= creditFloor) continue;
		credits += remaining;
		usable += 1;
	}
	return { credits, usable, total: accounts.length };
}

/**
 * 把汇总结果包装成余额结果。积分没有货币符号，符号留空、金额自带 "c" 单位，
 * 前端按 `symbol + amount` 拼接后即为 "4451c"。
 * Wrap the summary into a balance result. Credits have no currency symbol, so
 * the symbol stays empty and the amount carries the "c" unit.
 */
function buildResult(summary: UsableCredits): BalanceResult {
	return {
		ok: true,
		balances: [
			{
				currency: "CREDITS",
				symbol: "",
				amount: `${summary.credits}c`,
			},
		],
	};
}

/**
 * 读取面板 config.json，解析池状态文件路径与选号积分下限。
 * 面板配置缺失或损坏时回退到 `{panelDir}/data/state.json` 与下限 0。
 * Read the panel's config.json to resolve the state file path and the credit
 * floor; fall back to `{panelDir}/data/state.json` and floor 0 on failure.
 */
async function readPanelConfig(panelDir: string): Promise<PanelConfigSummary> {
	const fallbackStateFile = join(panelDir, "data", "state.json");
	try {
		const raw = await readFile(join(panelDir, "config.json"), "utf8");
		const parsed = JSON.parse(raw) as PanelConfigFile;
		const configured = typeof parsed.state_file === "string" ? parsed.state_file.trim() : "";
		const stateFile = configured
			? isAbsolute(configured)
				? configured
				: resolve(panelDir, configured)
			: fallbackStateFile;
		const creditFloor =
			typeof parsed.pool?.credit_floor === "number" ? parsed.pool.credit_floor : 0;
		const apiKey = typeof parsed.api_key === "string" ? parsed.api_key.trim() : "";
		return { apiKey, stateFile, creditFloor };
	} catch {
		return { apiKey: "", stateFile: fallbackStateFile, creditFloor: 0 };
	}
}

/**
 * 通过网关 `GET /status` 查询（实时内存态）。
 * Query the live gateway state via `GET /status`.
 */
async function fetchFromStatus(
	apiKey: string,
	baseUrl: string,
	signal?: AbortSignal,
): Promise<BalanceResult> {
	if (!apiKey || !baseUrl) {
		return { ok: false, error: "missing api key or base url" };
	}
	const url = `${stripVersion(baseUrl)}/status`;
	try {
		const response = await fetch(url, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			signal,
		});
		if (!response.ok) {
			return { ok: false, error: `${url} HTTP ${response.status}` };
		}
		const data = (await response.json()) as PanelStatusResponse;
		if (!Array.isArray(data.accounts)) {
			return { ok: false, error: `no accounts in ${url} response` };
		}
		const creditFloor = typeof data.credit_floor === "number" ? data.credit_floor : 0;
		return buildResult(sumUsableCredits(data.accounts, creditFloor));
	} catch (error) {
		return { ok: false, error: `${url}: ${toMessage(error)}` };
	}
}

/**
 * 通过本地池状态文件查询（网关未启动或密钥不可用时的回退）。
 * Query the local pool state snapshot (fallback when the gateway is down).
 */
async function fetchFromStateFile(
	config: WorkbuddyConfig,
	panel: PanelConfigSummary,
): Promise<BalanceResult> {
	let stateFile = "";
	try {
		const explicit = config.stateFile.trim();
		stateFile = explicit
			? isAbsolute(explicit)
				? explicit
				: resolve(config.panelDir, explicit)
			: panel.stateFile;
		const raw = await readFile(stateFile, "utf8");
		const parsed = JSON.parse(raw) as PanelStateFile;
		const accounts = Object.values(parsed.accounts ?? {});
		if (accounts.length === 0) {
			return { ok: false, error: `no accounts in ${stateFile}` };
		}
		return buildResult(sumUsableCredits(accounts, panel.creditFloor));
	} catch (error) {
		return { ok: false, error: `state file ${stateFile || "(unresolved)"}: ${toMessage(error)}` };
	}
}

/**
 * 查询 WorkBuddy 可用余额：优先实时 `/status`，失败回退本地状态文件。
 * Fetch the usable WorkBuddy balance: live `/status` first, then the local
 * state snapshot as a fallback.
 *
 * @param apiKey  提供商的 api_key（面板 `config.json` 中有 key 时以面板为准）。
 * @param baseUrl 提供商 base URL，如 "http://127.0.0.1:7863/v1"。
 * @param signal  可选取消信号。Optional AbortSignal for cancellation.
 */
export async function fetchWorkbuddyBalance(
	apiKey: string,
	baseUrl: string,
	signal?: AbortSignal,
): Promise<BalanceResult> {
	if (signal?.aborted) {
		return { ok: false, error: "aborted" };
	}
	const config = loadConfig().workbuddy;
	if (!config.panelDir.trim()) {
		return { ok: false, error: "workbuddy.panelDir is not configured" };
	}
	const panel = await readPanelConfig(config.panelDir);
	// 面板 api_key 本地可信，优先用作 `/status` 凭证；缺失时才回退提供商 auth。
	// The panel api_key is locally trusted, so prefer it for `/status`.
	const statusResult = await fetchFromStatus(panel.apiKey || apiKey, baseUrl, signal);
	if (statusResult.ok) return statusResult;

	const fileResult = await fetchFromStateFile(config, panel);
	if (fileResult.ok) return fileResult;

	return { ok: false, error: `status: ${statusResult.error}; ${fileResult.error}` };
}
