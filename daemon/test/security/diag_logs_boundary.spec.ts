import fs from "fs-extra";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { OUTSIDE_ROOT, SCAN_ROOT } from "../setup";
import { readRunnerDiag } from "../../src/service/runner_logs";

// readRunnerDiag reaches the filesystem three times with three separately-derived paths —
// `dir`, `<dir>/_diag`, and `<diag>/<file>` — and every one of them needs its own guard.
// Guarding only `dir` is the naive fix: _diag can itself be a symlink out, and so can any
// *.log inside it, and statSync/readdirSync/openSync all follow links.

const OUTSIDE_SECRET = path.join(OUTSIDE_ROOT, "diag-secret");
const runnerDir = path.join(SCAN_ROOT, "diag-repo", "runner-a");

beforeAll(() => {
  fs.mkdirsSync(OUTSIDE_SECRET);
  fs.writeFileSync(path.join(OUTSIDE_SECRET, "Runner_stolen.log"), "secret log contents\n");

  fs.mkdirsSync(path.join(runnerDir, "_diag"));
  fs.writeFileSync(path.join(runnerDir, "_diag", "Runner_ok.log"), "line one\nline two\nline three\n");
});

describe("guard 1 — the runner directory itself", () => {
  it("rejects a directory outside the roots", () => {
    expect(() => readRunnerDiag(OUTSIDE_SECRET)).toThrow(/只允许在扫描根下操作/);
  });

  it("rejects a relative path and /", () => {
    expect(() => readRunnerDiag("relative")).toThrow(/绝对路径/);
    expect(() => readRunnerDiag("/")).toThrow(/绝对路径/);
  });

  it("rejects before it distinguishes existing from missing", () => {
    // The guard runs ahead of fs.existsSync on purpose: an out-of-roots path and a
    // non-existent one must produce the same error, or the endpoint becomes a probe for
    // which directories exist on the host.
    const missingOutside = path.join(OUTSIDE_ROOT, "definitely-not-here");
    expect(() => readRunnerDiag(missingOutside)).toThrow(/只允许在扫描根下操作/);
    expect(() => readRunnerDiag("/etc")).toThrow(/只允许在扫描根下操作/);
  });
});

describe("guard 2 — <dir>/_diag, which can be a symlink of its own", () => {
  it("rejects when _diag points outside the roots", () => {
    const dir = path.join(SCAN_ROOT, "diag-repo", "runner-linked-diag");
    fs.mkdirsSync(dir);
    const diag = path.join(dir, "_diag");
    if (!fs.existsSync(diag)) fs.symlinkSync(OUTSIDE_SECRET, diag);
    // `dir` is genuinely inside the roots, so a guard on `dir` alone lets this through and
    // the reader then lists and returns files from OUTSIDE_SECRET.
    expect(() => readRunnerDiag(dir)).toThrow(/只允许在扫描根下操作/);
  });
});

describe("guard 3 — a *.log inside _diag, which can also be a symlink", () => {
  it("rejects when the requested log points outside the roots", () => {
    const dir = path.join(SCAN_ROOT, "diag-repo", "runner-linked-log");
    const diag = path.join(dir, "_diag");
    fs.mkdirsSync(diag);
    const link = path.join(diag, "Runner_escape.log");
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(OUTSIDE_SECRET, "Runner_stolen.log"), link);
    // Both `dir` and `_diag` are inside; the filename passes the traversal filter because it
    // is a plain basename and appears in the listing. Only the targetPath guard stops it.
    expect(() => readRunnerDiag(dir, { file: "Runner_escape.log" })).toThrow(
      /只允许在扫描根下操作/
    );
  });
});

describe("the filename filter, which is a separate concern from the symlink guards", () => {
  it("rejects traversal characters in the requested filename", () => {
    for (const file of ["../escape.log", "sub/nested.log", "..\\windows.log"]) {
      expect(() => readRunnerDiag(runnerDir, { file }), file).toThrow(/非法的日志文件名/);
    }
  });

  it("rejects a name that is not in the listing", () => {
    expect(() => readRunnerDiag(runnerDir, { file: "Runner_nope.log" })).toThrow(
      /日志文件不存在/
    );
  });
});

describe("the happy path still works", () => {
  it("reads the tail of a real log inside the roots", () => {
    const res = readRunnerDiag(runnerDir);
    expect(res.file).toBe("Runner_ok.log");
    expect(res.content).toContain("line three");
    expect(res.files.map((f) => f.name)).toEqual(["Runner_ok.log"]);
    expect(res.nextOffset).toBe(res.size);
  });

  it("reports no logs rather than throwing when _diag is empty", () => {
    const dir = path.join(SCAN_ROOT, "diag-repo", "runner-empty");
    fs.mkdirsSync(path.join(dir, "_diag"));
    const res = readRunnerDiag(dir);
    expect(res.files).toEqual([]);
    expect(res.file).toBe("");
  });

  it("throws a distinguishable error when _diag is absent entirely", () => {
    const dir = path.join(SCAN_ROOT, "diag-repo", "runner-no-diag");
    fs.mkdirsSync(dir);
    expect(() => readRunnerDiag(dir)).toThrow(/还没有 _diag 日志/);
  });
});
