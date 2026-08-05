import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { PANEL_ROOT } from "../setup";
import { checkSafeUrl } from "../../src/app/utils/url";

// checkSafeUrl is what stops /api/auth/proxy and daemon's file/download_from_url from being used
// to reach whatever the panel or daemon host can reach but the caller cannot — cloud metadata,
// an internal registry, a service bound to loopback. Both endpoints hand the response body back,
// so a false "safe" is a read primitive, not just a request.

describe("rejects targets that are only reachable from the host", () => {
  it("rejects loopback in every spelling", () => {
    for (const url of [
      "http://localhost/x",
      "http://LOCALHOST/x",
      "http://127.0.0.1/x",
      "http://127.1.2.3/x",
      "https://0.0.0.0/",
      "http://[::1]/x"
    ]) {
      expect(checkSafeUrl(url), url).toBe(false);
    }
  });

  it("rejects private ranges", () => {
    for (const url of [
      "http://10.0.0.5/x",
      "http://172.16.0.1/x",
      "http://172.31.255.254/x",
      "http://192.168.1.1/x"
    ]) {
      expect(checkSafeUrl(url), url).toBe(false);
    }
  });

  it("rejects cloud metadata, the highest-value SSRF target there is", () => {
    expect(checkSafeUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
  });

  it("rejects every IPv4 literal, not merely the private ones", () => {
    // Deliberately stricter than "block RFC1918": a bare public IP also skips DNS, and the two
    // callers only ever legitimately need a domain.
    expect(checkSafeUrl("http://8.8.8.8/x")).toBe(false);
    expect(checkSafeUrl("http://93.184.216.34/")).toBe(false);
  });

  it("rejects IPv6 wholesale, including the IPv4-mapped forms", () => {
    for (const url of [
      "http://[::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[2001:db8::1]/"
    ]) {
      expect(checkSafeUrl(url), url).toBe(false);
    }
  });

  it("rejects single-label and .local hostnames", () => {
    // `http://gitlab/` resolves only through an internal resolver — exactly the class of target
    // this exists for.
    for (const url of ["http://gitlab/", "http://intranet/x", "http://printer.local/"]) {
      expect(checkSafeUrl(url), url).toBe(false);
    }
  });

  it("rejects a hostname with an empty label", () => {
    expect(checkSafeUrl("http://foo..com/")).toBe(false);
    expect(checkSafeUrl("http://.com/")).toBe(false);
  });
});

describe("protocol allow-list", () => {
  it("accepts only http and https", () => {
    expect(checkSafeUrl("http://example.com/x")).toBe(true);
    expect(checkSafeUrl("https://example.com/x")).toBe(true);
  });

  it("rejects file:, which reads the host filesystem", () => {
    expect(checkSafeUrl("file:///etc/passwd")).toBe(false);
    expect(checkSafeUrl("file://example.com/etc/passwd")).toBe(false);
  });

  it("rejects the other schemes an http client might still honour", () => {
    for (const url of [
      "ftp://example.com/x",
      "gopher://example.com/x",
      "data:text/plain,hello",
      "javascript:alert(1)"
    ]) {
      expect(checkSafeUrl(url), url).toBe(false);
    }
  });
});

describe("accepts ordinary public targets", () => {
  it("accepts a normal domain with path, port, query and credentials", () => {
    expect(checkSafeUrl("https://example.com")).toBe(true);
    expect(checkSafeUrl("https://sub.example.com/a/b?c=d#e")).toBe(true);
    expect(checkSafeUrl("https://example.com:8443/x")).toBe(true);
  });

  it("is not fooled by a hostname that merely contains a private-looking string", () => {
    expect(checkSafeUrl("https://127-0-0-1.example.com/")).toBe(true);
    expect(checkSafeUrl("https://localhost.example.com/")).toBe(true);
  });
});

describe("malformed input", () => {
  it("returns false rather than throwing", () => {
    for (const url of ["", "not a url", "http://", "://example.com", "http:///x"]) {
      expect(() => checkSafeUrl(url), url).not.toThrow();
      expect(checkSafeUrl(url), url).toBe(false);
    }
  });
});

describe("panel and daemon carry identical copies", () => {
  // Two copies exist because neither package imports the other, and common cannot hold it: the
  // frontend's only imports from mcsmanager-common are type-only (see
  // frontend/src/tools/__tests__/runnerNaming.spec.ts), and adding a runtime export there is a
  // separate decision. They had already drifted before this test existed — panel's had a protocol
  // allow-list and daemon's did not, so daemon accepted ftp:// targets.
  const PANEL_COPY = path.join(PANEL_ROOT, "src/app/utils/url.ts");
  const DAEMON_COPY = path.join(PANEL_ROOT, "../daemon/src/utils/url.ts");

  const body = (file: string): string => {
    const src = fs.readFileSync(file, "utf8");
    const m = src.match(/export function checkSafeUrl\([\s\S]*?\n\}/);
    if (!m) throw new Error(`no checkSafeUrl definition found in ${file}`);
    return m[0]
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n");
  };

  it("finds a definition in both files", () => {
    expect(() => body(PANEL_COPY)).not.toThrow();
    expect(() => body(DAEMON_COPY)).not.toThrow();
  });

  it("has byte-identical bodies once indentation is normalised", () => {
    expect(body(DAEMON_COPY)).toBe(body(PANEL_COPY));
  });

  it("both carry the protocol allow-list that daemon's used to be missing", () => {
    for (const f of [PANEL_COPY, DAEMON_COPY]) {
      expect(body(f), f).toContain('["http:", "https:"].includes(urlObj.protocol)');
    }
  });
});

describe("/api/auth/proxy is actually wired to the guard", () => {
  // checkSafeUrl sat in the tree with ZERO callers before this change while /api/auth/proxy
  // called axios.request on a caller-supplied URL. A spec that only exercises the function would
  // have stayed green through all of that, so this pins the call site itself.
  const ROUTER = path.join(PANEL_ROOT, "src/app/routers/login_router.ts");
  const src = () => fs.readFileSync(ROUTER, "utf8");

  const proxyRoute = (): string => {
    const text = src();
    const start = text.indexOf('router.all(\n  "/proxy"');
    if (start === -1) throw new Error("no /proxy route found in login_router.ts");
    const end = text.indexOf("\n);", start);
    return text.slice(start, end);
  };

  it("finds the route", () => {
    expect(() => proxyRoute()).not.toThrow();
  });

  it("imports and calls checkSafeUrl", () => {
    expect(src()).toMatch(/import\s+\{[^}]*checkSafeUrl[^}]*\}\s+from\s+"\.\.\/utils\/url"/);
    expect(proxyRoute()).toContain("checkSafeUrl(");
  });

  it("checks before it requests, not after", () => {
    // Order is the whole point — a guard that runs after axios.request has already made the
    // request is not a guard.
    const route = proxyRoute();
    expect(route.indexOf("checkSafeUrl(")).toBeLessThan(route.indexOf("axios.request"));
  });

  it("refuses to follow redirects", () => {
    // Without this, a hostname that resolves publicly can 302 to 127.0.0.1 and the check above
    // is bypassed entirely — the request axios ends up making is not the one that was vetted.
    expect(proxyRoute()).toContain("maxRedirects: 0");
  });

  it("still requires ADMIN", () => {
    expect(proxyRoute()).toContain("permission({ level: ROLE.ADMIN })");
  });
});

describe("what this does NOT stop — stated, not implied", () => {
  it("passes a public domain that resolves to a private address", () => {
    // Hostname-level checking only. `127.0.0.1.nip.io` has an A record pointing at loopback and
    // five labels, so nothing here objects. Closing this needs validation of the *resolved*
    // address at connect time (a Node lookup hook), which is a different mechanism.
    //
    // Asserted rather than left unsaid so the guard is not over-trusted: it raises the bar to
    // "attacker must control a domain", it does not eliminate SSRF.
    expect(checkSafeUrl("http://127.0.0.1.nip.io/")).toBe(true);
    expect(checkSafeUrl("http://169.254.169.254.nip.io/")).toBe(true);
  });

  it("still normalises the obfuscated IPv4 literals, which it does stop", () => {
    // WHATWG URL canonicalises these before the regex sees them, so they are genuinely covered
    // and this is not a second gap.
    for (const url of ["http://0x7f.0.0.1/", "http://2130706433/", "http://0177.0.0.1/", "http://127.1/"]) {
      expect(checkSafeUrl(url), url).toBe(false);
    }
  });
});
