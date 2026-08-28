/**
 * i18n —— balance 中英双语支持（自包含，不依赖其他扩展）
 *
 * 原则：
 *  - 自包含：本扩展独立携带语言来源与字典，不依赖其他扩展。
 *  - 语言优先级：PI_LANG 环境变量 > 系统语言 > 兜底英文。
 *  - 兜底英文：任何非中文环境一律显示英文，保证国际用户可用。
 */
export type Lang = "zh" | "en";

/** 语言字典：zh 与 en 两套，key 完全一致。 */
const messages: Record<Lang, Record<string, string>> = {
	zh: {
		fetchFailed: "获取失败",
	},
	en: {
		fetchFailed: "Fetch failed",
	},
};

function envLang(): Lang | undefined {
	const v = (process.env.PI_LANG || "").trim().toLowerCase();
	if (v === "zh" || v === "zh-cn" || v === "zh_cn" || v === "cn") return "zh";
	if (v === "en" || v === "en-us" || v === "en-gb" || v === "en_us") return "en";
	return undefined;
}

function systemLangHint(): Lang {
	// 优先 POSIX 环境变量（Linux/macOS/CI 常用）。
	// Prefer POSIX env vars (common on Linux/macOS/CI).
	const sys = (
		process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || process.env.LANGUAGE || ""
	).toLowerCase();
	if (sys.includes("zh")) return "zh";
	// 其次系统 ICU locale（Windows 无 LANG 时最可靠，如 zh-CN）。
	// Fall back to the system ICU locale (most reliable on Windows where LANG is unset, e.g. zh-CN).
	try {
		const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
		if (locale.includes("zh")) return "zh";
	} catch {
		/* ignore */
	}
	return "en";
}

/** 当前语言：环境变量优先，其次系统语言，兜底英文。 */
let currentLang: Lang = envLang() ?? systemLangHint();

/** 当前生效语言。 */
export function getLanguage(): Lang {
	return currentLang;
}

/** 按当前语言查表；缺失时回退英文，再回退 key。 */
export function t(key: string): string {
	return messages[currentLang]?.[key] ?? messages.en[key] ?? key;
}
