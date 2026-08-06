import { afterEach, describe, expect, it } from "vitest";
import { previewDefaultDotEnv, RUNNER_ENV_SH_KEYS } from "../../src/service/runner_provision";

// A freshly created runner's .env contains lines nobody typed. Two different mechanisms put them
// there, and the add-runner dialog shows this preview so that is no longer a surprise:
//
//   panel  —— the proxy block the panel writes before config.sh runs
//   runner —— actions-runner's own config.sh ends with `source ./env.sh`, which appends any of a
//             fixed key list that is non-empty *in the environment of the process that ran it* —
//             the daemon. So the daemon's inherited LD_LIBRARY_PATH lands in every new runner.
//
// The preview must therefore read the live process environment, not a stored config: a daemon
// restarted from a different shell injects different values, and a stale preview would be a lie.

// 改的是进程环境，而 vitest 的同一个 worker 会跑多个 spec 文件——必须还原成原值，
// 不能一律删掉：把这个进程本来就有的 LANG 删了，受害的是别的文件。
const saved = new Map<string, string | undefined>();
const setEnv = (key: string, value: string | undefined) => {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe("the runner-injected half", () => {
  it("reports a checklist variable that is set in the daemon's own environment", () => {
    setEnv("LD_LIBRARY_PATH", "/usr/local/Ascend/driver/lib64");
    const { runner } = previewDefaultDotEnv("");
    expect(runner).toContainEqual({
      key: "LD_LIBRARY_PATH",
      value: "/usr/local/Ascend/driver/lib64"
    });
  });

  it("omits checklist variables that are unset or empty — env.sh skips those too", () => {
    setEnv("PERL5LIB", undefined);
    setEnv("ANT_HOME", "");
    const keys = previewDefaultDotEnv("").runner.map((v) => v.key);
    expect(keys).not.toContain("PERL5LIB");
    expect(keys).not.toContain("ANT_HOME");
  });

  it("reports nothing outside the checklist, however tempting", () => {
    // 预览的意义是「如实说明会发生什么」。多报一条不存在的注入，和漏报一条一样是错的。
    setEnv("SOME_UNRELATED_VAR", "x");
    expect(previewDefaultDotEnv("").runner.map((v) => v.key)).not.toContain("SOME_UNRELATED_VAR");
  });

  it("keeps the checklist in the order env.sh walks it", () => {
    setEnv("LANG", "en_US.UTF-8");
    setEnv("LD_LIBRARY_PATH", "/lib");
    const keys = previewDefaultDotEnv("").runner.map((v) => v.key);
    expect(keys.indexOf("LANG")).toBeLessThan(keys.indexOf("LD_LIBRARY_PATH"));
    expect(RUNNER_ENV_SH_KEYS.indexOf("LANG")).toBeLessThan(
      RUNNER_ENV_SH_KEYS.indexOf("LD_LIBRARY_PATH")
    );
  });
});

describe("the panel-written half", () => {
  it("lists the proxy block the panel writes, and echoes the proxy it resolved", () => {
    const { proxy, panel } = previewDefaultDotEnv("http://127.0.0.1:7892");
    expect(proxy).toBe("http://127.0.0.1:7892");
    expect(panel.map((v) => v.key)).toEqual(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]);
    expect(panel[0].value).toBe("http://127.0.0.1:7892");
  });

  it("falls back to the daemon's CIP_RUNNER_PROXY when the form left it blank", () => {
    // 表单空着不代表没有代理：daemon 有兜底，用户看不见它就会以为「我没填就没有」
    setEnv("CIP_RUNNER_PROXY", "http://10.0.0.1:3128");
    const { proxy, panel } = previewDefaultDotEnv("");
    expect(proxy).toBe("http://10.0.0.1:3128");
    expect(panel[1]).toEqual({ key: "HTTPS_PROXY", value: "http://10.0.0.1:3128" });
  });

  it("writes no proxy block when there is no proxy at all", () => {
    setEnv("CIP_RUNNER_PROXY", undefined);
    const { proxy, panel } = previewDefaultDotEnv("   ");
    expect(proxy).toBe("");
    expect(panel).toEqual([]);
  });
});
