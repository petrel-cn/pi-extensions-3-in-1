/**
 * 余额扩展的配置持久化。Configuration persistence for the balance extension.
 *
 * 将刷新间隔与各提供商的本地数据位置保存在扩展目录旁的 config.json 中。
 * Stores the refresh interval and provider-specific local data locations in
 * config.json next to the extension directory.
 * 刷新间隔默认 60 秒，允许范围 30 秒 – 300 秒。
 * Default interval: 60 seconds. Allowed range: 30s – 300s.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 扩展目录，如 ~/.pi/agent/extensions/balance。Extension directory. */
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(EXTENSION_DIR, "config.json");

/** wb2api-panel 的缺省安装目录；为空表示未配置，需在 config.json 中指定。
 *  Default wb2api-panel directory; empty means unconfigured and must be set in config.json. */
const DEFAULT_PANEL_DIR = "";

/** WorkBuddy（wb2api）余额来源配置。WorkBuddy balance source configuration. */
export interface WorkbuddyConfig {
	/** wb2api-panel 目录（含 config.json、data/state.json）。Panel directory. */
	panelDir: string;
	/** 池状态文件路径；为空表示按面板 config.json 的 `state_file` 解析（相对 panelDir）。
	 *  Pool state file path; empty means resolve the panel's `state_file` (relative to panelDir). */
	stateFile: string;
}

export interface BalanceConfig {
	/** 刷新间隔（毫秒）。Refresh interval in milliseconds. */
	refreshIntervalMs: number;
	/** WorkBuddy 余额来源。WorkBuddy balance source. */
	workbuddy: WorkbuddyConfig;
}

export const DEFAULT_INTERVAL_MS = 60_000;
export const MIN_INTERVAL_MS = 30_000;
export const MAX_INTERVAL_MS = 300_000;

/** /balance-interval 命令可选的刷新间隔（毫秒）。Selectable refresh intervals (ms). */
export const INTERVAL_OPTIONS_MS = [30_000, 60_000, 120_000, 180_000, 300_000];

function clampInterval(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_INTERVAL_MS;
	return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(value)));
}

/** 归一化 WorkBuddy 配置：缺省字段回落到内置默认值。
 *  Normalize the WorkBuddy config, falling back to built-in defaults. */
function normalizeWorkbuddy(value: unknown): WorkbuddyConfig {
	const raw = (value ?? {}) as Partial<WorkbuddyConfig>;
	const panelDir =
		typeof raw.panelDir === "string" && raw.panelDir.trim() ? raw.panelDir.trim() : DEFAULT_PANEL_DIR;
	const stateFile = typeof raw.stateFile === "string" ? raw.stateFile.trim() : "";
	return { panelDir, stateFile };
}

/** 读取已持久化的配置；缺失或非法时返回默认值。Load the persisted config; defaults when missing/invalid. */
export function loadConfig(): BalanceConfig {
	try {
		const raw = readFileSync(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<BalanceConfig>;
		return {
			refreshIntervalMs: clampInterval(parsed.refreshIntervalMs ?? DEFAULT_INTERVAL_MS),
			workbuddy: normalizeWorkbuddy(parsed.workbuddy),
		};
	} catch {
		return { refreshIntervalMs: DEFAULT_INTERVAL_MS, workbuddy: normalizeWorkbuddy(undefined) };
	}
}

/** 持久化配置。Persist the config. */
export function saveConfig(config: BalanceConfig): void {
	try {
		writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
	} catch (error) {
		console.error("[balance] failed to save config:", error);
	}
}
