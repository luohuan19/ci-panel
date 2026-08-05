import fs from "fs-extra";
import path from "path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { OUTSIDE_ROOT, SCAN_ROOT } from "../setup";
import { hasMarker, metaFilePath, readMarker } from "../../src/service/runner_marker";
import { readServiceName, scanRunners } from "../../src/service/runner_scan";

// scanRunners walks /proc to find busy runners, which costs about a second per call regardless
// of how few directories are involved. That is the whole reason for the widened timeout — the
// assertions themselves are synchronous. Nothing here waits on systemctl: with no valid
// .service files, querySystemd returns before it spawns anything.
vi.setConfig({ testTimeout: 30000 });

// Guarding the runner *directory* is not enough. The three metadata files are writable by the
// runner's own account, and readFileSync follows links — so a directory that is legitimately
// inside the roots can still hand back the contents of a file anywhere on the host.
//
// The constraint is "the file must not escape its own directory", not "must be under the scan
// roots": managed runners are allowed to live outside the roots (they are discovered through
// their handle instance's cwd), so a roots check would break them.

const OUTSIDE = path.join(OUTSIDE_ROOT, "meta");
const SECRET_JSON = path.join(OUTSIDE, "secret.json");
const SECRET_TEXT = path.join(OUTSIDE, "secret.txt");
const base = path.join(SCAN_ROOT, "meta-repo");

const linkMeta = (dirName: string, metaName: string, target: string) => {
  const dir = path.join(base, dirName);
  fs.mkdirsSync(dir);
  const link = path.join(dir, metaName);
  if (!fs.existsSync(link)) fs.symlinkSync(target, link);
  return dir;
};

beforeAll(() => {
  fs.mkdirsSync(OUTSIDE);
  fs.writeFileSync(
    SECRET_JSON,
    JSON.stringify({ gitHubUrl: "https://github.com/secret-org/secret-repo", agentName: "secret-agent" })
  );
  fs.writeFileSync(SECRET_TEXT, "SENSITIVE_FIRST_LINE\nmore\n");
});

describe("metaFilePath", () => {
  it("accepts a real file in the directory", () => {
    const dir = path.join(base, "plain");
    fs.mkdirsSync(dir);
    fs.writeFileSync(path.join(dir, ".runner"), "{}");
    expect(() => metaFilePath(dir, ".runner")).not.toThrow();
  });

  it("rejects a metadata file symlinked elsewhere", () => {
    const dir = linkMeta("escaped-runner", ".runner", SECRET_JSON);
    expect(() => metaFilePath(dir, ".runner")).toThrow(/逃出了 runner 目录/);
  });

  it("throws ENOENT when the file is simply absent", () => {
    // Callers distinguish this from an escape — absent means "not installed", not "hostile".
    const dir = path.join(base, "no-meta");
    fs.mkdirsSync(dir);
    expect(() => metaFilePath(dir, ".service")).toThrow(
      expect.objectContaining({ code: "ENOENT" })
    );
  });

  it("accepts a symlink that stays within the same directory", () => {
    const dir = path.join(base, "self-link");
    fs.mkdirsSync(dir);
    fs.writeFileSync(path.join(dir, "real.json"), "{}");
    const link = path.join(dir, ".runner");
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(dir, "real.json"), link);
    expect(() => metaFilePath(dir, ".runner")).not.toThrow();
  });
});

describe(".cipanel — an escaped marker must not be treated as a marker", () => {
  it("hasMarker returns false rather than opening the boundary", () => {
    // registerRunners and scanOneRunner skip assertUnderRoots when a marker is present, so a
    // marker that is really a symlink elsewhere would hand away the boundary itself.
    const dir = linkMeta("escaped-marker", ".cipanel", SECRET_JSON);
    expect(hasMarker(dir)).toBe(false);
  });

  it("readMarker returns null rather than the linked file's contents", () => {
    const dir = path.join(base, "escaped-marker");
    expect(readMarker(dir)).toBeNull();
  });
});

describe(".service — an escaped unit file", () => {
  it("is rejected instead of being fed to systemctl or a /etc path join", () => {
    const dir = linkMeta("escaped-service", ".service", SECRET_TEXT);
    expect(() => readServiceName(dir)).toThrow(/逃出了 runner 目录/);
  });

  it("an absent .service still reads as 'no unit installed'", () => {
    const dir = path.join(base, "no-meta");
    expect(readServiceName(dir)).toBe("");
  });
});

describe(".runner — the file whose contents reach the browser", () => {
  it("does not report a linked file's repo and agent name as a runner's own", async () => {
    linkMeta("escaped-json", ".runner", SECRET_JSON);
    const res = await scanRunners([base]);
    const found = res.runners.find((r) => path.basename(r.dir) === "escaped-json");
    expect(found?.repo).not.toBe("secret-org/secret-repo");
    expect(found?.agentName).not.toBe("secret-agent");
  });

  it("does not leak a content prefix through the JSON parse error", async () => {
    // Node's JSON.parse message embeds the first ~10 characters of the input, and that
    // message is surfaced to the UI as `broken`. Reading an arbitrary file therefore leaked
    // its opening bytes even when parsing failed.
    linkMeta("escaped-text", ".runner", SECRET_TEXT);
    const res = await scanRunners([base]);
    const found = res.runners.find((r) => path.basename(r.dir) === "escaped-text");
    expect(found?.broken ?? "").not.toContain("SENSITIVE_");
    expect(JSON.stringify(res)).not.toContain("SENSITIVE_");
  });

  it("still reads a legitimate .runner", async () => {
    const dir = path.join(base, "honest-runner");
    fs.mkdirsSync(dir);
    fs.writeFileSync(
      path.join(dir, ".runner"),
      JSON.stringify({
        gitHubUrl: "https://github.com/example-org/example-repo",
        agentName: "honest-agent"
      })
    );
    const res = await scanRunners([base]);
    const found = res.runners.find((r) => path.basename(r.dir) === "honest-runner");
    expect(found?.repo).toBe("example-org/example-repo");
    expect(found?.agentName).toBe("honest-agent");
    expect(found?.broken).toBeUndefined();
  });
});
