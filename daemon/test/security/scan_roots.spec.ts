import fs from "fs-extra";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { OUTSIDE_ROOT, SCAN_ROOT } from "../setup";
import { assertUnderRoots } from "../../src/service/runner_scan";

// assertUnderRoots is the single boundary every runner path goes through. It compares
// realpathSync results rather than string prefixes, which is what makes it catch symlink
// escapes as well as `..` — a prefix check would let <root>/x -> /etc straight through.

const here = (...p: string[]) => path.join(SCAN_ROOT, ...p);

beforeAll(() => {
  fs.mkdirsSync(here("boundary"));
});

describe("rejects anything that is not inside a root", () => {
  it("rejects a relative path outright", () => {
    expect(() => assertUnderRoots("relative/path")).toThrow(/绝对路径/);
    expect(() => assertUnderRoots("")).toThrow(/绝对路径/);
  });

  it("rejects an absolute path elsewhere on the filesystem", () => {
    expect(() => assertUnderRoots("/etc")).toThrow(/只允许在扫描根下操作/);
    expect(() => assertUnderRoots(OUTSIDE_ROOT)).toThrow(/只允许在扫描根下操作/);
  });

  it("rejects the parent of a root", () => {
    expect(() => assertUnderRoots(path.dirname(SCAN_ROOT))).toThrow(/只允许在扫描根下操作/);
  });

  it("rejects a sibling whose name merely starts with the root's", () => {
    // The check appends path.sep before comparing, so "<root>-evil" must not pass as
    // "starts with <root>".
    expect(() => assertUnderRoots(`${SCAN_ROOT}-evil`)).toThrow(/只允许在扫描根下操作/);
  });

  it("rejects a path that climbs out with ..", () => {
    expect(() => assertUnderRoots(path.join(SCAN_ROOT, "..", "outside"))).toThrow(
      /只允许在扫描根下操作/
    );
  });
});

describe("accepts what is genuinely inside", () => {
  it("accepts the root itself", () => {
    expect(() => assertUnderRoots(SCAN_ROOT)).not.toThrow();
  });

  it("accepts an existing directory under the root", () => {
    expect(() => assertUnderRoots(here("boundary"))).not.toThrow();
  });

  it("accepts a path that does not exist yet", () => {
    // realpathSync throws for a missing path and the guard falls back to comparing the
    // normalised string. makeDir/listDirs depend on this — they are handed paths that are
    // about to be created.
    expect(() => assertUnderRoots(here("boundary", "not-created-yet"))).not.toThrow();
    expect(() => assertUnderRoots(here("a", "b", "c", "deep"))).not.toThrow();
  });

  it("still rejects a non-existent path outside the roots", () => {
    // The fallback must not become a way around the check.
    expect(() => assertUnderRoots("/nonexistent-top-level/whatever")).toThrow(
      /只允许在扫描根下操作/
    );
  });
});

describe("a path that does not exist is judged by where it would actually land", () => {
  // The missing-path fallback cannot be lexical. Under <root>/link -> outside, a not-yet-created
  // <root>/link/child still *reads* as being under the root, so a lexical comparison accepts it
  // and the guard's whole realpath discipline is bypassed for exactly the paths that are about
  // to be created. Resolving the deepest existing ancestor is what closes it.
  const link = () => {
    const p = here("missing-escape-link");
    if (!fs.existsSync(p)) fs.symlinkSync(OUTSIDE_ROOT, p);
    return p;
  };

  it("rejects a missing child below an escaping symlink", () => {
    expect(() => assertUnderRoots(path.join(link(), "not-created-yet"))).toThrow(
      /只允许在扫描根下操作/
    );
  });

  it("rejects a missing grandchild too, not just the first level", () => {
    expect(() => assertUnderRoots(path.join(link(), "a", "b", "c"))).toThrow(
      /只允许在扫描根下操作/
    );
  });

  it("still accepts a missing path whose deepest existing ancestor is inside", () => {
    // The reason the fallback exists at all — makeDir and listDirs are handed paths that do
    // not exist yet. Those must keep working.
    expect(() => assertUnderRoots(here("boundary", "brand-new"))).not.toThrow();
    expect(() => assertUnderRoots(here("boundary", "a", "b", "c"))).not.toThrow();
  });

  it("accepts a missing path below an in-root symlink", () => {
    const target = here("boundary", "real-target");
    fs.mkdirsSync(target);
    const inside = here("missing-inside-link");
    if (!fs.existsSync(inside)) fs.symlinkSync(target, inside);
    expect(() => assertUnderRoots(path.join(inside, "brand-new"))).not.toThrow();
  });
});

describe("symlinks — the reason this compares realpath", () => {
  it("rejects a symlink under the root that points outside", () => {
    const link = here("escape-link");
    if (!fs.existsSync(link)) fs.symlinkSync(OUTSIDE_ROOT, link);
    // A string-prefix check would accept this: the path literally starts with the root.
    expect(() => assertUnderRoots(link)).toThrow(/只允许在扫描根下操作/);
  });

  it("rejects a path that traverses through an escaping symlink", () => {
    const link = here("escape-link-2");
    if (!fs.existsSync(link)) fs.symlinkSync(OUTSIDE_ROOT, link);
    fs.mkdirsSync(path.join(OUTSIDE_ROOT, "sub"));
    expect(() => assertUnderRoots(path.join(link, "sub"))).toThrow(/只允许在扫描根下操作/);
  });

  it("accepts a symlink that stays inside the roots", () => {
    const target = here("boundary", "real-target");
    fs.mkdirsSync(target);
    const link = here("inside-link");
    if (!fs.existsSync(link)) fs.symlinkSync(target, link);
    expect(() => assertUnderRoots(link)).not.toThrow();
  });
});
