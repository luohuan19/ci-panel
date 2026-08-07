import { describe, expect, it } from "vitest";
import { expandEnvVars, formatEnvPreview, parseEnvText } from "../envText";
import { expandEnvTemplate, envTemplateIndexOf } from "../envTemplate";

// parseEnvText turns the two textareas in the add-runner dialog into the {key, value} pairs the
// panel already speaks. It is the only place a user's paste is interpreted, so the cases below are
// mostly about paste shapes (shell exports, quotes, comments) and about failing loudly: an
// unparsable line must stop the submit, because the alternative is finding out after a batch of
// twenty runners has registered with half its variables missing.

describe("parseEnvText", () => {
  it("parses one KEY=VALUE per line", () => {
    expect(parseEnvText("A=1\nB=2")).toEqual({
      vars: [
        { key: "A", value: "1" },
        { key: "B", value: "2" }
      ],
      error: ""
    });
  });

  it("is empty for empty input", () => {
    expect(parseEnvText("")).toEqual({ vars: [], error: "" });
    expect(parseEnvText("   \n\n  ")).toEqual({ vars: [], error: "" });
  });

  it("skips blank lines and # comments", () => {
    const { vars, error } = parseEnvText("# 代理\n\nA=1\n   # 又一条注释\nB=2\n");
    expect(error).toBe("");
    expect(vars).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "2" }
    ]);
  });

  it("tolerates the shapes people paste from a shell", () => {
    const { vars, error } = parseEnvText('export HTTPS_PROXY="http://127.0.0.1:7892"\n');
    expect(error).toBe("");
    expect(vars).toEqual([{ key: "HTTPS_PROXY", value: "http://127.0.0.1:7892" }]);
  });

  it("keeps everything after the first = ", () => {
    expect(parseEnvText("URL=http://h/p?a=1&b=2").vars).toEqual([
      { key: "URL", value: "http://h/p?a=1&b=2" }
    ]);
  });

  it("strips only a matching pair of quotes", () => {
    expect(parseEnvText("A='v'\nB=\"v\"\nC=\"v\nD='v\"").vars).toEqual([
      { key: "A", value: "v" },
      { key: "B", value: "v" },
      { key: "C", value: '"v' },
      { key: "D", value: "'v\"" }
    ]);
  });

  it("trims surrounding whitespace and CRLF line endings", () => {
    expect(parseEnvText("  A  =  1  \r\nB=2\r\n").vars).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "2" }
    ]);
  });

  it("keeps an empty value — unsetting by writing K= is a real intent", () => {
    expect(parseEnvText("A=").vars).toEqual([{ key: "A", value: "" }]);
  });

  it("lets a later line win but keeps the first position, matching the daemon", () => {
    expect(parseEnvText("A=1\nB=2\nA=3").vars).toEqual([
      { key: "A", value: "3" },
      { key: "B", value: "2" }
    ]);
  });

  it.each([
    ["A", "第 1 行不是 KEY=VALUE"],
    ["A=1\nnonsense", "第 2 行不是 KEY=VALUE"],
    ["=1", "第 1 行不是 KEY=VALUE"],
    ["1A=1", "第 1 行变量名非法"],
    ["A-B=1", "第 1 行变量名非法"],
    ["A B=1", "第 1 行变量名非法"],
    ["中文=1", "第 1 行变量名非法"]
  ])("rejects %j and points at the line", (text, needle) => {
    const { vars, error } = parseEnvText(text);
    expect(error).toContain(needle);
    // 出错时不能回半份清单：调用方拿它去提交，半份就是静默丢变量
    expect(vars).toEqual([]);
  });

  it("rejects an over-long value and more than 100 variables", () => {
    expect(parseEnvText(`A=${"x".repeat(4097)}`).error).toContain("过长");
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => `K${i}=v`).join("\n");
    expect(parseEnvText(many(100)).error).toBe("");
    expect(parseEnvText(many(101)).error).toContain("条数过多");
  });
});

describe("expandEnvVars", () => {
  const ctx = { name: "npu-3", index: 3, seq: 1 };

  it("expands every value against one runner", () => {
    expect(
      expandEnvVars(
        [
          { key: "NAME", value: "{{name}}" },
          { key: "DEV", value: "{{(index-1)*4}}-{{(index-1)*4+3}}" }
        ],
        ctx
      )
    ).toEqual({
      vars: [
        { key: "NAME", value: "npu-3" },
        { key: "DEV", value: "8-11" }
      ],
      error: ""
    });
  });

  it("reports which variable holds the broken expression", () => {
    const { vars, error } = expandEnvVars([{ key: "DEV", value: "{{index-}}" }], ctx);
    expect(error).toContain("DEV");
    expect(vars).toEqual([]);
  });
});

describe("formatEnvPreview", () => {
  it("joins pairs and truncates past the cap", () => {
    const vars = [
      { key: "A", value: "1" },
      { key: "B", value: "2" }
    ];
    expect(formatEnvPreview(vars)).toBe("A=1  B=2");
    expect(formatEnvPreview(vars, 1)).toBe("A=1 … 等 2 项");
  });
});

// The daemon carries a byte-identical copy of envTemplate.ts and is what actually writes the
// files; these cases are duplicated in daemon/test/contract/env_template_parity.spec.ts so a
// divergence fails on both sides rather than only where it was introduced.
describe("envTemplate, the copy the daemon also runs", () => {
  const ctx = { name: "npu-3", index: 3, seq: 1 };

  it.each([
    ["{{name}}", "npu-3"],
    ["{{index}}", "3"],
    ["{{seq}}", "1"],
    ["{{(index-1)*4}}-{{(index-1)*4+3}}", "8-11"],
    ["http://127.0.0.1:7892", "http://127.0.0.1:7892"]
  ])("expandEnvTemplate(%j) === %j", (input, expected) => {
    expect(expandEnvTemplate(input, ctx)).toBe(expected);
  });

  it("derives the same index from a runner name", () => {
    expect(envTemplateIndexOf("npu-3", 1)).toBe(3);
    expect(envTemplateIndexOf("custom", 5)).toBe(5);
  });
});
