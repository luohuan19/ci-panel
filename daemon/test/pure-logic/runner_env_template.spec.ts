import { describe, expect, it } from "vitest";
import {
  envTemplateIndexOf,
  expandEnvTemplate,
  hasEnvTemplate
} from "../../src/service/runner_env_template";

// Placeholders exist so that one form field can produce a different value per runner — the device
// range on npu-1 must not be the range on npu-2. Two properties matter and neither is obvious from
// reading the parser:
//
//   1. A value with no `{{` must come back byte-identical. Every existing runner env value goes
//      through this function now, and silently rewriting one (dropping a `%`, collapsing spaces)
//      would land in a systemd drop-in where nobody looks until a job fails.
//   2. A malformed expression must throw, not evaluate to something. `{{(index-}}` yielding "0"
//      would configure a whole batch with the wrong device and report success.
//
// The evaluator is hand-written rather than eval/Function on purpose: this input arrives from a
// browser form and ends up in a root-owned unit file.

const ctx = { name: "npu-7", index: 7, seq: 2 };

describe("values without placeholders", () => {
  it.each([
    "",
    "plain",
    "http://127.0.0.1:7892",
    "a,b,c",
    "100%",
    "  spaces kept  ",
    "brace { not doubled }",
    "single {open"
  ])("returns %j unchanged", (value) => {
    expect(expandEnvTemplate(value, ctx)).toBe(value);
  });

  it("treats a nullish value as an empty string", () => {
    expect(expandEnvTemplate(undefined as unknown as string, ctx)).toBe("");
  });
});

describe("substitution", () => {
  it.each([
    ["{{name}}", "npu-7"],
    ["{{index}}", "7"],
    ["{{seq}}", "2"],
    ["{{ index }}", "7"],
    ["dev-{{index}}", "dev-7"],
    ["{{index}}-{{seq}}", "7-2"],
    ["a{{index}}b{{index}}c", "a7b7c"],
    ["prefix {{name}} suffix", "prefix npu-7 suffix"]
  ])("expands %j to %j", (input, expected) => {
    expect(expandEnvTemplate(input, ctx)).toBe(expected);
  });
});

describe("integer arithmetic", () => {
  it.each([
    ["{{index-1}}", "6"],
    ["{{index+1}}", "8"],
    ["{{(index-1)*4}}", "24"],
    ["{{(index-1)*4+3}}", "27"],
    ["{{index*2-1}}", "13"], // 乘法优先于减法
    ["{{2+3*4}}", "14"],
    ["{{(2+3)*4}}", "20"],
    ["{{index/2}}", "3"], // 向零取整
    ["{{-index/2}}", "-3"], // 向零取整（不是向下取整，-4 会是另一回事）
    ["{{index%4}}", "3"],
    ["{{-index}}", "-7"],
    ["{{--index}}", "7"],
    ["{{ (index - 1) * 4 }}-{{ (index - 1) * 4 + 3 }}", "24-27"]
  ])("evaluates %j to %j", (input, expected) => {
    expect(expandEnvTemplate(input, ctx)).toBe(expected);
  });

  it("gives consecutive runners consecutive device ranges", () => {
    const tpl = "{{(index-1)*4}}-{{(index-1)*4+3}}";
    const got = [1, 2, 3].map((i) => expandEnvTemplate(tpl, { name: `npu-${i}`, index: i, seq: i }));
    expect(got).toEqual(["0-3", "4-7", "8-11"]);
  });
});

describe("malformed input throws rather than guessing", () => {
  it.each([
    ["{{", "没有闭合"],
    ["{{index", "没有闭合"],
    ["{{}}", "里是空的"],
    ["{{   }}", "里是空的"],
    ["{{(index-1}}", "缺少右括号"],
    ["{{index-}}", "表达式不完整"],
    ["{{index index}}", "多余的"],
    ["{{nope}}", "未知变量"],
    ["{{name+1}}", "不能参与算术"],
    ["{{index/0}}", "除数为 0"],
    ["{{index%0}}", "除数为 0"],
    ["{{index & 1}}", "不认识的字符"],
    ["{{index.5}}", "不认识的字符"],
    ["{{9999999999*9999999999}}", "不是安全整数"]
  ])("rejects %j", (input, needle) => {
    expect(() => expandEnvTemplate(input, ctx)).toThrow(needle);
  });

  it("names the offending placeholder so a 20-runner batch says which value is wrong", () => {
    expect(() => expandEnvTemplate("dev-{{nope}}", ctx)).toThrow("{{nope}}");
  });
});

describe("hasEnvTemplate", () => {
  it.each([
    ["{{index}}", true],
    ["a{{b", true], // 保守：像占位符就当有，宁可多显示一次预览
    ["plain", false],
    ["", false]
  ])("hasEnvTemplate(%j) === %j", (value, expected) => {
    expect(hasEnvTemplate(value)).toBe(expected);
  });
});

describe("envTemplateIndexOf", () => {
  // index 取名字里的编号而不是批内位置：采番会优先补删除留下的空缺，所以「第几个建的」会变，
  // 而名字里的编号是这台 runner 的稳定身份 —— 设备号跟着它才不会在补空缺时错位。
  it.each([
    ["npu-7", 2, 7],
    ["npu-10", 1, 10],
    ["a-b-3", 9, 3],
    ["noindex", 4, 4], // 无数字后缀：回退成批内序号
    ["npu-", 5, 5],
    ["", 6, 6]
  ])("envTemplateIndexOf(%j, %i) === %i", (name, seq, expected) => {
    expect(envTemplateIndexOf(name, seq)).toBe(expected);
  });
});
