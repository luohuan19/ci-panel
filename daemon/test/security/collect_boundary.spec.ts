import fs from "fs-extra";
import path from "path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { OUTSIDE_ROOT, SCAN_ROOT } from "../setup";
import { scanRunners } from "../../src/service/runner_scan";

// scanRunners walks every entry under /proc to find runners with a live Runner.Worker, which
// costs roughly a second per call however few directories are being scanned. That is what the
// widened timeout is for; the assertions themselves are synchronous. It is NOT systemctl —
// with no valid .service files, querySystemd returns before spawning anything.
vi.setConfig({ testTimeout: 30000 });

// scanRunners walks <root>/<repo>/<runner>. The walk itself is the boundary here: statSync,
// readdirSync and the .runner read all follow symlinks, so a guard applied only to the root
// leaves every level below it unchecked.

const OUTSIDE_RUNNER = path.join(OUTSIDE_ROOT, "collect-secret-runner");
const base = path.join(SCAN_ROOT, "collect-repo");

const writeRunnerFile = (dir: string, agentName: string) => {
  fs.mkdirsSync(dir);
  fs.writeFileSync(
    path.join(dir, ".runner"),
    JSON.stringify({ gitHubUrl: "https://github.com/example-org/example-repo", agentName })
  );
};

beforeAll(() => {
  writeRunnerFile(OUTSIDE_RUNNER, "outside-agent");
  writeRunnerFile(path.join(base, "runner-inside"), "inside-agent");
});

describe("an explicitly requested root must be inside the configured roots", () => {
  it("refuses to enumerate an unrelated directory", async () => {
    // Without this the endpoint becomes "let the daemon enumerate .runner files anywhere
    // and read their contents back". Callers may narrow the roots, never widen them.
    const res = await scanRunners(["/etc"]);
    expect(res.runners).toEqual([]);
    expect(res.errors.some((e) => e.dir === "/etc")).toBe(true);
  });

  it("refuses a relative root and / itself", async () => {
    const relative = await scanRunners(["not/absolute"]);
    expect(relative.errors[0].error).toMatch(/绝对路径/);
    const slash = await scanRunners(["/"]);
    expect(slash.errors[0].error).toMatch(/绝对路径/);
  });

  it("reports a missing directory rather than silently returning nothing", async () => {
    const res = await scanRunners([path.join(SCAN_ROOT, "no-such-dir")]);
    expect(res.runners).toEqual([]);
    expect(res.errors[0].error).toMatch(/目录不存在/);
  });
});

describe("the recursive walk is guarded at every level, not just the root", () => {
  it("skips a child symlinked outside the roots, and says so", async () => {
    const link = path.join(base, "linked-runner");
    if (!fs.existsSync(link)) fs.symlinkSync(OUTSIDE_RUNNER, link);

    const res = await scanRunners([base]);

    // The escaping child must not appear as a runner...
    expect(res.runners.map((r) => r.dir)).not.toContain(link);
    expect(res.runners.map((r) => r.agentName)).not.toContain("outside-agent");
    // ...and it must be reported, not dropped silently. A skipped directory that leaves no
    // trace reads as "there was nothing there", which is a different and wrong conclusion.
    expect(res.errors.some((e) => e.dir === link)).toBe(true);
    expect(res.errors.find((e) => e.dir === link)?.error).toMatch(/只允许在扫描根下操作/);
  });

  it("keeps collecting the legitimate siblings", async () => {
    // Skipping must be per-entry: one escaping link cannot abort the whole scan, or a
    // single bad symlink would hide every real runner on the node.
    const res = await scanRunners([base]);
    expect(res.runners.map((r) => r.agentName)).toContain("inside-agent");
  });

  it("still collects through a symlink that stays inside the roots", async () => {
    const realDir = path.join(SCAN_ROOT, "collect-elsewhere", "runner-real");
    writeRunnerFile(realDir, "inside-linked-agent");
    const link = path.join(base, "inside-linked");
    if (!fs.existsSync(link)) fs.symlinkSync(realDir, link);

    const res = await scanRunners([base]);
    expect(res.runners.map((r) => r.agentName)).toContain("inside-linked-agent");
  });
});
