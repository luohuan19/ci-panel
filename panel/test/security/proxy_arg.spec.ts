import { describe, expect, it } from "vitest";
import "../setup";
import { MAX_PROXY_LEN, validateProxyArg } from "../../src/app/utils/proxy";

// The proxy argument of /runner/default_env comes from a browser, is forwarded verbatim over the
// daemon socket, and comes back as part of an environment-variable preview rendered in the page.
// A type check alone does not make it safe to carry: a multi-megabyte string rides that whole
// chain, and a value containing a newline is not one value in any environment-variable context.
//
// The route used to check `typeof === "string"` and nothing else — every case below except the
// first two goes red against that.

describe("what it accepts", () => {
  it("accepts an ordinary proxy URL and trims it", () => {
    expect(validateProxyArg("  http://127.0.0.1:7892  ")).toEqual({
      ok: true,
      proxy: "http://127.0.0.1:7892"
    });
  });

  it("treats absent and empty as 'no proxy', not as an error", () => {
    // 表单留空是常态：daemon 侧还有 CIP_RUNNER_PROXY 兜底，这里不该替它做判断
    expect(validateProxyArg(undefined)).toEqual({ ok: true, proxy: "" });
    expect(validateProxyArg("")).toEqual({ ok: true, proxy: "" });
    expect(validateProxyArg("   ")).toEqual({ ok: true, proxy: "" });
  });

  it("does not police the scheme", () => {
    // 协议形状故意不限：daemon 的 resolveProxy 与既有的 /proxy_check 都不限，只在这一个
    // 路由上收紧成 ^https?:// 会让面板拒掉一个 daemon 本来能用的代理
    for (const value of [
      "https://user:pass@proxy.internal:3128",
      "socks5://127.0.0.1:1080",
      "127.0.0.1:7892"
    ]) {
      expect(validateProxyArg(value), value).toEqual({ ok: true, proxy: value });
    }
  });
});

describe("what it rejects", () => {
  it("rejects a non-string", () => {
    for (const value of [1, true, null, {}, ["http://x"]]) {
      expect(validateProxyArg(value as unknown), JSON.stringify(value)).toEqual({
        ok: false,
        err: "proxy must be a string"
      });
    }
  });

  it("rejects a value past the length cap, and accepts one exactly at it", () => {
    const at = "h".repeat(MAX_PROXY_LEN);
    expect(validateProxyArg(at).ok).toBe(true);
    const over = validateProxyArg("h".repeat(MAX_PROXY_LEN + 1));
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.err).toContain(String(MAX_PROXY_LEN));
  });

  it("measures the cap after trimming, so padding cannot smuggle length past it", () => {
    expect(validateProxyArg(` ${"h".repeat(MAX_PROXY_LEN)} `).ok).toBe(true);
  });

  it.each([
    ["http://a b:3128", "空格"],
    ["http://a\nb", "换行"],
    ["http://a\tb", "制表符"],
    ["http://a\rb", "回车"]
  ])("rejects %j (%s) — internal whitespace is never part of one value", (value) => {
    const r = validateProxyArg(value);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.err).toContain("whitespace");
  });
});
