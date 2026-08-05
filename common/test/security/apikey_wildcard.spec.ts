import { describe, expect, it } from "vitest";
import { LocalFileSource } from "../../src/query_wrapper";

// Placeholder credentials only — this is a public repository.
const API_KEY = "PLACEHOLDER_API_KEY_VALUE";

describe("a bare % is not a wildcard", () => {
  // The old form keyed off the leading % alone and searched for slice(1, length - 1), so "%"
  // searched for "" — and "".includes("") is always true, matching every record. panel's
  // getUuidByApiKey accepts when total === 1, so on a single-user panel `?apikey=%` resolved
  // to that user and permission() then granted their level to the request.
  const single = new LocalFileSource([{ uuid: "u-1", apiKey: API_KEY, permission: 10 }]);

  it("does not match every record", () => {
    expect(single.selectPage({ apiKey: "%" }, 1, 1).total).toBe(0);
  });

  it("does not match on a two-character value either", () => {
    // The length guard is `> 2`, so "%%" is still an exact comparison and has no needle.
    expect(single.selectPage({ apiKey: "%%" }, 1, 1).total).toBe(0);
  });

  it("still matches the real key exactly", () => {
    expect(single.selectPage({ apiKey: API_KEY }, 1, 1).total).toBe(1);
  });

  it("does not match a wrong key", () => {
    expect(single.selectPage({ apiKey: "NOT_THE_KEY" }, 1, 1).total).toBe(0);
  });
});

describe("a pattern needs BOTH a leading and a trailing %", () => {
  const single = new LocalFileSource([{ apiKey: API_KEY }]);

  it("treats a leading-% value as an exact comparison", () => {
    expect(single.selectPage({ apiKey: "%PLACEHOLDER" }, 1, 1).total).toBe(0);
  });

  it("does not resurrect the off-by-one slice on a leading-only %", () => {
    // The old code sliced (1, length - 1) whatever the shape, so "%abc" searched for "ab" and
    // matched a record holding "abd". Both must now miss: "%abc" is not a pattern at all.
    const rows = new LocalFileSource([{ k: "abc" }, { k: "abd" }]);
    expect(rows.selectPage({ k: "%abc" }, 1, 10).total).toBe(0);
  });

  it("treats a trailing-% value as an exact comparison", () => {
    expect(single.selectPage({ apiKey: "PLACEHOLDER%" }, 1, 1).total).toBe(0);
  });
});

describe("the %needle% form the admin search depends on", () => {
  // manage_user_router builds `%${userName}%` for its user search, so this must keep working —
  // it is the reason the pattern branch exists at all rather than being deleted outright.
  const users = new LocalFileSource([
    { userName: "alice" },
    { userName: "albert" },
    { userName: "bob" }
  ]);

  it("matches a substring", () => {
    expect(users.selectPage({ userName: "%al%" }, 1, 10).total).toBe(2);
  });

  it("matches nothing when the needle is absent", () => {
    expect(users.selectPage({ userName: "%zz%" }, 1, 10).total).toBe(0);
  });

  it("slices off exactly one character at each end", () => {
    // A contract assertion, not a regression guard — the pre-fix code got %abc% right too.
    // The off-by-one it used to have is pinned by the leading-only-% case above.
    const rows = new LocalFileSource([{ k: "abc" }, { k: "abd" }]);
    expect(rows.selectPage({ k: "%abc%" }, 1, 10).total).toBe(1);
    expect(rows.selectPage({ k: "%abc%" }, 1, 10).data).toEqual([{ k: "abc" }]);
  });

  it("does not treat a non-string condition value as a pattern", () => {
    const rows = new LocalFileSource([{ n: 1 }, { n: 2 }]);
    expect(rows.selectPage({ n: 1 }, 1, 10).total).toBe(1);
  });

  it("does not match a pattern against a non-string field", () => {
    const rows = new LocalFileSource([{ n: 123 }]);
    expect(rows.selectPage({ n: "%12%" }, 1, 10).total).toBe(0);
  });
});

describe("what this layer does NOT protect against", () => {
  // Documented on purpose, so nobody reads the specs above as "the query layer is the
  // defence". It is not. `%needle%` is still a substring match by design, so a caller that
  // trusts `total === 1` can be fed a partial key. The actual guard is panel's
  // getUuidByApiKey, which re-checks `user.apiKey === apiKey` byte-for-byte after the
  // lookup — covered in Phase 4 when panel gets a suite (TESTING.md §2.1).
  it("still resolves a single user from a partial key", () => {
    const single = new LocalFileSource([{ apiKey: API_KEY }]);
    expect(single.selectPage({ apiKey: "%PLACEHOLDER_API%" }, 1, 1).total).toBe(1);
  });
});
