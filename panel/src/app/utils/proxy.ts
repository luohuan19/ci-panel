// 代理地址这个请求参数的边界校验。
//
// 它从浏览器来，被原样转发过 daemon socket，再作为环境变量预览的一部分回到页面上——所以类型
// 对了远不够：一个几 MB 的字符串照样能顺着这条链路走一圈，而一个带换行的值在环境变量语境里
// 从来都不是"一个值"。
//
// 故意不限制协议形状：daemon 侧的 resolveProxy 与既有的 /proxy_check 都不限，只在某一个路由上
// 收紧成 ^https?:// ，会让面板拒掉一个 daemon 本来能用的代理，而使用者完全看不出为什么。

// 宽到任何真实的 http://user:pass@host:port 都放得下，窄到挡住把这个字段当载荷通道用的请求。
export const MAX_PROXY_LEN = 512;

export type ProxyArgResult = { ok: true; proxy: string } | { ok: false; err: string };

// 校验并规范化可选的 proxy 参数。缺省与空串都合法（表示"不用代理"，daemon 侧另有兜底）。
export function validateProxyArg(value: unknown): ProxyArgResult {
  if (value !== undefined && typeof value !== "string") {
    return { ok: false, err: "proxy must be a string" };
  }
  const proxy = typeof value === "string" ? value.trim() : "";
  if (proxy.length > MAX_PROXY_LEN) {
    return { ok: false, err: `proxy must be at most ${MAX_PROXY_LEN} chars` };
  }
  if (/\s/.test(proxy)) {
    return { ok: false, err: "proxy must not contain whitespace" };
  }
  return { ok: true, proxy };
}
