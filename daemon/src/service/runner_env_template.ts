// runner 环境变量值里的占位符：`{{ 表达式 }}`，批量创建时按每个 runner 各展开一次。
//
//   {{name}}          → runner 全名，如 npu-7
//   {{index}}         → 名字里的编号（npu-7 → 7）。这是 runner 的稳定身份：采番会优先补删除
//                       留下的空缺，所以「第几个建的」会变，而名字里的编号不会。
//   {{seq}}           → 本批该组内第几个，从 1 起（要连续编号时用它）
//   {{(index-1)*4}}   → 整数算术：+ - * / % 与括号，一元正负号。/ 向零取整，除零报错。
//
// ⚠️ 这份文件在两个包里各有一份，必须逐字节一致：
//     daemon/src/service/runner_env_template.ts
//     frontend/src/tools/envTemplate.ts
//   daemon 是权威（真正写盘的是它），前端拿同一份做提交前校验和「首个/末个 runner 展开成
//   什么」的预览。两边一旦漂移，用户看到的预览就不是最终落盘的值——而这是批量操作，等发现
//   时几十个 runner 已经带着错误的设备号跑起来了。一致性由契约测试盯住：
//     daemon/test/contract/env_template_parity.spec.ts
//
// 刻意不放进 common/：前端对 mcsmanager-common 至今只有 import type，引入第一个值导入会把
// common 的 barrel（re-export 了 system_info 的 setInterval、system_storage 的 fs）拽进浏览器
// bundle。同款权衡见 frontend/src/tools/runnerNaming.ts。
//
// 求值器是手写的递归下降，不是 eval/Function：这里的输入来自面板表单，一路会写进 systemd
// drop-in 与 .env，绝不能给它任何执行任意代码的机会。

export interface EnvTemplateContext {
  name: string; // runner 全名
  index: number; // 名字里的编号；名字没有数字后缀时回退为 seq
  seq: number; // 本批该组内序号，从 1 起
}

// 表达式里可用的变量名。name 不在此列——它是字符串，只允许单独成一个占位符。
const IDENTIFIERS = ["index", "seq"];

interface Token {
  kind: "num" | "id" | "op";
  text: string;
}

// 词法：整数、标识符、单字符运算符与括号。空白忽略，其余字符一律报错（不放行未知符号）。
function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === " " || c === "\t") {
      i++;
    } else if (c >= "0" && c <= "9") {
      let text = "";
      while (i < expr.length && expr[i] >= "0" && expr[i] <= "9") text += expr[i++];
      tokens.push({ kind: "num", text });
    } else if (/[A-Za-z_]/.test(c)) {
      let text = "";
      while (i < expr.length && /[A-Za-z0-9_]/.test(expr[i])) text += expr[i++];
      tokens.push({ kind: "id", text });
    } else if ("+-*/%()".includes(c)) {
      tokens.push({ kind: "op", text: c });
      i++;
    } else {
      throw new Error(`不认识的字符 "${c}"`);
    }
  }
  return tokens;
}

// 语法：expr := term (('+' | '-') term)* ; term := unary (('*' | '/' | '%') unary)* ;
//       unary := ('+' | '-')? primary ; primary := 整数 | 标识符 | '(' expr ')'
// 全程整数运算：/ 向零取整（Math.trunc），% 取余，除数为 0 报错。
class Parser {
  private at = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly ctx: EnvTemplateContext
  ) {}

  parse(): number {
    const value = this.expr();
    if (this.at < this.tokens.length) throw new Error(`多余的 "${this.tokens[this.at].text}"`);
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private eatOp(...ops: string[]): string {
    const tok = this.peek();
    if (tok && tok.kind === "op" && ops.includes(tok.text)) {
      this.at++;
      return tok.text;
    }
    return "";
  }

  private expr(): number {
    let left = this.term();
    for (;;) {
      const op = this.eatOp("+", "-");
      if (!op) return left;
      const right = this.term();
      left = op === "+" ? left + right : left - right;
    }
  }

  private term(): number {
    let left = this.unary();
    for (;;) {
      const op = this.eatOp("*", "/", "%");
      if (!op) return left;
      const right = this.unary();
      if (op === "*") {
        left = left * right;
      } else {
        if (right === 0) throw new Error("除数为 0");
        left = op === "/" ? Math.trunc(left / right) : left % right;
      }
    }
  }

  private unary(): number {
    const op = this.eatOp("+", "-");
    const value = op ? this.unary() : this.primary();
    return op === "-" ? -value : value;
  }

  private primary(): number {
    const tok = this.peek();
    if (!tok) throw new Error("表达式不完整");
    if (tok.kind === "num") {
      this.at++;
      return Number(tok.text);
    }
    if (tok.kind === "id") {
      this.at++;
      if (tok.text === "index") return this.ctx.index;
      if (tok.text === "seq") return this.ctx.seq;
      if (tok.text === "name") throw new Error("name 是文本，不能参与算术，只能单独写成 {{name}}");
      throw new Error(`未知变量 "${tok.text}"（可用：${IDENTIFIERS.join("、")}、name）`);
    }
    if (this.eatOp("(")) {
      const value = this.expr();
      if (!this.eatOp(")")) throw new Error("缺少右括号");
      return value;
    }
    throw new Error(`意外的 "${tok.text}"`);
  }
}

// 求一个占位符的值。name 单独成串，其余按整数算术求值。
function evalPlaceholder(raw: string, ctx: EnvTemplateContext): string {
  const expr = raw.trim();
  if (!expr) throw new Error("占位符 {{}} 里是空的");
  if (expr === "name") return ctx.name;
  let value: number;
  try {
    value = new Parser(tokenize(expr), ctx).parse();
  } catch (err) {
    throw new Error(`占位符 {{${expr}}} 无效：${err instanceof Error ? err.message : String(err)}`);
  }
  // 溢出到不安全整数说明表达式已经不是用户想要的了（例如误写成天文数字的乘积），
  // 与其安静地写下一个精度已失真的值，不如报错。
  if (!Number.isSafeInteger(value)) throw new Error(`占位符 {{${expr}}} 的结果不是安全整数`);
  return String(value);
}

// 展开一个值里的全部占位符。没有 `{{` 时原样返回。
export function expandEnvTemplate(value: string, ctx: EnvTemplateContext): string {
  const text = String(value ?? "");
  let out = "";
  let from = 0;
  for (;;) {
    const open = text.indexOf("{{", from);
    if (open < 0) return out + text.slice(from);
    const close = text.indexOf("}}", open + 2);
    if (close < 0) throw new Error(`占位符没有闭合的 }}：${text.slice(open)}`);
    out += text.slice(from, open) + evalPlaceholder(text.slice(open + 2, close), ctx);
    from = close + 2;
  }
}

// 值里是否含占位符。前端据此决定要不要显示展开预览。
export function hasEnvTemplate(value: string): boolean {
  return String(value ?? "").includes("{{");
}

// 从 runner 名字里取编号：npu-7 → 7。没有数字后缀（用户自定义命名）时回退为 seq，
// 让 {{index}} 在任何命名下都有确定的含义。
export function envTemplateIndexOf(name: string, seq: number): number {
  const m = /-(\d+)$/.exec(String(name ?? ""));
  return m ? Number(m[1]) : seq;
}
