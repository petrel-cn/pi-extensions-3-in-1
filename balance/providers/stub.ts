/**
 * 后备提供商模块：用于尚无专用余额模块的提供商。
 * Fallback provider module used when the active provider has no
 * dedicated balance module yet.
 * 新增提供商应实现自己的模块（参考 deepseek.ts）并在 providers/index.ts 中注册。
 * New providers should implement their own module (see deepseek.ts) and
 * register it in providers/index.ts.
 */

import type { BalanceResult } from "./deepseek";

/**
 * 占位实现——报告该提供商不受支持。
 * Stub implementation — reports that the provider is not supported.
 * 作为占位，使分发表无需在调用处特判未知提供商。
 * Kept as a placeholder so the dispatcher never has to special-case
 * unknown providers at the call site.
 */
export async function fetchUnsupportedBalance(
	_provider: string,
): Promise<BalanceResult> {
	return { ok: false, error: `unsupported provider: ${_provider}` };
}
