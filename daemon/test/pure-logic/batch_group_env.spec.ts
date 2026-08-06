import { describe, expect, it } from "vitest";
import { expandGroupEnv } from "../../src/service/runner_provision";

// One form field, N runners: the add-runner dialog takes a single env block per label group and
// this is where it becomes each runner's own copy. Two things have to hold.
//
// Per-runner values must actually differ. A group of four NPU runners sharing one device range is
// not a cosmetic bug — the four of them fight over the same accelerators at the first job.
//
// And a bad entry has to fail *here*, while the batch is still a plan. Everything downstream is
// irreversible in the way that matters: config.sh registers the runner with GitHub, and a failure
// at runner 7 leaves six half-configured agents behind. That is why the batch expands and
// validates every runner's env up front instead of validating as it goes.

describe("per-runner expansion", () => {
  it("gives each runner in a group its own device range", () => {
    const vars = [{ key: "ASCEND_RT_VISIBLE_DEVICES", value: "{{(index-1)*4}}-{{(index-1)*4+3}}" }];
    const got = ["npu-1", "npu-2", "npu-3"].map((name, i) => expandGroupEnv(vars, name, i + 1));
    expect(got.map((v) => v[0].value)).toEqual(["0-3", "4-7", "8-11"]);
  });

  it("keys off the number in the name, not the position in the batch", () => {
    // 采番先补删除留下的空缺：这一批的第 1 个可能叫 npu-3。设备号必须跟着名字走，否则补空缺
    // 的那台会和某台还在跑的 runner 抢同一批设备。
    expect(expandGroupEnv([{ key: "DEV", value: "{{index}}" }], "npu-3", 1)).toEqual([
      { key: "DEV", value: "3" }
    ]);
  });

  it("falls back to the batch sequence when the name has no number", () => {
    expect(expandGroupEnv([{ key: "DEV", value: "{{index}}" }], "custom", 2)).toEqual([
      { key: "DEV", value: "2" }
    ]);
  });

  it("passes values without placeholders through untouched", () => {
    const vars = [{ key: "HTTPS_PROXY", value: "http://127.0.0.1:7892" }];
    expect(expandGroupEnv(vars, "npu-1", 1)).toEqual(vars);
  });

  it("is empty for an absent or empty list", () => {
    expect(expandGroupEnv(undefined, "npu-1", 1)).toEqual([]);
    expect(expandGroupEnv([], "npu-1", 1)).toEqual([]);
  });
});

describe("rejects before anything is registered", () => {
  it("names the runner and the variable when an expression is broken", () => {
    // 一批里只有一条写错时，「表达式不完整」这五个字帮不上任何忙
    expect(() => expandGroupEnv([{ key: "DEV", value: "{{index-}}" }], "npu-2", 2)).toThrow(
      /npu-2 的环境变量 DEV/
    );
  });

  it("applies the same key and value rules as the env editor", () => {
    expect(() => expandGroupEnv([{ key: "BAD-KEY", value: "v" }], "npu-1", 1)).toThrow(
      "非法环境变量名"
    );
    expect(() =>
      expandGroupEnv([{ key: "K", value: "v\nEnvironment=EVIL=1" }], "npu-1", 1)
    ).toThrow("不能含换行");
  });

  it("rejects an over-long value before expanding it", () => {
    // 展开器是递归下降的，深度随输入走。长度检查必须排在展开之前，否则一个几 MB 的值
    // 会先被嚼一遍，再由 sanitizeEnvVars 以同样的理由拒掉。
    const long = "x".repeat(4097);
    expect(() => expandGroupEnv([{ key: "K", value: long }], "npu-1", 1)).toThrow("过长");
    expect(() => expandGroupEnv([{ key: "K", value: long }], "npu-1", 1)).toThrow("npu-1");
  });

  it("refuses a placeholder that would inject a second line", () => {
    // 值本身没有换行，展开后也不会有——但这条是 systemd drop-in 的形状底线，直接钉住
    const vars = [{ key: "K", value: "a{{index}}b" }];
    expect(expandGroupEnv(vars, "npu-1", 1)[0].value).not.toMatch(/[\r\n]/);
  });
});
