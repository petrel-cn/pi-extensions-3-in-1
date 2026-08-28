/**
 * workspace-guard 核心逻辑（纯函数，无 pi 依赖，便于单元测试）
 *
 * 职责：
 *  - isPathAllowed: 判断目标路径是否位于允许目录内
 *  - extractWriteTargets: 从 bash 命令中提取可能写入/修改的目标路径
 *  - DANGEROUS_PATTERNS: 危险 bash 命令模式（中英双语标签）
 *  - explainCommand: 以自然语言说明 bash 命令的作用（本地模板，中英双语）
 */

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
 */
function toWindowsPath(p: string): string {
  if (process.platform !== "win32") return p;
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(p);
  if (m) return `${m[1].toUpperCase()}:/${m[2]}`;
  return p;
}

/**
 * 从 bash 命令中提取可能写入/修改的目标路径（相对 cwd 解析，绝对路径原样返回）。
 * 实用级解析：识别输出重定向（>、>>）、常见文件操作命令（cp/mv/rm/mkdir/touch/tee/install/dd/ln）的目标参数。
 * 引号感知：引号内的符号不参与匹配，引号内的目标路径原样保留（修复占位符破坏带引号路径的问题）。
 * 含变量/命令替换的路径跳过（无法静态判断）。
 */
export function extractWriteTargets(command: string, cwd: string): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string) => {
    const t = toWindowsPath(stripQuotes(raw.trim())); // Git Bash 的 /d/... 转为 D:/...
    if (!t) return;
    if (t.startsWith("&")) return; // 文件描述符重定向如 2>&1
    if (/\$[A-Za-z_{]|`/.test(t)) return; // 变量/命令替换，跳过
    // 设备文件不视为磁盘写入：/dev/*（/dev/null 等）、Windows 的 nul
    if (/^(\/dev\/|nul$)/i.test(t)) return;
    const resolved = path.isAbsolute(t) ? t : path.resolve(cwd, t);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      targets.push(resolved);
    }
  };

  // 1) 输出重定向目标（引号感知）：> / >> 后的 token，同时剥离重定向部分得到清理后的命令
  const { targetTokens, cleaned } = scanAndStripRedirects(command);
  for (const t of targetTokens) push(t);

  // 2) 文件操作命令的目标参数：cp/mv/rm/mkdir/touch/tee/install/ln
  for (const seg of splitCommandSegments(cleaned)) {
    const match = seg.match(/\b(cp|mv|rm|mkdir|touch|tee|install|ln)\b(?:\s+-\S+)*\s+(.+)$/);
    if (!match) continue;
    const tokens = tokenizeQuoted(match[2]).filter((t) => t && !t.startsWith("-"));
    if (tokens.length === 0) continue;
    // 写目标范围：cp/ln 仅最后一个参数是写入目标（前面为只读源/链接指向）；
    // mv/rm/mkdir/touch/tee/install 的全部参数都涉及文件系统修改，全部检查（避免漏检多目标命令）
    const verb = (match[0].match(/\b(cp|mv|rm|mkdir|touch|tee|install|ln)\b/) || [])[1] || "";
    const toCheck = verb === "cp" || verb === "ln" ? [tokens[tokens.length - 1]] : tokens;
    for (const t of toCheck) push(t);
  }

  // 3) dd 特殊：目标在 of= 参数
  const ddRe = /\bdd\b[^|;&]*?\bof=([^\s]+)/;
  const ddMatch = ddRe.exec(cleaned);
  if (ddMatch) push(ddMatch[1]);

  return targets;
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

/** 按 ;、&&、||、|、换行切分命令段，引号内不切分 */
function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === quote && command[i - 1] !== "\\") quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === ";" || ch === "&" || ch === "|" || ch === "\n") {
      if (cur.trim()) segments.push(cur.trim());
      cur = "";
      while (i + 1 < command.length && "&|".includes(command[i + 1])) i++;
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) segments.push(cur.trim());
  return segments;
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
