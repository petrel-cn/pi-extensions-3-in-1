/**
 * workspace-guard 核心逻辑（纯函数，无 pi 依赖，便于单元测试）
 *
 * 职责：
 *  - isPathAllowed: 判断目标路径是否位于允许目录内
 *  - scopeForTarget / isWithinScopes: 「本次会话允许」的放行范围计算与匹配
 *  - extractWriteTargetInfo: 从 bash 命令中提取写入目标（含 path/kind），
 *    extractWriteTargets 为只取路径的兼容壳；PowerShell 侧同构
 *  - DANGEROUS_PATTERNS: 危险 bash 命令模式（中英双语标签）
 *  - explainCommand: 以自然语言说明 bash 命令的作用（本地模板，中英双语）
 *  - clampLines / clampChars: 审批框内容裁剪（固定行数策略 + 长文本字符上限，不做宽度预估）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 支持的语言。 */
export type Lang = "zh" | "en";

/**
 * 规范化并判断 target 是否位于任一允许目录内（含允许目录本身）。
 * Windows 下不区分大小写。
 */
export function isPathAllowed(target: string, allowedDirs: string[]): boolean {
  const resolved = path.resolve(target);
  const norm = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return allowedDirs.some((dir) => {
    const d = path.resolve(dir);
    const dn = process.platform === "win32" ? d.toLowerCase() : d;
    const prefix = dn.endsWith(path.sep) ? dn : dn + path.sep;
    return norm === dn || norm.startsWith(prefix);
  });
}

/**
 * 将 Git Bash / MSYS 风格路径（/d/foo/bar）转换为 Windows 路径（D:/foo/bar），
 * 避免 Node path 模块把 /d/... 错误解析为 <当前盘>:\d\...。非该格式或非 Windows 平台原样返回。
 */function toWindowsPath(p: string): string {
  if (process.platform !== "win32") return p;
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(p);
  if (m) return `${m[1].toUpperCase()}:/${m[2]}`;
  return p;
}

// ---------- 会话放行范围（「本次会话允许」的粒度计算） ----------

/** 会话放行范围：目录级（含全部子目录）或单文件级。 */
export interface SessionScope {
  level: "dir" | "file";
  /** 规范化键（绝对路径，Windows 下小写）：用于写集合与匹配 */
  value: string;
  /** 展示用路径（保留原始大小写）：仅用于界面文案 */
  display: string;
}

/** 路径规范化：绝对化 + Windows 下统一小写（与 isPathAllowed 的判定口径一致）。 */
export function normPath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 相对盘符根/UNC 根的路径深度：根为 0，一级目录（如 D:\aaa）为 1。 */
export function pathDepth(p: string): number {
  const resolved = path.resolve(p);
  const root = path.parse(resolved).root;
  return path.relative(root, resolved).split(path.sep).filter(Boolean).length;
}

/** 路径是否已存在且为目录（任何错误一律视为非目录）。 */
export function isExistingDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 目录路径补尾分隔符（仅用于界面显示，统一用正斜杠）。 */
export function withTrailingSep(p: string): string {
  return p.endsWith(path.sep) || p.endsWith("/") ? p : `${p}/`;
}

/**
 * 计算写入目标对应的会话放行范围：
 *  - 目标本身是目录（kind=dir / 路径以分隔符结尾 / 已存在的目录）→ 取该目录，不取父目录
 *  - 否则取父目录
 *  - 盘符根、UNC 根与一级目录（如 D:\ 与 D:\aaa）目录级放行过宽 → 降级为仅该文件
 */
export function scopeForTarget(target: string, kind: WriteTargetKind): SessionScope {
  const resolved = path.resolve(target);
  const asDir = kind === "dir" || /[\\/]$/.test(target) || isExistingDir(resolved);
  const candidate = asDir ? resolved : path.dirname(resolved);
  if (pathDepth(candidate) <= 1) {
    return { level: "file", value: normPath(resolved), display: resolved };
  }
  return { level: "dir", value: normPath(candidate), display: candidate };
}

/** 范围去重（同一目录/文件只保留一份），保持首次出现顺序。 */
export function dedupeScopes(scopes: SessionScope[]): SessionScope[] {
  const seen = new Set<string>();
  const out: SessionScope[] = [];
  for (const scope of scopes) {
    const key = `${scope.level}:${scope.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(scope);
  }
  return out;
}

/**
 * 目标是否落在给定的会话放行范围内。
 * 目录级按路径分隔符定界（避免 D:\aaa 误匹配 D:\aaa-evil），文件级精确匹配。
 */
export function isWithinScopes(
  target: string,
  dirScopes: Iterable<string>,
  fileScopes: Iterable<string>,
): boolean {
  const n = normPath(target);
  for (const file of fileScopes) {
    if (n === file) return true;
  }
  for (const dir of dirScopes) {
    if (n === dir || n.startsWith(dir + path.sep)) return true;
  }
  return false;
}

/** 写入目标的类型提示：目录 / 文件 / 无法判定（调用方可用 fs 探测兜底）。 */
export type WriteTargetKind = "file" | "dir" | "unknown";

/** 带类型提示的写入目标。 */
export interface WriteTarget {
  /** 绝对路径（相对路径已按 cwd 解析） */
  path: string;
  /** 类型提示：同一路径多来源命中时取更保守者（dir > unknown > file） */
  kind: WriteTargetKind;
}

/** kind 合并优先级，数字越小越保守（对应的放行范围越小）。 */
const KIND_RANK: Record<WriteTargetKind, number> = { dir: 0, unknown: 1, file: 2 };

/**
 * 一次写入目标扫描的结果。
 *  - targets：可静态判定的目标（路径 + 类型提示）
 *  - unjudgeable：含变量/命令替换/无法解析的 ~，无法静态判定的原始 token
 *    调用方应对其发起审批（看不到目标就不应静默放行），而不是当作「无写入」
 */
export interface WriteTargetScan {
  targets: WriteTarget[];
  unjudgeable: string[];
}

/**
 * 无法静态判定的形式：$VAR、${VAR}、$1、$(...)、反引号命令替换、%VAR%（cmd 风格）。
 * 命中即记入 unjudgeable 并审批，不再静默丢弃。
 */
const UNJUDGEABLE_RE = /\$[A-Za-z_{0-9(@]|`|%[A-Za-z_][A-Za-z0-9_]*%/;

/** 纯符号 token（输入重定向的 < 、管道残留等）不是路径。 */
const SYMBOL_ONLY_RE = /^[<>|&;]+$/;

/**
 * 展开开头的 ~ 为用户主目录：`~`、`~/x`、`~\x` → <home>/x。
 * `~other/x`（其他用户家目录）无法解析时返回 undefined，由调用方按无法判定处理。
 */
export function expandTilde(p: string): string | undefined {
  if (!p.startsWith("~")) return p;
  if (p === "~") return os.homedir();
  if (/^~[\\/]/.test(p)) return path.join(os.homedir(), p.slice(2));
  return undefined;
}

/** 各文件操作命令的写目标类型提示（未列出的按 unknown 处理）。 */
const BASH_TARGET_KIND: Record<string, WriteTargetKind> = {
  mkdir: "dir",
  touch: "file",
  tee: "file",
  cp: "unknown",
  mv: "unknown",
  rm: "unknown",
  ln: "unknown",
  install: "unknown",
};

/**
 * cd 类命令（bash 的 cd/chdir 与 PowerShell 的 Set-Location 及其别名 sl）：
 * 出现在段首时才可推断作用范围。后向断言要求其后为空白、行尾或引号，
 * 避免把 `cd-notes.txt` 这类文件名误判为命令。
 */
const CD_VERB_RE = /^\(?\s*(?:cd|chdir|set-location|sl)(?=\s|$|["'])/i;

/** 目录栈类命令（pushd/popd 等）：目标依赖运行时栈状态，一律按无法判定处理。 */
const CD_STACK_VERB_RE = /^\(?\s*(?:pushd|popd|push-location|pop-location)(?=\s|$|["'])/i;

/** 段内任意位置出现的 cd 类命令：不在段首时无法可靠推断作用范围。 */
const CD_ANYWHERE_RE =
  /\b(?:cd|chdir|set-location|sl|pushd|popd|push-location|pop-location)\b(?=\s|$|["'])/i;

/**
 * 引号包裹的 cd 类命令（如 `& 'Set-Location' ..`）：引用调用时命令名不能靠去引号后的
 * 文本识别，只要出现这种形态就按「含 cd 类命令」处理。
 */
const CD_QUOTED_VERB_RE = /["'](?:cd|chdir|set-location|sl)["'](?=\s|$)/i;

/** 候选基准数量上限：超过即视为无法判定（避免连续 cd 导致候选集指数膨胀）。 */
const MAX_CD_BASES = 8;

/** 是否为管道分隔符（|、|&、&|）：管道右侧在子进程中执行，其中的 cd 不改变父 shell 的当前目录。 */
function isPipeSeparator(sep: string): boolean {
  return sep === "|" || sep === "|&" || sep === "&|";
}

/** 去掉引号包裹的内容（用于「段内任意位置出现 cd」这类宽松判定，避免把引号里的文字当命令）。 */
function stripQuotedSpans(text: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 计算某一段命令执行后「当前目录」的候选集合，供后续段解析相对路径。
 *  - 返回 undefined：本段不是 cd 类命令，基准不变
 *  - 返回 null：cd 目标无法静态确定（cd -、cd $X、pushd、裸 cd、单根式 /tmp 等），
 *    后续段的相对目标必须按无法判定处理，不能静默放行
 *  - 返回集合：候选当前目录。cd 可能失败（目录不存在/不是目录/无权限）而使当前目录
 *    保持不变，此时原基准与新目标同为候选；任一候选解析到工作区外都要审批。
 */
function cdCandidatesAfterSegment(
  segment: string,
  bases: ReadonlySet<string>,
): Set<string> | null | undefined {
  const text = segment.trim();
  if (!text) return undefined;

  if (CD_STACK_VERB_RE.test(text)) return null;
  const verb = CD_VERB_RE.exec(text);
  if (!verb) {
    // 段中非段首处出现 cd：作用范围无法推断（子 shell、命令替换、引用调用等），按无法判定处理
    if (CD_ANYWHERE_RE.test(stripQuotedSpans(text)) || CD_QUOTED_VERB_RE.test(text)) return null;
    return undefined;
  }

  let rest = text.slice(verb[0].length).trim();
  // PowerShell 命名参数：Set-Location -Path X / -LiteralPath X
  rest = rest.replace(/^-(?:literal)?path\b\s*[:=]?\s*/i, "");
  if (!rest) return null; // 无参数：目标为家目录，静态不可知
  // 过滤 - 开头的选项：`cd -` 过滤后为空，落到下面的「无法静态判定」分支
  const tokens = tokenizeQuoted(rest).filter((tok) => tok && !tok.startsWith("-"));
  if (tokens.length !== 1) return null; // 多参数（含过滤后为空）：无法静态判定
  const arg = toWindowsPath(stripQuotes(tokens[0]));
  if (!arg) return null;
  const expanded = expandTilde(arg);
  if (expanded === undefined || UNJUDGEABLE_RE.test(expanded)) return null;
  // 单根式路径（/tmp、/usr 等 MSYS 风格）：Windows 下无法静态映射到具体盘符，不做猜测
  if (/^[\\/](?![\\/])/.test(expanded)) return null;
  const resolvedList = path.isAbsolute(expanded)
    ? [path.resolve(expanded)]
    : [...bases].map((b) => path.resolve(b, expanded));
  if (resolvedList.length === 0) return null; // 基准未知且目标为相对路径

  const out = new Set<string>();
  for (const dir of resolvedList) {
    out.add(dir);
    // cd 到不存在的目录会失败，当前目录保持不变：原基准仍是可能落点
    if (!isExistingDir(dir)) for (const b of bases) out.add(b);
  }
  if (out.size > MAX_CD_BASES) return null; // 候选过多：不再细分，按无法判定处理
  return out;
}

/**
 * 从 bash 命令中扫描可能写入/修改的目标路径及其类型提示（相对当前目录解析，绝对路径原样返回）。
 * 实用级解析：识别输出重定向（>、>>）、常见文件操作命令（cp/mv/rm/mkdir/touch/tee/install/dd/ln）的目标参数。
 * 引号感知：引号内的符号不参与匹配，引号内的目标路径原样保留（修复占位符破坏带引号路径的问题）。
 * 开头的 ~ 展开为当前用户主目录；含变量/命令替换/无法解析的 ~ 的目标记入 unjudgeable（供上层审批）。
 * 逐段推进：命令中的 cd 会改变后续段的解析基准（管道中的 cd 不改父 shell，忽略）；
 * cd 目标不存在时原基准与新目标同为候选，任一候选落在工作区外都要审批；
 * cd 目标无法静态确定时基准集合置空，其后段的相对路径目标一律记入 unjudgeable。
 */
export function scanBashWriteTargets(command: string, cwd: string): WriteTargetScan {
  const targets: WriteTarget[] = [];
  const unjudgeable: string[] = [];
  const index = new Map<string, number>();
  const seenUnknown = new Set<string>();

  // 记录一个已解析的目标：同一路径多来源命中时保留更保守的类型（放行范围更小）
  const record = (resolved: string, kind: WriteTargetKind) => {
    const at = index.get(resolved);
    if (at === undefined) {
      index.set(resolved, targets.length);
      targets.push({ path: resolved, kind });
      return;
    }
    if (KIND_RANK[kind] < KIND_RANK[targets[at].kind]) targets[at].kind = kind;
  };

  // 记入「无法静态判定」：由上层强制审批
  const markUnknown = (raw: string) => {
    if (!seenUnknown.has(raw)) {
      seenUnknown.add(raw);
      unjudgeable.push(raw);
    }
  };

  // bases：解析相对路径的候选当前目录集合；空集表示当前目录已无法静态确定
  const push = (raw: string, kind: WriteTargetKind, bases: ReadonlySet<string>) => {
    const t = toWindowsPath(stripQuotes(raw.trim())); // Git Bash 的 /d/... 转为 D:/...
    if (!t) return;
    if (t.startsWith("&")) return; // 文件描述符重定向如 2>&1
    if (SYMBOL_ONLY_RE.test(t)) return; // 输入重定向的 < 等纯符号 token
    const expanded = expandTilde(t);
    // 含变量/命令替换/无法解析的 ~：不能当作「无写入」，记入 unjudgeable 交给上层审批
    if (expanded === undefined || UNJUDGEABLE_RE.test(expanded)) return markUnknown(t);
    // 设备文件不视为磁盘写入：/dev/*（/dev/null 等）、Windows 的 nul
    if (/^(\/dev\/|nul$)/i.test(expanded)) return;
    if (path.isAbsolute(expanded)) {
      record(expanded, kind);
      return;
    }
    // 相对路径：对每个候选基准各解析一次（任一落在工作区外，上层都会要求审批）
    if (bases.size === 0) return markUnknown(t);
    for (const base of bases) record(path.resolve(base, expanded), kind);
  };

  // 按段推进：cd 只对「之后」的段生效，管道中的 cd 不改变父 shell 的当前目录
  let bases: Set<string> = new Set([cwd]);
  let prevSep = "";
  for (const { seg, sepAfter } of splitCommandSegmentsWithSeparator(command)) {
    const piped = isPipeSeparator(prevSep) || isPipeSeparator(sepAfter);

    // 1) 输出重定向目标（引号感知）：> / >> 后的 token，同时剥离重定向部分得到清理后的命令
    const { targetTokens, cleaned } = scanAndStripRedirects(seg);
    for (const t of targetTokens) push(t, "file", bases);

    // 2) 文件操作命令的目标参数：cp/mv/rm/mkdir/touch/tee/install/ln
    for (const part of splitCommandSegments(cleaned)) {
      const match = part.match(/\b(cp|mv|rm|mkdir|touch|tee|install|ln)\b(?:\s+-\S+)*\s+(.+)$/);
      if (!match) continue;
      const tokens = tokenizeQuoted(match[2]).filter((t) => t && !t.startsWith("-"));
      if (tokens.length === 0) continue;
      // 写目标范围：cp/ln 仅最后一个参数是写入目标（前面为只读源/链接指向）；
      // mv/rm/mkdir/touch/tee/install 的全部参数都涉及文件系统修改，全部检查（避免漏检多目标命令）
      const verb = (match[0].match(/\b(cp|mv|rm|mkdir|touch|tee|install|ln)\b/) || [])[1] || "";
      const toCheck = verb === "cp" || verb === "ln" ? [tokens[tokens.length - 1]] : tokens;
      const kind: WriteTargetKind = BASH_TARGET_KIND[verb] ?? "unknown";
      for (const t of toCheck) push(t, kind, bases);
    }

    // 3) dd 特殊：目标在 of= 参数
    const ddRe = /\bdd\b[^|;&]*?\bof=([^\s]+)/;
    const ddMatch = ddRe.exec(cleaned);
    if (ddMatch) push(ddMatch[1], "file", bases);

    // 4) 本段若是 cd 类命令，更新后续段的候选基准（管道中的 cd 不生效）
    const next = cdCandidatesAfterSegment(seg, bases);
    if (!piped) {
      // || 两侧都可能执行：两个分支的候选基准都要保留
      const branchy = prevSep === "||" || sepAfter === "||";
      if (next === null) bases = new Set();
      else if (next) {
        const merged = branchy ? new Set([...bases, ...next]) : next;
        bases = merged.size > MAX_CD_BASES ? new Set() : merged;
      }
    }
    prevSep = sepAfter;
  }

  return { targets, unjudgeable };
}

/** 兼容壳：仅返回可静态判定的目标（路径 + 类型提示）。 */
export function extractWriteTargetInfo(command: string, cwd: string): WriteTarget[] {
  return scanBashWriteTargets(command, cwd).targets;
}

/** 兼容壳：仅返回可静态判定的目标路径数组。 */
export function extractWriteTargets(command: string, cwd: string): string[] {
  return scanBashWriteTargets(command, cwd).targets.map((t) => t.path);
}

// ---------- PowerShell 支持 ----------

/** PowerShell 危险模式：删除/销毁/代码执行类，命中即审批（不看目标路径），与 bash 的 DANGEROUS_PATTERNS 同策略。 */
export const DANGEROUS_POWERSHELL_PATTERNS: { re: RegExp; label: { zh: string; en: string } }[] = [
  {
    re: /\bRemove-[A-Za-z]+\b/i,
    label: { zh: "Remove-* 删除类 cmdlet", en: "Remove-* delete cmdlet" },
  },
  {
    re: /\bClear-(Content|Disk|RecycleBin)\b/i,
    label: { zh: "Clear-* 清空文件/磁盘", en: "Clear-* wipe file/disk" },
  },
  {
    re: /\b(Format-Volume|Initialize-Disk)\b/i,
    label: { zh: "格式化/初始化磁盘", en: "Format/initialize disk" },
  },
  {
    re: /\b(rd|rmdir|del|erase)\b/i,
    label: { zh: "del/rd/rmdir 删除", en: "del/rd/rmdir delete" },
  },
  {
    re: /\[(System\.)?IO\.(File|Directory)\]::Delete/i,
    label: { zh: ".NET Delete() 删除文件/目录", en: ".NET Delete() file/directory" },
  },
  {
    re: /\bInvoke-Expression\b/i,
    label: { zh: "Invoke-Expression 动态执行字符串", en: "Invoke-Expression eval" },
  },
  {
    re: /\bStop-Process\b/i,
    label: { zh: "Stop-Process 结束进程", en: "Stop-Process kill" },
  },
];

/** PowerShell 写文件类 cmdlet（用于工作区内/外判定）。 */
export const POWERSHELL_WRITE_RE =
  /\b(Set-Content|Add-Content|Out-File|Move-Item|Rename-Item|Copy-Item|New-Item|Set-ItemProperty|New-ItemProperty|Expand-Archive|Compress-Archive|mkdir)\b/i;

/**
 * 推导 PowerShell 命令的写入类型提示：
 *  - `mkdir` / `New-Item -ItemType Directory` → dir（放行目标目录自身）
 *  - `Set-Content` / `Out-File` 等文件写入 cmdlet → file
 *  - `Copy-Item` / `Move-Item` / `Rename-Item` / `Expand-Archive` 等（目标可为目录）→ unknown
 */
function powershellWriteKind(command: string): WriteTargetKind {
  if (/\bmkdir\b/i.test(command)) return "dir";
  if (/\bNew-Item\b[^|;]*?-ItemType\s+['"]?(Directory|dir)['"]?/i.test(command)) return "dir";
  if (/\b(Set-Content|Add-Content|Out-File|Set-ItemProperty|New-ItemProperty)\b/i.test(command)) {
    return "file";
  }
  return "unknown";
}

/**
 * 从 PowerShell 命令中扫描可能写入的目标路径及其类型提示（相对路径按 cwd 解析）。
 * 来源：输出重定向（> / >>）、-Path/-LiteralPath/-FilePath/-OutFile/-Destination/-Target 参数值、
 * 引号内含分隔符的字符串、盘符/UNC/MSYS 绝对路径、以 .. 逃逸的相对路径。
 * 开头的 ~ 展开为用户主目录；含变量（$env:X、$x）、环境变量（%X%）、命令替换的目标
 * 记入 unjudgeable（供上层审批），不再静默丢弃。
 * 命令含 -Destination / -Target 时只取该参数值——Copy-Item/Move-Item 的源不是写入目标。
 */
export function scanPowerShellWriteTargets(command: string, cwd: string): WriteTargetScan {
  const targets: WriteTarget[] = [];
  const unjudgeable: string[] = [];
  const index = new Map<string, number>();
  const seenUnknown = new Set<string>();
  const kind = powershellWriteKind(command);
  // PowerShell 的 Set-Location/cd/sl 会改变后续命令的当前目录。此处不逐段跟踪位置
  // （参数级正则在整条命令上匹配，无法定位每个目标的所属段），只要出现 cd 类命令
  // 就把全部相对路径目标按无法判定处理：宁可多审批一次，也不放过越界写入。
  const base: string | null =
    CD_ANYWHERE_RE.test(stripQuotedSpans(command)) || CD_QUOTED_VERB_RE.test(command) ? null : cwd;

  // base：解析相对路径用的当前目录；null 表示命令中出现了 cd 类命令，落点无法静态确定
  const push = (raw: string, targetKind: WriteTargetKind, base: string | null) => {
    const t = toWindowsPath(stripQuotes(raw.trim()));
    if (!t) return;
    if (t.startsWith("&")) return;
    if (SYMBOL_ONLY_RE.test(t)) return;
    const expanded = expandTilde(t);
    if (expanded === undefined || UNJUDGEABLE_RE.test(expanded)) {
      if (!seenUnknown.has(t)) {
        seenUnknown.add(t);
        unjudgeable.push(t);
      }
      return;
    }
    if (/^(\/dev\/|nul$)/i.test(expanded)) return; // 设备文件不视为磁盘写入
    if (/^[a-z]+:\/\//i.test(expanded)) return; // URL
    let resolved: string;
    if (path.isAbsolute(expanded)) {
      resolved = expanded;
    } else if (base === null) {
      // 当前目录无法静态确定：相对目标按无法判定处理（不静默放行）
      if (!seenUnknown.has(t)) {
        seenUnknown.add(t);
        unjudgeable.push(t);
      }
      return;
    } else {
      resolved = path.resolve(base, expanded);
    }
    const at = index.get(resolved);
    if (at === undefined) {
      index.set(resolved, targets.length);
      targets.push({ path: resolved, kind: targetKind });
      return;
    }
    if (KIND_RANK[targetKind] < KIND_RANK[targets[at].kind]) targets[at].kind = targetKind;
  };

  // 显式写入目标参数：有 -Destination/-Target 时只检查它们
  const destRe = /-(?:Destination(?:Path)?|Target(?:Path)?|OutFile|OutputPath)\s*[:=]?\s*("[^"]*"|'[^']*'|[^\s;|)]+)/gi;
  const destValues: string[] = [];
  for (const m of command.matchAll(destRe)) destValues.push(m[1]);

  if (destValues.length > 0) {
    // 显式写入目标：只检查 -Destination/-Target 的值
    for (const v of destValues) push(v, kind, base);
  } else {
    // 1) 输出重定向目标（重定向本身即写入）
    const { targetTokens } = scanAndStripRedirects(command);
    for (const tk of targetTokens) push(tk, "file", base);

    // 2) 路径类参数与绝对/逃逸路径：仅在命令含写入类 cmdlet 时提取，避免只读命令误报
    if (hasPowerShellWriteVerb(command)) {
      const paramRe = /-(?:Path|LiteralPath|FilePath|DestinationPath|TargetPath|OutputPath)\s*[:=]?\s*("[^"]*"|'[^']*'|[^\s;|)]+)/gi;
      for (const m of command.matchAll(paramRe)) push(m[1], kind, base);

      const absRe =
        /"[^"]*[\\/][^"]*"|'[^']*[\\/][^']*'|[A-Za-z]:[\\/][^\s"'|;)]*|\\\\[^\s"'|;)]+|\/[A-Za-z]\/[^\s"'|;)]*|\.\.[\\/][^\s"'|;)]*|~[\\/][^\s"'|;)]*/g;
      for (const m of command.matchAll(absRe)) push(m[0], kind, base);
    }
  }

  return { targets, unjudgeable };
}

/** 兼容壳：仅返回可静态判定的目标（路径 + 类型提示）。 */
export function extractPowerShellWriteTargetInfo(command: string, cwd: string): WriteTarget[] {
  return scanPowerShellWriteTargets(command, cwd).targets;
}

/** 兼容壳：仅返回可静态判定的目标路径数组。 */
export function extractPowerShellWriteTargets(command: string, cwd: string): string[] {
  return scanPowerShellWriteTargets(command, cwd).targets.map((t) => t.path);
}

/** 命令中是否出现写文件类 cmdlet（目标无法静态判定时用于保守审批）。 */
export function hasPowerShellWriteVerb(command: string): boolean {
  return POWERSHELL_WRITE_RE.test(command);
}

/**
 * 引号感知扫描输出重定向：
 *  - 返回每个 > / >> 后的目标 token（引号原样保留，由调用方 stripQuotes）
 *  - 返回剥离全部重定向部分后的命令文本（供动词目标提取使用）
 * 引号内的 > 不视为重定向；2>&1 等文件描述符重定向不会误提取目标。
 */
function scanAndStripRedirects(command: string): { targetTokens: string[]; cleaned: string } {
  const targetTokens: string[] = [];
  let cleaned = "";
  let quote: string | null = null;
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i];
    if (quote) {
      cleaned += ch;
      if (ch === quote && command[i - 1] !== "\\") quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cleaned += ch;
      i++;
      continue;
    }
    if (ch === ">") {
      // 跳过 > 或 >>
      if (command[i + 1] === ">") i++;
      i++;
      // 跳过空白
      while (i < n && /\s/.test(command[i])) i++;
      // 提取目标 token（到空白或 |;&<> 或引号结束）
      let tok = "";
      let q: string | null = null;
      while (i < n) {
        const c = command[i];
        if (q) {
          tok += c;
          if (c === q && command[i - 1] !== "\\") q = null;
          i++;
          continue;
        }
        if (c === "'" || c === '"') {
          q = c;
          tok += c;
          i++;
          continue;
        }
        if (/\s/.test(c) || "|;&<>".includes(c)) break;
        tok += c;
        i++;
      }
      if (tok) targetTokens.push(tok);
      // cleaned 不追加重定向部分
      continue;
    }
    cleaned += ch;
    i++;
  }
  return { targetTokens, cleaned };
}

function stripQuotes(s: string): string {
  return s.replace(/^["']+|["']+$/g, "").replace(/\\(["'\\ ])/g, "$1");
}

function tokenizeQuoted(s: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      cur += ch;
      if (ch === quote && s[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/** 命令段及其后的分隔符（sepAfter 取值：""、";"、"&&"、"||"、"|"、"\n"）。 */
interface CommandSegment {
  seg: string;
  sepAfter: string;
}

/**
 * 按 ;、&&、||、|、换行切分命令段，引号内不切分。
 * 同时记录每段之后的分隔符：管道（|）中的 cd 在子进程中执行，不改变父 shell 的当前目录。
 */
function splitCommandSegmentsWithSeparator(command: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === quote && command[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n") {
      let sep = ch;
      const next = command[i + 1] ?? "";
      if ((ch === "&" || ch === "|") && (next === "&" || next === "|")) {
        sep = ch + next;
        i++;
      }
      if (cur.trim()) segments.push({ seg: cur.trim(), sepAfter: sep });
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) segments.push({ seg: cur.trim(), sepAfter: "" });
  return segments;
}

/** 按 ;、&&、||、|、换行切分命令段，引号内不切分 */
function splitCommandSegments(command: string): string[] {
  return splitCommandSegmentsWithSeparator(command).map((item) => item.seg);
}

/** 危险 bash 命令模式（无论是否在工作区内都要求确认）。label 为中英双语。 */
export const DANGEROUS_PATTERNS: { re: RegExp; label: { zh: string; en: string } }[] = [
  {
    re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*|--recursive)/i,
    label: { zh: "rm 递归删除 (-r/-rf)", en: "rm recursive delete (-r/-rf)" },
  },
  { re: /\bsudo\b/i, label: { zh: "sudo 提权", en: "sudo privilege escalation" } },
  {
    re: /\b(chmod|chown)\b.*\b777\b/i,
    label: { zh: "chmod/chown 777", en: "chmod/chown 777" },
  },
];

/** 双语模板辅助：按语言取中/英。 */
function x(lang: Lang, zh: string, en: string): string {
  return lang === "zh" ? zh : en;
}

/**
 * 以自然语言说明 bash 命令的作用（本地模板规则，用于审批弹窗）。
 * 按命令段逐条生成说明；无法识别的命令段返回空字符串。
 */
export function explainCommand(command: string, lang: Lang): string {
  const lines: string[] = [];
  for (const seg of splitCommandSegments(command)) {
    const line = explainSegment(seg, lang);
    if (line) lines.push(`• ${line}`);
  }
  return lines.join("\n");
}

// ---------- 审批框内容裁剪（固定策略：按行数 / 字符数，不做宽度预估、不强制折行） ----------

/** clampLines 的选项。 */
export interface ClampLinesOptions {
  /** 行数不超过该值时原样显示全部内容 */
  fullMaxLines: number;
  /** 超出时保留的头部行数 */
  headLines: number;
  /** 超出时保留的尾部行数 */
  tailLines: number;
  /** 省略标记行文案生成函数，入参为被省略的行数（由调用方提供本地化文本） */
  marker: (skipped: number) => string;
}

/**
 * 按固定行数策略裁剪多行文本（命令预览、目标路径列表）：
 *  - 行数 ≤ fullMaxLines：原样返回（全部显示）
 *  - 行数 >  fullMaxLines：头部 headLines 行 + 省略标记行 + 尾部 tailLines 行
 * 不做任何宽度处理：超宽行原样保留，由终端自动换行。
 */
export function clampLines(text: string, options: ClampLinesOptions): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length <= options.fullMaxLines) return text;

  const headLines = Math.max(1, Math.floor(options.headLines));
  const tailLines = Math.max(0, Math.floor(options.tailLines));
  const skipped = lines.length - headLines - tailLines;
  // 头部 + 尾部本身就超过上限时（参数配置不当）退化为只保留头部
  if (skipped < 0) return lines.slice(0, options.fullMaxLines).join("\n");

  return [
    ...lines.slice(0, headLines),
    options.marker(skipped),
    ...(tailLines > 0 ? lines.slice(lines.length - tailLines) : []),
  ].join("\n");
}

/**
 * 按字符数上限裁剪长文本（LLM 说明 / 本地模板说明等散文）：
 * 超出时截断到 maxChars 个字符并追加省略号；不做折行，由终端自动换行。
 */
export function clampChars(text: string, maxChars: number): string {
  const limit = Math.max(16, Math.floor(maxChars));
  const chars = [...text];
  return chars.length <= limit ? text : chars.slice(0, limit).join("") + "…";
}

/** 解释单个命令段 */
function explainSegment(seg: string, lang: Lang): string {
  const and = lang === "zh" ? "、" : ", ";
  const arrow = lang === "zh" ? " → " : " -> ";

  // 1) 输出重定向：> 或 >> 目标
  const redirectRe = /(?:>>|>)\s*([^\s<>|;&"'`]+)/;
  const rm = seg.match(redirectRe);
  const append = seg.includes(">>");
  const redirectText = rm
    ? x(
        lang,
        `，并将输出${append ? "追加" : "写入"}到 ${stripQuotes(rm[1])}`,
        `, and ${append ? "append" : "write"} output to ${stripQuotes(rm[1])}`,
      )
    : "";

  // 2) 命令主体（移除重定向部分）
  const body = seg.replace(/(?:>>|>)\s*[^\s<>|;&"'`]+/, "").trim();
  if (!body) {
    return rm
      ? x(
          lang,
          `将输出${append ? "追加" : "写入"}到 ${stripQuotes(rm[1])}`,
          `${append ? "Append" : "Write"} output to ${stripQuotes(rm[1])}`,
        )
      : "";
  }

  // 3) sudo 前缀
  let privilege = "";
  let cmdBody = body;
  const sudoM = body.match(/^\s*sudo\b(.*)$/i);
  if (sudoM) {
    privilege = x(lang, "以管理员(root)权限 ", "with root (admin) privileges ");
    cmdBody = sudoM[1].trim();
  }

  // 4) 动词与参数
  const tokens = cmdBody.split(/\s+/).filter(Boolean);
  const verb = (tokens[0] || "").toLowerCase();
  const args = tokens.slice(1);
  const flags = args.filter((t) => t.startsWith("-"));
  const targets = extractTargetTokens(args).map(stripQuotes);

  let action = "";
  switch (verb) {
    case "rm": {
      const recursive = flags.some((f) => /^-[a-zA-Z]*r[a-zA-Z]*$/.test(f) || f === "--recursive");
      action = recursive
        ? x(
            lang,
            `递归强制删除 ${targets.join(and) || "(目标)"}（不可恢复）`,
            `Recursively force-delete ${targets.join(and) || "(target)"} (irreversible)`,
          )
        : x(
            lang,
            `删除 ${targets.join(and) || "(目标)"}`,
            `Delete ${targets.join(and) || "(target)"}`,
          );
      break;
    }
    case "mv":
      action = x(
        lang,
        `移动/重命名：${targets.join(arrow) || "(源 → 目标)"}`,
        `Move/rename: ${targets.join(arrow) || "(source → target)"}`,
      );
      break;
    case "cp":
      action = x(
        lang,
        `复制：${targets.join(arrow) || "(源 → 目标)"}`,
        `Copy: ${targets.join(arrow) || "(source → target)"}`,
      );
      break;
    case "mkdir":
      action = x(
        lang,
        `创建目录 ${targets.join(and) || "(目标)"}${flags.includes("-p") ? "（含父目录）" : ""}`,
        `Create directory ${targets.join(and) || "(target)"}${flags.includes("-p") ? " (with parents)" : ""}`,
      );
      break;
    case "touch":
      action = x(
        lang,
        `创建空文件或更新时间戳：${targets.join(and) || "(目标)"}`,
        `Create empty file or update timestamp: ${targets.join(and) || "(target)"}`,
      );
      break;
    case "tee":
      action = x(
        lang,
        `将输入写入文件并同时输出：${targets.join(and) || "(目标)"}`,
        `Write input to file while also showing it: ${targets.join(and) || "(target)"}`,
      );
      break;
    case "install":
      action = x(
        lang,
        `安装/复制文件到 ${targets.join(and) || "(目标)"}`,
        `Install/copy file to ${targets.join(and) || "(target)"}`,
      );
      break;
    case "ln":
      action = x(
        lang,
        `创建${flags.includes("-s") ? "符号" : "硬"}链接：${targets.join(arrow) || "(源 → 目标)"}`,
        `Create ${flags.includes("-s") ? "symbolic" : "hard"} link: ${targets.join(arrow) || "(source → target)"}`,
      );
      break;
    case "dd": {
      const ofM = cmdBody.match(/\bof=([^\s]+)/);
      action = x(
        lang,
        `磁盘级复制（写入目标：${ofM ? stripQuotes(ofM[1]) : "未知"}）`,
        `Disk-level copy (write target: ${ofM ? stripQuotes(ofM[1]) : "unknown"})`,
      );
      break;
    }
    case "chmod": {
      const mode = targets[0] || "";
      const files = targets.slice(1).join(and) || "(目标)";
      action =
        mode === "777"
          ? x(
              lang,
              `将 ${files} 权限改为 777（所有用户可读写执行，有安全风险）`,
              `Change ${files} permissions to 777 (read/write/execute for all, security risk)`,
            )
          : x(
              lang,
              `修改 ${files} 的文件权限为 ${mode || "(指定权限)"}`,
              `Change permissions of ${files} to ${mode || "(specified)"}`,
            );
      break;
    }
    case "chown":
      action = x(
        lang,
        `修改 ${targets.slice(1).join(and) || "(目标)"} 的文件所有者为 ${targets[0] || "(指定用户)"}`,
        `Change owner of ${targets.slice(1).join(and) || "(target)"} to ${targets[0] || "(specified user)"}`,
      );
      break;
    case "git": {
      const sub = targets[0] || "";
      action = sub
        ? x(
            lang,
            `执行 git 操作：${sub} ${targets.slice(1).join(" ")}`.trim(),
            `Run git: ${sub} ${targets.slice(1).join(" ")}`.trim(),
          )
        : x(lang, "执行 git 操作", "Run git");
      break;
    }
    case "npm":
    case "yarn":
    case "pnpm": {
      const sub = targets[0] || "";
      const pkg = targets.slice(1).join(" ");
      const map: Record<string, string> = {
        install: x(lang, "安装依赖", "install dependencies"),
        add: x(lang, "添加依赖", "add dependencies"),
        remove: x(lang, "移除依赖", "remove dependencies"),
        uninstall: x(lang, "卸载依赖", "uninstall dependencies"),
        update: x(lang, "更新依赖", "update dependencies"),
        run: x(lang, "运行脚本", "run script"),
        ci: x(lang, "按锁文件安装依赖", "install from lockfile"),
      };
      action = `${map[sub] ||
        x(lang, `执行 ${sub || "(命令)"}`, `run ${sub || "(command)"}`)}${pkg ? x(lang, "：" + pkg, ": " + pkg) : ""}`;
      break;
    }
    case "pip":
    case "pip3": {
      const sub = targets[0] || "";
      const pkg = targets.slice(1).join(" ");
      const map: Record<string, string> = {
        install: x(lang, "安装 Python 包", "install Python packages"),
        uninstall: x(lang, "卸载 Python 包", "uninstall Python packages"),
        list: x(lang, "列出已安装包", "list installed packages"),
        freeze: x(lang, "导出已安装包清单", "export installed package list"),
      };
      action = `${map[sub] ||
        x(lang, `执行 pip ${sub || "(命令)"}`, `run pip ${sub || "(command)"}`)}${pkg ? x(lang, "：" + pkg, ": " + pkg) : ""}`;
      break;
    }
    default:
      action = x(lang, `执行命令：${cmdBody}`, `Run command: ${cmdBody}`);
  }

  return privilege + action + redirectText;
}

/**
 * 从参数列表中提取目标 token（跳过选项及其已知带参选项的值、输入重定向）。
 * - `-m 755` 这类带参短选项：跳过选项和它的值
 * - `< input.txt` 输入重定向：跳过符号和文件名
 */
function extractTargetTokens(args: string[]): string[] {
  const targets: string[] = [];
  // 已知带参数的短选项（-m 模式/-o 输出/-t 目标/-f 文件等）
  const valueFlags = "motfdi";
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t.startsWith("-")) {
      if (/^-[a-zA-Z]$/.test(t) && valueFlags.includes(t[1]) && i + 1 < args.length && !args[i + 1].startsWith("-")) {
        i++; // 跳过选项值
      }
      continue;
    }
    if (t === "<") {
      i++; // 跳过输入重定向及其文件
      continue;
    }
    targets.push(t);
  }
  return targets;
}
