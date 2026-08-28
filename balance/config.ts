/**
 * 余额扩展的配置持久化。Configuration persistence for the balance extension.
 *
 * 将刷新间隔保存在扩展目录旁的 config.json 中。
 * Stores the refresh interval in config.json next to the extension directory.
 * 默认 60 秒，允许范围 30 秒 – 300 秒。
 * Default: 60 seconds. Allowed range: 30s – 300s.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 扩展目录，如 ~/.pi/agent/extensions/balance。Extension directory. */
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(EXTENSION_DIR, "config.json");

export interface BalanceConfig {
	/** 刷新间隔（毫秒）。Refresh interval in milliseconds. */
	refreshIntervalMs: number;
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

/** 读取已持久化的配置；缺失或非法时返回默认值。Load the persisted config; defaults when missing/invalid. */
export function loadConfig(): BalanceConfig {
	try {
		const raw = readFileSync(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<BalanceConfig>;
		return { refreshIntervalMs: clampInterval(parsed.refreshIntervalMs ?? DEFAULT_INTERVAL_MS) };
	} catch {
		return { refreshIntervalMs: DEFAULT_INTERVAL_MS };
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
