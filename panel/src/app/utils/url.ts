/**
 * Check if a URL is safe for external requests.
 *
 * Blocks the **literal** spellings of loopback, private and link-local targets, so an
 * operator-supplied URL cannot trivially be pointed at services only reachable from the
 * panel/daemon host (SSRF).
 *
 * ⚠️ 这是主机名层面的检查,**不解析 DNS**。`http://127.0.0.1.nip.io/` 之类指向内网的公网域名
 * 照样通过 —— 挡住那一类需要在连接时校验解析出的地址(Node 的 lookup 钩子),那是另一件事。
 * 别把本函数当成完整的 SSRF 防线,它只是把门槛抬到「得自己准备一个域名」。
 *
 * panel 与 daemon 各有一份,必须逐字符一致 —— 由 panel/test/security/safe_url.spec.ts 锁住。
 */
export function checkSafeUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    // 只允许 http/https。放在最前只是为了让最粗的那道筛子先跑 —— 本函数是一串 && ,
    // 顺序不改变任何一个输入的结论。(下面的空标签检查其实也能挡住 file:,因为它的 hostname
    // 是空串;但靠那个是巧合,不是意图。)
    if (!["http:", "https:"].includes(urlObj.protocol)) {
      return false;
    }

    // IPv6 被 URL 解析成 [..] 包裹的形式。一律拒绝——回环 ::1、链路本地 fe80::、
    // IPv4 映射 ::ffff:127.0.0.1 都在里面,逐段判定不如整类拒绝可靠。
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      return false;
    }

    // 数字 IPv4 一律拒绝。这里刻意比「只拦私有网段」更严:公网 IP 直连也绕过了 DNS,
    // 而本函数的调用方(下载、代理)从来只需要域名。
    //
    // 之前这下面还有一段逐个判定 10/172.16/192.168/127/169.254 的代码,永远执行不到——
    // 上面这个 return 已经把所有 IPv4 挡光了。删掉而不是留着,免得让人误以为放行了公网 IP。
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
      return false;
    }

    // 回环与通配地址的域名写法
    if (["localhost", "0.0.0.0", "::1"].includes(hostname)) {
      return false;
    }

    // mDNS 的 .local,以及内网常见的单标签主机名(见下面的点号检查)
    if (hostname.endsWith(".local")) {
      return false;
    }

    // 必须是带点的多段域名。单标签主机名(intranet、gitlab)只在内网 DNS 里解析得出,
    // 正是要挡的那一类。
    const parts = hostname.split(".");
    if (parts.length < 2 || parts.some((part) => part.length === 0)) {
      return false;
    }

    return true;
  } catch (error) {
    return false;
  }
}
