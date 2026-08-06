// 「添加 Runner」里那两个环境变量文本框的解析：每行 KEY=VALUE → {key, value}[]。
//
// 只在前端存在：panel↔daemon 之间传的一直是 {key, value} 数组（env_set 也是），文本形态是
// 输入方式，不是协议。daemon 侧仍会再校验一遍——这里的报错只为了让用户在点「批量注册并创建
// 实例」之前就看见问题，而不是等一批 runner 建到一半才失败。
import { expandEnvTemplate, type EnvTemplateContext } from "./envTemplate";

export interface EnvVar {
  key: string;
  value: string;
}

// 与 daemon 的 runner_env_vars.ENV_KEY_RE 同款（小写也放行：既有 .env 里就有 http_proxy）
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VARS = 100;
const MAX_VALUE_LEN = 4096;

export interface ParsedEnvText {
  vars: EnvVar[];
  error: string; // 空串 = 合法
}

// 去掉值两侧成对的引号。粘贴 shell 片段时 `K="v"` 很常见，不去掉的话引号会被当成值的一部分
// 原样写进 .env（systemd 的 Environment= 也不会替你剥）。只剥成对的，`K="v` 这种原样保留。
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const q = value[0];
    if ((q === '"' || q === "'") && value[value.length - 1] === q) return value.slice(1, -1);
  }
  return value;
}

// 解析文本框内容。空行与 # 注释跳过；容忍行首 `export `；按首个 = 切分。
// 同名后者覆盖前者（与 daemon 的 sanitizeEnvVars 一致），但保持首次出现的顺序。
export function parseEnvText(text: string): ParsedEnvText {
  const vars: EnvVar[] = [];
  const at = new Map<string, number>();
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) return { vars: [], error: `第 ${i + 1} 行不是 KEY=VALUE：${line}` };
    const key = body.slice(0, eq).trim();
    if (!ENV_KEY_RE.test(key))
      return { vars: [], error: `第 ${i + 1} 行变量名非法：${key}（只允许字母、数字、下划线，且不以数字开头）` };
    const value = stripQuotes(body.slice(eq + 1).trim());
    if (value.length > MAX_VALUE_LEN)
      return { vars: [], error: `第 ${i + 1} 行 ${key} 的值过长（上限 ${MAX_VALUE_LEN}）` };
    const seen = at.get(key);
    if (seen === undefined) {
      at.set(key, vars.length);
      vars.push({ key, value });
    } else {
      vars[seen] = { key, value };
    }
  }
  if (vars.length > MAX_VARS)
    return { vars: [], error: `变量条数过多：${vars.length}（上限 ${MAX_VARS}）` };
  return { vars, error: "" };
}

// 按某个 runner 展开一份变量（占位符求值）。给预览用，也用来在提交前把写错的表达式挡下来。
export function expandEnvVars(
  vars: EnvVar[],
  ctx: EnvTemplateContext
): { vars: EnvVar[]; error: string } {
  const out: EnvVar[] = [];
  for (const v of vars) {
    try {
      out.push({ key: v.key, value: expandEnvTemplate(v.value, ctx) });
    } catch (err: unknown) {
      return { vars: [], error: `${v.key}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { vars: out, error: "" };
}

// 预览成一行：KEY=VALUE 之间用空格隔开，太长了截断。
export function formatEnvPreview(vars: EnvVar[], max = 3): string {
  const head = vars.slice(0, max).map((v) => `${v.key}=${v.value}`).join("  ");
  return vars.length > max ? `${head} … 等 ${vars.length} 项` : head;
}
