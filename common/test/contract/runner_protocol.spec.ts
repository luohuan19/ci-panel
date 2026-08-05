import { describe, expect, it } from "vitest";
import {
  collectRegisteredRepoSlugs,
  type RegisterRunnerResult,
  type RegisterRunnersResponse
} from "../../src/runner_protocol";

// panel forwards daemon's runner/register reply and mines it for repo slugs to auto-register.
// RemoteRequest returns `unknown`, so panel used to write
//   (result as { results?: RegisterRunnerResult[] })?.results
// — an assertion nothing checks. Rename a field on the daemon side and the compiler stays silent,
// `results` is undefined at runtime, the loop never runs, and `registeredRepos` is permanently
// empty: the repo list keeps showing "unmanaged" with no error anywhere.
//
// The narrowing now lives beside the type declaration it depends on, and this pins both.

const REPO = "example-org/example-repo";
const OTHER = "example-org/other-repo";

const ok = (dir: string, repo: string): RegisterRunnerResult => ({ dir, ok: true, repo });

describe("the happy path panel actually depends on", () => {
  it("collects the repo of every successful item", () => {
    const payload: RegisterRunnersResponse = {
      results: [ok("/r/a", REPO), ok("/r/b", OTHER)]
    };
    expect(collectRegisteredRepoSlugs(payload).sort()).toEqual([OTHER, REPO].sort());
  });

  it("deduplicates — several runners usually share one repo", () => {
    const payload: RegisterRunnersResponse = {
      results: [ok("/r/a", REPO), ok("/r/b", REPO), ok("/r/c", REPO)]
    };
    expect(collectRegisteredRepoSlugs(payload)).toEqual([REPO]);
  });
});

describe("what must NOT be collected", () => {
  it("skips failed items", () => {
    // A failed item's repo may be the caller-supplied fallback rather than the slug daemon read
    // from .runner. Registering that produces a registry key that never matches managed_list.
    const payload: RegisterRunnersResponse = {
      results: [{ dir: "/r/a", ok: false, repo: REPO, error: "boom" }, ok("/r/b", OTHER)]
    };
    expect(collectRegisteredRepoSlugs(payload)).toEqual([OTHER]);
  });

  it("skips successful items with no repo", () => {
    // daemon leaves `repo` unset when it could not parse .runner.
    const payload: RegisterRunnersResponse = {
      results: [{ dir: "/r/a", ok: true }, ok("/r/b", REPO)]
    };
    expect(collectRegisteredRepoSlugs(payload)).toEqual([REPO]);
  });

  it("skips an empty-string repo", () => {
    expect(collectRegisteredRepoSlugs({ results: [{ dir: "/r/a", ok: true, repo: "" }] })).toEqual(
      []
    );
  });

  it("treats a truthy-but-not-true ok as a failure", () => {
    // `ok` is declared boolean; anything else means the payload is not what it claims to be.
    expect(
      collectRegisteredRepoSlugs({ results: [{ dir: "/r/a", ok: 1, repo: REPO }] })
    ).toEqual([]);
  });
});

describe("it survives a payload that is not the shape it claims", () => {
  // The whole reason this is a function rather than a cast: the input is `unknown` off the wire.
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "nope"],
    ["a number", 42],
    ["an empty object", {}],
    ["results missing", { registeredRepos: [] }],
    ["results not an array", { results: "nope" }],
    ["results null", { results: null }],
    ["an array of junk", { results: [null, undefined, 7, "x", []] }]
  ])("returns [] for %s", (_label, payload) => {
    expect(collectRegisteredRepoSlugs(payload)).toEqual([]);
  });

  it("does not throw on a nested null", () => {
    expect(() => collectRegisteredRepoSlugs({ results: [null] })).not.toThrow();
  });
});

describe("the field names are the contract", () => {
  // These read as tautologies but are not: they are what makes a daemon-side rename fail here
  // instead of silently at runtime. The literal strings are the point.
  it("reads the list from `results`", () => {
    expect(collectRegisteredRepoSlugs({ results: [ok("/r/a", REPO)] })).toEqual([REPO]);
    // The same payload under any other key yields nothing — which is exactly the silent failure
    // the old cast produced.
    expect(collectRegisteredRepoSlugs({ items: [ok("/r/a", REPO)] })).toEqual([]);
    expect(collectRegisteredRepoSlugs({ runners: [ok("/r/a", REPO)] })).toEqual([]);
  });

  it("reads `ok` and `repo` from each item", () => {
    expect(collectRegisteredRepoSlugs({ results: [{ dir: "/r/a", success: true, repo: REPO }] }))
      .toEqual([]);
    expect(collectRegisteredRepoSlugs({ results: [{ dir: "/r/a", ok: true, slug: REPO }] }))
      .toEqual([]);
  });

  it("keeps RegisterRunnersResponse assignable to what the function accepts", () => {
    // A compile-time check with a runtime tail. `npm run build --prefix common` does NOT cover
    // this — its tsconfig includes `src/**/*` only, and vitest transpiles through esbuild without
    // type-checking. `npm run type-check --prefix common` (tsconfig.test.json) is what sees it;
    // verified by renaming the interface, which reports this exact line.
    const response: RegisterRunnersResponse = { results: [], registeredRepos: [] };
    expect(collectRegisteredRepoSlugs(response)).toEqual([]);
  });
});
