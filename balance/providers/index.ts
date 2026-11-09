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
import { fetchWorkbuddyBalance } from "./workbuddy";
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

/** 注册表条目：查询函数 + 是否依赖 API key。Registry entry: fetcher + API-key requirement. */
interface ProviderEntry {
	/** 余额查询函数。Balance fetch function. */
	fetch: BalanceFetcher;
	/** 无 API key 时是否直接判为不可用；本地数据源（如 wb2api）为 false。
	 *  Whether the provider is unusable without an API key; false for local sources. */
	requiresApiKey: boolean;
}

/**
 * 提供商注册表。键为 pi provider id，值为查询函数与认证要求。新提供商在此接入。
 * Provider registry. Key = pi provider id, value = fetch function + auth requirement.
 */
const PROVIDERS: Record<string, ProviderEntry> = {
	deepseek: {
		fetch: (args) => fetchDeepseekBalance(args.apiKey, args.baseUrl, args.signal),
		requiresApiKey: true,
	},
	// WorkBuddy（wb2api 反代网关）：积分从本地面板 /status 或 state.json 读取，无 key 也可用。
	// WorkBuddy (wb2api gateway): credits come from the local panel /status or
	// state.json, so an API key is not a hard requirement.
	workbuddy: {
		fetch: (args) => fetchWorkbuddyBalance(args.apiKey, args.baseUrl, args.signal),
		requiresApiKey: false,
	},
};

/**
 * 使用注册的模块查询指定提供商的余额；未知提供商回退到 stub。
 * Fetch the balance for the given provider using its registered module.
 * Unknown providers fall back to the stub (returns an unsupported error).
 */
export async function fetchBalance(args: ProviderCallArgs): Promise<BalanceResult> {
	const entry = PROVIDERS[args.provider];
	if (!entry) return fetchUnsupportedBalance(args.provider);
	return entry.fetch(args);
}

/** 该提供商是否有专用余额模块。Whether a dedicated balance module exists for the provider. */
export function supportsProvider(provider: string): boolean {
	return provider in PROVIDERS;
}

/** 该提供商的余额查询是否依赖 API key（未知提供商按依赖处理）。
 *  Whether the provider's balance lookup requires an API key (unknown providers: yes). */
export function providerRequiresApiKey(provider: string): boolean {
	return PROVIDERS[provider]?.requiresApiKey ?? true;
}
