import fs from "fs-extra";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { DAEMON_ROOT, REPO_ROOT, SCAN_ROOT } from "../setup";
import { readRunnerEnv } from "../../src/service/runner_env";

// The systemd unit name comes from <runner dir>/.service — a file the runner's own owner can
// rewrite — and ends up in a systemctl argv and in a path under /etc/systemd/system. execFile
// passes an array and starts no shell, so this is not command injection, but an unconstrained
// name still selects the wrong unit or escapes the drop-in directory.
//
// The shape is declared in THREE places. The bash one is the real boundary because it runs as
// root; the two TypeScript copies only decide what the daemon bothers to ask for. They must not
// drift apart, and nothing in the build would notice if they did.

const SOURCES = [
  { label: "runner_scan.ts", file: path.join(DAEMON_ROOT, "src/service/runner_scan.ts") },
  { label: "runner_env.ts", file: path.join(DAEMON_ROOT, "src/service/runner_env.ts") }
];
const HELPER = path.join(REPO_ROOT, "prod-scripts/ci-panel-runner-svc");

const extractTs = (file: string): string => {
  // Tolerate an `export` prefix: the most likely future refactor is exporting SERVICE_RE from
  // runner_scan.ts to remove exactly the duplication this spec polices, and that must not make
  // the extraction throw. If it ever does fail, it fails loudly — every case in this file
  // disappears and the run exits non-zero, rather than passing vacuously.
  const m = fs.readFileSync(file, "utf8").match(/^(?:export )?const SERVICE_RE = \/(.+)\/;$/m);
  if (!m) throw new Error(`no SERVICE_RE literal found in ${file}`);
  return m[1];
};

const extractBash = (file: string): string => {
  const m = fs.readFileSync(file, "utf8").match(/^SERVICE_RE='(.+)'$/m);
  if (!m) throw new Error(`no SERVICE_RE assignment found in ${file}`);
  return m[1];
};

describe("all three declarations agree", () => {
  it("the two TypeScript copies are byte-identical", () => {
    const [scan, env] = SOURCES.map((s) => extractTs(s.file));
    expect(scan).toBe(env);
  });

  it("the privileged helper's copy matches the daemon's", () => {
    // If the helper's pattern were ever narrowed, the daemon would happily send names the
    // helper then rejects — the failure would land after the runner is already registered
    // with GitHub, which is the expensive place to discover it.
    expect(extractBash(HELPER)).toBe(extractTs(SOURCES[0].file));
  });
});

describe("the shape it actually accepts", () => {
  const re = new RegExp(extractTs(SOURCES[0].file));

  it("accepts a real unit name", () => {
    expect(re.test("actions.runner.example-org-example-repo.runner-1.service")).toBe(true);
    expect(re.test("actions.runner.a_b.c@d.service")).toBe(true);
  });

  it("rejects anything with a path separator", () => {
    for (const bad of [
      "actions.runner.a/../../etc/passwd.service",
      "actions.runner.a/b.service",
      "actions.runner.a\\b.service"
    ]) {
      expect(re.test(bad), bad).toBe(false);
    }
  });

  it("rejects whitespace, which would split into extra argv entries downstream", () => {
    for (const bad of [
      "actions.runner.a b.service",
      "actions.runner.a\tb.service",
      "actions.runner.a\nb.service",
      " actions.runner.a.service",
      "actions.runner.a.service "
    ]) {
      expect(re.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("rejects a name that only looks like a systemctl option", () => {
    // querySystemd appends --property after the unit list, and systemctl's options are not
    // positional — an option-shaped entry would change the query.
    expect(re.test("--property=Nope")).toBe(false);
    expect(re.test("actions.runner.x.service --property=Nope")).toBe(false);
  });

  it("requires both the prefix and the suffix", () => {
    for (const bad of [
      "sshd.service",
      "actions.runner..service",
      "actions.runner.x.timer",
      "actions.runner.x",
      "prefix-actions.runner.x.service"
    ]) {
      expect(re.test(bad), bad).toBe(false);
    }
  });

  it("is anchored, so a newline cannot smuggle a second line past it", () => {
    // A non-anchored or multiline pattern would accept this; the $ must mean end-of-string.
    expect(re.test("actions.runner.x.service\nevil.service")).toBe(false);
  });
});

describe("readRunnerEnv enforces the boundary end to end", () => {
  const runnerDir = path.join(SCAN_ROOT, "env-repo", "runner-env");

  beforeAll(() => {
    fs.mkdirsSync(runnerDir);
    fs.writeFileSync(path.join(runnerDir, ".runner"), "{}");
  });

  it("refuses a directory outside the scan roots", () => {
    expect(() => readRunnerEnv("/etc")).toThrow(/只允许在扫描根下操作/);
  });

  it("refuses a directory that is not a runner", () => {
    const plain = path.join(SCAN_ROOT, "env-repo", "not-a-runner");
    fs.mkdirsSync(plain);
    expect(() => readRunnerEnv(plain)).toThrow(/不是 runner 目录/);
  });

  it("refuses a malformed unit name rather than passing it on", () => {
    // .service is attacker-writable if the runner account is compromised; reading it must
    // fail loudly instead of feeding the value to systemctl or to a path join.
    fs.writeFileSync(path.join(runnerDir, ".service"), "../../etc/evil.service");
    expect(() => readRunnerEnv(runnerDir)).toThrow(/非法的服务名/);
  });

  it("treats an absent .service as 'no unit installed', not as an error", () => {
    fs.removeSync(path.join(runnerDir, ".service"));
    expect(() => readRunnerEnv(runnerDir)).not.toThrow();
  });
});
