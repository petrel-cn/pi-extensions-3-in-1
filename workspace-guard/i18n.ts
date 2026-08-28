/**
 * i18n —— workspace-guard 中英双语支持（自包含，不依赖其他扩展）
 *
 * 原则：
 *  - 自包含：本扩展独立携带语言来源与字典，不依赖其他扩展。
 *  - 语言优先级：PI_LANG 环境变量 > config.json（/wsguard lang 写入）> 系统语言 > 兜底英文。
 *  - 兜底英文：任何非中文环境一律显示英文，保证国际用户可用。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Lang = "zh" | "en";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(EXT_DIR, "config.json");

/** 语言字典：zh 与 en 两套，key 完全一致。 */
const messages: Record<Lang, Record<string, string>> = {
  zh: {
    // /wsguard 命令与开关
    "cmd.wsguard.desc":
      "工作区写审批：on 启用 / off 关闭 / status 状态 / lang <zh|en> 切换语言",
    "notify.enabled": "✅ 工作区写审批已启用",
    "notify.disabled": "⏸ 工作区写审批已关闭（写操作不再拦截）",
    "status.desc.env": "（由环境变量 PI_WORKSPACE_GUARD 控制：{value}，state.json 不生效）",
    "status.desc.state.on": "（来自 state.json：开启）",
    "status.desc.state.off": "（来自 state.json：关闭）",
    "status.desc.default": "（默认开启）",
    "status.enabled": "✅ 工作区写审批：开启中（工作区外写操作需审批）{stateDesc}",
    "status.disabled": "⏸ 工作区写审批：已关闭（写操作不拦截）{stateDesc}",
    "notify.lang.zh": "已切换为中文（zh）",
    "notify.lang.en": "已切换为英文（en）",

    // 审批选项
    "opt.allowOnce": "✅ 允许一次",
    "opt.allowSession": "🔄 本次会话允许",
    "opt.deny": "🚫 拒绝",
    "opt.yes": "✅ 允许",
    "opt.no": "🚫 拒绝",

    // write / edit 工作区外写入
    "write.noUI": "工作区外写入被拒绝（无 UI）：{path}",
    "write.selectTitle":
      "⚠️ 写文件目标超出工作区：\n\n📄 {path}\n\n工作区：{cwd}\n\n如何处理？",
    "write.denied": "工作区外写入被用户拒绝：{path}",

    // 危险命令
    "danger.noUI": "危险命令被拒绝（无 UI）：{label}",
    "danger.analyzing": "🔍 正在分析命令作用与风险评估（最多 20 秒）…",
    "danger.riskLine": "{icon} 命令风险：{risk}{reason}",
    "danger.fallbackExplanation": "该命令命中危险模式：{label}，请确认后执行",
    "danger.fallbackRisk":
      "🔴 命令风险：高（命中危险模式：{label}；LLM 评估不可用，保守判定）",
    "danger.selectTitle":
      "⚠️ 危险命令：{label}\n\n📌 命令作用：{explanation}\n\n{riskLine}\n\n命令：{command}\n\n允许执行吗？",
    "danger.denied": "危险命令被用户拒绝：{label}",
    "parenSuffix": "（{reason}）",

    // bash 工作区外写入
    "outside.noUI": "工作区外写入被拒绝（无 UI）：{paths}",
    "outside.effectPrefix": "📌 命令作用：{effect}\n\n",
    "outside.selectTitle":
      "⚠️ 检测到工作区外写入：\n\n{effect}命令：{command}\n\n目标路径：\n{paths}\n\n工作区：{cwd}\n\n如何处理？",
    "outside.denied": "工作区外写入被用户拒绝：{paths}",

    // 风险评估等级显示
    "risk.low": "低",
    "risk.medium": "中",
    "risk.high": "高",

    // LLM 说明的用户消息
    "llm.userContent": "待审批命令：\n{command}",
  },
  en: {
    "cmd.wsguard.desc":
      "Workspace write approval: on enable / off disable / status show / lang <zh|en> switch language",
    "notify.enabled": "✅ Workspace write approval enabled",
    "notify.disabled": "⏸ Workspace write approval disabled (writes no longer intercepted)",
    "status.desc.env": "(controlled by env PI_WORKSPACE_GUARD: {value}; state.json not effective)",
    "status.desc.state.on": "(from state.json: enabled)",
    "status.desc.state.off": "(from state.json: disabled)",
    "status.desc.default": "(enabled by default)",
    "status.enabled": "✅ Workspace write approval: ON (outside-workspace writes require approval) {stateDesc}",
    "status.disabled": "⏸ Workspace write approval: OFF (writes not intercepted) {stateDesc}",
    "notify.lang.zh": "Language switched to Chinese (zh)",
    "notify.lang.en": "Language switched to English (en)",

    "opt.allowOnce": "✅ Allow once",
    "opt.allowSession": "🔄 Allow this session",
    "opt.deny": "🚫 Deny",
    "opt.yes": "✅ Allow",
    "opt.no": "🚫 Deny",

    "write.noUI": "Outside-workspace write rejected (no UI): {path}",
    "write.selectTitle":
      "⚠️ Write target is outside the workspace:\n\n📄 {path}\n\nWorkspace: {cwd}\n\nHow to proceed?",
    "write.denied": "Outside-workspace write denied by user: {path}",

    "danger.noUI": "Dangerous command rejected (no UI): {label}",
    "danger.analyzing": "🔍 Analyzing command effect and risk (up to 20s)…",
    "danger.riskLine": "{icon} Command risk: {risk}{reason}",
    "danger.fallbackExplanation":
      "This command matches a dangerous pattern: {label}. Confirm to proceed.",
    "danger.fallbackRisk":
      "🔴 Command risk: HIGH (matched dangerous pattern: {label}; LLM unavailable, conservative)",
    "danger.selectTitle":
      "⚠️ Dangerous command: {label}\n\n📌 Command effect: {explanation}\n\n{riskLine}\n\nCommand: {command}\n\nAllow execution?",
    "danger.denied": "Dangerous command denied by user: {label}",
    "parenSuffix": " ({reason})",

    "outside.noUI": "Outside-workspace write rejected (no UI): {paths}",
    "outside.effectPrefix": "📌 Command effect: {effect}\n\n",
    "outside.selectTitle":
      "⚠️ Outside-workspace write detected:\n\n{effect}Command: {command}\n\nTarget paths:\n{paths}\n\nWorkspace: {cwd}\n\nHow to proceed?",
    "outside.denied": "Outside-workspace write denied by user: {paths}",

    "risk.low": "Low",
    "risk.medium": "Medium",
    "risk.high": "High",

    "llm.userContent": "Pending approval command:\n{command}",
  },
};

function envLang(): Lang | undefined {
  const v = (process.env.PI_LANG || "").trim().toLowerCase();
  if (v === "zh" || v === "zh-cn" || v === "zh_cn" || v === "cn") return "zh";
  if (v === "en" || v === "en-us" || v === "en-gb" || v === "en_us") return "en";
  return undefined;
}

function persistLang(): Lang | undefined {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      if (cfg.language === "zh" || cfg.language === "en") return cfg.language as Lang;
    }
  } catch (_) {
    /* config 损坏时忽略，走其它来源 */
  }
  return undefined;
}

function systemLangHint(): Lang {
  const sys = (
    process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || process.env.LANGUAGE || ""
  ).toLowerCase();
  if (sys.includes("zh")) return "zh";
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
    if (locale.includes("zh")) return "zh";
  } catch {
    /* ignore */
  }
  return "en";
}

/** 当前语言：环境变量优先，其次持久化，再次系统，兜底英文。 */
let currentLang: Lang = envLang() ?? persistLang() ?? systemLangHint();

/** 当前生效语言。 */
export function getLanguage(): Lang {
  return currentLang;
}

/** 设置并持久化语言（供 /wsguard lang 使用），写入 config.json。 */
export function setLanguage(lang: Lang): void {
  currentLang = lang;
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ language: lang }, null, 2), "utf8");
  } catch (e) {
    console.error(`[workspace-guard] save language failed: ${(e as Error).message}`);
  }
}

/** 按当前语言查表；支持 {name} 占位符插值；缺失时回退英文，再回退 key。 */
export function t(key: string, params?: Record<string, string>): string {
  let s = messages[currentLang]?.[key] ?? messages.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(v);
    }
  }
  return s;
}
