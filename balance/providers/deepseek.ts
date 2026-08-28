/**
 * DeepSeek 余额查询模块。DeepSeek balance provider module.
 *
 * 通过官方 API 查询 DeepSeek 账户余额：
 * Queries the DeepSeek account balance via the official API:
 *   GET https://api.deepseek.com/user/balance
 *
 * 响应结构 Response shape:
 *   {
 *     "is_available": true,
 *     "balance_infos": [
 *       { "currency": "CNY", "total_balance": "110.00", "granted_balance": "10.00", "topped_up_balance": "100.00" }
 *     ]
 *   }
 */

/** 单个币种的余额条目。A single currency balance entry. */
export interface BalanceInfo {
	/** API 返回的币种代码，如 "CNY" / "USD"。Currency code as returned by the API. */
	currency: string;
	/** 币种显示符号，如 "￥" / "$"；未知币种回退为原代码。Display symbol for the currency. */
	symbol: string;
	/** 总余额字符串，如 "110.00"。Total balance as a string. */
	amount: string;
}

export type BalanceResult =
	| { ok: true; balances: BalanceInfo[] }
	| { ok: false; error: string };

/** 将币种代码映射为显示符号；未知币种原样显示。Map a currency code to its display symbol. */
export function currencySymbol(currency: string): string {
	switch (currency.toUpperCase()) {
		case "CNY":
			return "￥";
		case "USD":
			return "$";
		default:
			return currency;
	}
}

/**
 * 去掉提供商 base URL 末尾的 "/v1"（或 "/v1/"），以便构造不带版本号的余额端点。
 * Strip a trailing "/v1" (or "/v1/") from a provider base URL so the
 * non-versioned balance endpoint can be constructed.
 */
function stripV1(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "").replace(/\/v1\/?$/, "");
}

/**
 * 查询 DeepSeek 账户余额。Fetch the DeepSeek account balance.
 *
 * @param apiKey  DeepSeek API key（Bearer token）。
 * @param baseUrl 提供商 base URL，如 "https://api.deepseek.com" 或 ".../v1"。
 * @param signal  可选取消信号。Optional AbortSignal for cancellation.
 */
export async function fetchDeepseekBalance(
	apiKey: string,
	baseUrl: string,
	signal?: AbortSignal,
): Promise<BalanceResult> {
	try {
		const url = `${stripV1(baseUrl)}/user/balance`;
		const response = await fetch(url, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			signal,
		});

		if (!response.ok) {
			return { ok: false, error: `HTTP ${response.status}` };
		}

		const data = (await response.json()) as {
			is_available?: boolean;
			balance_infos?: Array<{
				currency?: string;
				total_balance?: string | number;
			}>;
		};

		if (!Array.isArray(data.balance_infos) || data.balance_infos.length === 0) {
			return { ok: false, error: "no balance_infos in response" };
		}

		const balances: BalanceInfo[] = data.balance_infos
			.filter((info) => info.currency && info.total_balance !== undefined && info.total_balance !== null)
			.map((info) => ({
				currency: info.currency as string,
				symbol: currencySymbol(info.currency as string),
				amount: String(info.total_balance),
			}));

		if (balances.length === 0) {
			return { ok: false, error: "empty balance_infos" };
		}

		return { ok: true, balances };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message };
	}
}
