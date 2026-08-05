import { describe, expect, it } from "vitest";
import {
  daemonWsAddressToHttp,
  daemonWsAddressToWs,
  deleteHttpHeader,
  deleteWebsocketHeader,
  mapDaemonAddress,
  parseForwardAddress,
  parseIp,
  type RemoteMappingEntry
} from "../protocol";

// vitest.config.ts pins jsdom to http://panel.example.com:23333/, so every expectation below
// is a literal rather than a restatement of window.location.

describe("parseIp", () => {
  it("rewrites loopback to the page's hostname", () => {
    expect(parseIp("localhost")).toBe("panel.example.com");
    expect(parseIp("LocalHost")).toBe("panel.example.com");
    expect(parseIp("127.0.0.1")).toBe("panel.example.com");
  });

  it("leaves any other address alone", () => {
    expect(parseIp("10.0.0.5")).toBe("10.0.0.5");
    expect(parseIp("runner.example.com")).toBe("runner.example.com");
  });

  it("only matches 127.0.0.1 exactly", () => {
    // Documents a divergence from parseForwardAddress, which matches the whole 127.0.0.* prefix.
    expect(parseIp("127.0.0.2")).toBe("127.0.0.2");
  });
});

describe("deleteHttpHeader / deleteWebsocketHeader", () => {
  it("strips only its own scheme", () => {
    expect(deleteHttpHeader("http://a:1/x")).toBe("a:1/x");
    expect(deleteHttpHeader("HTTPS://a:1")).toBe("a:1");
    expect(deleteHttpHeader("ws://a:1")).toBe("ws://a:1");
    expect(deleteWebsocketHeader("wss://a:1/x")).toBe("a:1/x");
    expect(deleteWebsocketHeader("WS://a:1")).toBe("a:1");
    expect(deleteWebsocketHeader("http://a:1")).toBe("http://a:1");
  });

  it("passes through a bare address", () => {
    expect(deleteHttpHeader("a:1")).toBe("a:1");
    expect(deleteWebsocketHeader("a:1")).toBe("a:1");
  });
});

describe("daemonWsAddressToHttp", () => {
  it("maps ws -> http and wss -> https", () => {
    expect(daemonWsAddressToHttp("ws://10.0.0.5:24444")).toBe("http://10.0.0.5:24444");
    expect(daemonWsAddressToHttp("wss://10.0.0.5:24444")).toBe("https://10.0.0.5:24444");
  });

  it("returns anything else unchanged, including the default empty argument", () => {
    expect(daemonWsAddressToHttp("http://10.0.0.5:24444")).toBe("http://10.0.0.5:24444");
    expect(daemonWsAddressToHttp()).toBe("");
  });
});

describe("daemonWsAddressToWs", () => {
  it("adds ws:// only when no websocket scheme is present", () => {
    expect(daemonWsAddressToWs("10.0.0.5:24444")).toBe("ws://10.0.0.5:24444");
    expect(daemonWsAddressToWs("ws://10.0.0.5:24444")).toBe("ws://10.0.0.5:24444");
    expect(daemonWsAddressToWs("WSS://10.0.0.5:24444")).toBe("WSS://10.0.0.5:24444");
  });

  it("prefixes an http address rather than converting it", () => {
    // Documents current behaviour — the result is not a usable address.
    expect(daemonWsAddressToWs("http://10.0.0.5")).toBe("ws://http://10.0.0.5");
  });
});

describe("parseForwardAddress", () => {
  it("converts the daemon's scheme to the one the caller needs", () => {
    expect(parseForwardAddress("ws://10.0.0.5:24444", "http")).toBe("http://10.0.0.5:24444");
    expect(parseForwardAddress("wss://10.0.0.5:24444", "http")).toBe("https://10.0.0.5:24444");
    expect(parseForwardAddress("http://10.0.0.5:24444", "ws")).toBe("ws://10.0.0.5:24444");
    expect(parseForwardAddress("https://10.0.0.5:24444", "ws")).toBe("wss://10.0.0.5:24444");
  });

  it("falls back to the page's scheme when the address carries none", () => {
    // The page is http:, so an unprefixed address must not be upgraded.
    expect(parseForwardAddress("10.0.0.5:24444", "http")).toBe("http://10.0.0.5:24444");
    expect(parseForwardAddress("10.0.0.5:24444", "ws")).toBe("ws://10.0.0.5:24444");
  });

  it("rewrites a loopback daemon to the page's hostname, keeping the daemon's port", () => {
    // The browser cannot reach the daemon's own 127.0.0.1 — the panel's host is the only
    // address that resolves from where the page is running.
    expect(parseForwardAddress("ws://127.0.0.1:24444", "http")).toBe(
      "http://panel.example.com:24444"
    );
    expect(parseForwardAddress("ws://127.0.0.9:24444", "http")).toBe(
      "http://panel.example.com:24444"
    );
    expect(parseForwardAddress("ws://localhost:24444", "ws")).toBe("ws://panel.example.com:24444");
  });

  it("keeps a path suffix and parses the port ahead of it", () => {
    expect(parseForwardAddress("wss://runner.example.com:24444/daemon", "http")).toBe(
      "https://runner.example.com:24444/daemon"
    );
  });

  it("works without a port", () => {
    expect(parseForwardAddress("ws://runner.example.com", "http")).toBe(
      "http://runner.example.com"
    );
  });

  it("throws on an unparseable port instead of emitting NaN into the URL", () => {
    expect(() => parseForwardAddress("ws://10.0.0.5:notaport", "http")).toThrow(
      /port is incorrect/
    );
  });
});

describe("mapDaemonAddress", () => {
  const entry = (fromAddr: string, fromPrefix: string): RemoteMappingEntry => ({
    from: { addr: fromAddr, prefix: fromPrefix },
    to: { addr: "runner.example.com:24444", prefix: "/d" }
  });

  it("matches on the page's host and path", () => {
    expect(mapDaemonAddress([entry("panel.example.com:23333", "/")])).toEqual({
      addr: "runner.example.com:24444",
      prefix: "/d"
    });
  });

  it("treats a trailing slash as insignificant on the prefix", () => {
    expect(mapDaemonAddress([entry("panel.example.com:23333", "")])).toBeDefined();
  });

  it("returns undefined when nothing matches", () => {
    expect(mapDaemonAddress([])).toBeUndefined();
    expect(mapDaemonAddress([entry("other.example.com:23333", "/")])).toBeUndefined();
    expect(mapDaemonAddress([entry("panel.example.com:23333", "/elsewhere")])).toBeUndefined();
  });

  it("requires the port to be part of the host match", () => {
    expect(mapDaemonAddress([entry("panel.example.com", "/")])).toBeUndefined();
  });
});
