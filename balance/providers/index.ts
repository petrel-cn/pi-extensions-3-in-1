/**
 * 余额提供商分发表。Balance provider dispatcher.
 *
 * 模块化设计：前端（index.ts）只询问"当前提供商的余额是多少"，
 * 由本模块将请求路由到对应的提供商模块。
 * Modular design: the frontend (index.ts) only asks "what is the balance
 * for the current provider?" and this module routes the request to the
 * matching provider module.
 * 新增提供商时，实现一个模块（参考 providers/deepseek.ts）并在 PROVIDERS 中注册。
 * Add a new provider by implementing a module (mirroring providers/deepseek.ts)
 * and registering it in PROVIDERS below.
 */

import { fetchDeepseekBalance, type BalanceResult } from "./deepseek";
import { fetchUnsupportedBalance } from "./stub";

export type { BalanceInfo, BalanceResult } from "./deepseek";

/** 传递给每个提供商模块的参数。Arguments passed to every provider module. */
export interface ProviderCallArgs {
	/** 提供商 id，如 "deepseek"。Provider id, e.g. "deepseek". */
	provider: string;
	/** 解析后的 API key（无 key 的提供商可为空）。Resolved API key. */
	apiKey: string;
	/** 提供商 base URL，如 "https://api.deepseek.com"。Provider base URL. */
	baseUrl: string;
	/** 可选取消信号。Optional AbortSignal for cancellation. */
	signal?: AbortSignal;
}

type BalanceFetcher = (args: ProviderCallArgs) => Promise<BalanceResult>;

/**
 * 提供商注册表。键为 pi provider id，值为查询函数。新提供商在此接入。
 * Provider registry. Key = pi provider id, value = fetch function.
 */
const PROVIDERS: Record<string, BalanceFetcher> = {
	deepseek: (args) => fetchDeepseekBalance(args.apiKey, args.baseUrl, args.signal),
};

/**
 * 使用注册的模块查询指定提供商的余额；未知提供商回退到 stub。
 * Fetch the balance for the given provider using its registered module.
 * Unknown providers fall back to the stub (returns an unsupported error).
 */
export async function fetchBalance(args: ProviderCallArgs): Promise<BalanceResult> {
	const fetcher = PROVIDERS[args.provider] ?? fetchUnsupportedBalance;
	return fetcher(args);
}

/** 该提供商是否有专用余额模块。Whether a dedicated balance module exists for the provider. */
export function supportsProvider(provider: string): boolean {
	return provider in PROVIDERS;
}
