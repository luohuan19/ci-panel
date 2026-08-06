import { spawnSync } from "child_process";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../setup";

// set-env creates /etc/systemd/system/<unit>.d/override.conf; uninstall has to take it away.
//
// The unit name is assembled purely from <owner-repo> and the runner's name, so deleting a runner
// and later creating one with the same name lands on the same unit — and systemd loads whatever
// drop-in is still sitting there. The new runner silently inherits the previous tenant's proxy and
// device variables, and the panel's env page reads that very file without any hint that it belongs
// to a runner that no longer exists.
//
// The catch is that `override.conf` is exactly what `systemctl edit <unit>` writes, so the file the
// helper owns and one an operator hand-wrote are indistinguishable by path. Deletion is therefore
// gated on ownership evidence, and that gate is the bulk of what this file checks.
//
// It runs the real branch text and the real is_ci_panel_dropin, with only the /etc prefix and
// systemctl replaced — the rm / rmdir / awk / `set -e` semantics are the shipped ones, which is
// where the hazard actually is: an `[ -d "$dir" ] && echo` guard would abort a good uninstall.

const HELPER = path.join(REPO_ROOT, "prod-scripts/ci-panel-runner-svc");
const SVC = "actions.runner.example-org-example-repo.runner-1.service";
const REAL_SYSTEMD_DIR = "/etc/systemd/system";

const helperSource = (): string => fs.readFileSync(HELPER, "utf8");

// Pull one `case` branch out of the helper. Fails loudly if the branch is renamed or reshaped —
// every case below then errors instead of passing vacuously.
const extractBranch = (label: string): string => {
  const m = new RegExp(`^  ${label}\\)\\n([\\s\\S]*?)\\n    ;;$`, "m").exec(helperSource());
  if (!m) throw new Error(`no ${label}) branch found in ${HELPER}`);
  return m[1];
};

// Whole function definitions, verbatim. The ownership rule is the thing under test; a copy of it
// here would test the copy.
const extractFunction = (name: string): string => {
  const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, "m").exec(helperSource());
  if (!m) throw new Error(`no ${name}() definition found in ${HELPER}`);
  return m[0];
};

const MARKER = (() => {
  const m = /^DROPIN_MARKER='(.+)'$/m.exec(helperSource());
  if (!m) throw new Error(`no DROPIN_MARKER assignment found in ${HELPER}`);
  return m[1];
})();

// What set-env actually lays down, and what helper v<=3 laid down before the marker existed.
const managed = (body = 'Environment="HTTP_PROXY=http://127.0.0.1:7892"\n') =>
  `${MARKER}\n[Service]\nEnvironment=\n${body}`;
const legacyManaged = (body = 'Environment="HTTP_PROXY=http://127.0.0.1:7892"\n') =>
  `[Service]\nEnvironment=\n${body}`;
// `systemctl edit` output: same path, same name, nothing to do with the panel.
const operatorWritten = "[Service]\nNice=-5\nMemoryMax=8G\n";

let sandbox = "";
let systemdDir = "";
let dropinDir = "";
let dropinConf = "";
let runnerDir = "";

// Run a branch verbatim against the sandbox. systemctl is stubbed to a no-op: this box has no
// systemd, and the branch's dealings with it are not what is under test.
const runBranch = (label: string, vars: string[] = []) => {
  const body = extractBranch(label).split(REAL_SYSTEMD_DIR).join(systemdDir);
  expect(body, "the branch must not keep addressing the real /etc").not.toContain(REAL_SYSTEMD_DIR);
  const script = [
    "set -euo pipefail",
    "systemctl() { :; }",
    `DROPIN_MARKER='${MARKER}'`,
    extractFunction("die"),
    extractFunction("is_ci_panel_dropin"),
    `svc='${SVC}'`,
    `unit="${systemdDir}/$svc"`,
    `dir='${runnerDir}'`,
    ...vars,
    body
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  return { status: r.status, stderr: r.stderr || "", stdout: r.stdout || "" };
};

const dropinExists = () => fs.existsSync(dropinConf);
const dropinText = () => fs.readFileSync(dropinConf, "utf8");
const writeDropin = (text: string) => {
  fs.mkdirsSync(dropinDir);
  fs.writeFileSync(dropinConf, text);
};

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ci-panel-dropin-"));
  // Deliberately not ".../etc/systemd/system" — the substitution check above has to be able to
  // tell "rewritten to the sandbox" apart from "still pointing at the real thing".
  systemdDir = path.join(sandbox, "units");
  dropinDir = path.join(systemdDir, `${SVC}.d`);
  dropinConf = path.join(dropinDir, "override.conf");
  runnerDir = path.join(sandbox, "runner");
  fs.mkdirsSync(systemdDir);
  fs.mkdirsSync(runnerDir);
  fs.writeFileSync(path.join(systemdDir, SVC), "[Unit]\n");
  fs.writeFileSync(path.join(runnerDir, ".service"), `${SVC}\n`);
});

afterEach(() => {
  fs.removeSync(sandbox);
});

describe("uninstall clears what set-env leaves behind", () => {
  it("removes a marked drop-in and its directory", () => {
    writeDropin(managed());

    const r = runBranch("uninstall");

    expect(r.status, r.stderr).toBe(0);
    expect(dropinExists()).toBe(false);
    expect(fs.existsSync(dropinDir)).toBe(false);
    // The unit and the marker are the pre-existing job; a regression there is just as fatal.
    expect(fs.existsSync(path.join(systemdDir, SVC))).toBe(false);
    expect(fs.existsSync(path.join(runnerDir, ".service"))).toBe(false);
  });

  it("removes an unmarked drop-in written by helper v<=3", () => {
    // Without this, the leak stays open forever on every runner that predates the marker — which
    // is every runner currently deployed.
    writeDropin(legacyManaged());

    const r = runBranch("uninstall");

    expect(r.status, r.stderr).toBe(0);
    expect(dropinExists()).toBe(false);
  });

  it("succeeds when there is no drop-in at all", () => {
    // The common case, and the one an `&&`-chained guard would break under `set -e`: a runner that
    // never had env vars set must still uninstall cleanly, exit 0, and say nothing about drop-ins.
    const r = runBranch("uninstall");

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain(dropinDir);
    expect(fs.existsSync(path.join(systemdDir, SVC))).toBe(false);
  });
});

describe("uninstall refuses to delete what it cannot prove it wrote", () => {
  it("keeps an operator's override.conf and says so", () => {
    // `systemctl edit` writes this exact path. Deleting it would destroy configuration the panel
    // never managed and cannot restore.
    writeDropin(operatorWritten);

    const r = runBranch("uninstall");

    expect(r.status, r.stderr).toBe(0);
    expect(dropinText()).toBe(operatorWritten);
    expect(r.stderr).toContain("override.conf");
    // The unit still goes; only the drop-in is spared.
    expect(fs.existsSync(path.join(systemdDir, SVC))).toBe(false);
  });

  it("keeps a directory holding other .conf files even after removing its own", () => {
    writeDropin(managed());
    fs.writeFileSync(path.join(dropinDir, "10-operator.conf"), "[Service]\nNice=-5\n");

    const r = runBranch("uninstall");

    expect(r.status, r.stderr).toBe(0);
    expect(dropinExists()).toBe(false);
    expect(fs.readFileSync(path.join(dropinDir, "10-operator.conf"), "utf8")).toContain("Nice=-5");
    expect(r.stderr).toContain(dropinDir);
  });

  it.each([
    ["a file whose first line is not the marker or [Service]", "Environment=\n[Service]\n"],
    ["a lone [Service] line", "[Service]\n"],
    ["the legacy shape with a non-Environment line mixed in", "[Service]\nEnvironment=\nNice=-5\n"],
    ["the legacy shape without the empty Environment= reset", '[Service]\nEnvironment="A=1"\n'],
    ["an empty file", ""],
    ["a near-miss marker", `${MARKER} \n[Service]\nNice=-5\n`]
  ])("keeps %s", (_label, text) => {
    writeDropin(text);

    const r = runBranch("uninstall");

    expect(r.status, r.stderr).toBe(0);
    expect(dropinText()).toBe(text);
  });
});

describe("clearing env vars applies the same ownership gate", () => {
  // set-env with an empty payload is the panel's "remove all managed variables" path. It deletes
  // the same file by the same name, so it needs the same proof — otherwise the gate above is half
  // a gate, and the operator's config dies on a button in the env page instead.
  const clearEnv = () => runBranch("set-env", ["arg3=''", `dropin_dir='${dropinDir}'`]);

  it("removes a marked drop-in", () => {
    writeDropin(managed());

    const r = clearEnv();

    expect(r.status, r.stderr).toBe(0);
    expect(dropinExists()).toBe(false);
    expect(r.stdout).toContain("env cleared");
  });

  it("removes an unmarked drop-in written by helper v<=3", () => {
    writeDropin(legacyManaged());

    expect(clearEnv().status).toBe(0);
    expect(dropinExists()).toBe(false);
  });

  it("fails loudly rather than deleting an operator's override.conf", () => {
    // Silently doing nothing would be worse: the env page would keep listing the variables it
    // just "cleared", and the user would click again.
    writeDropin(operatorWritten);

    const r = clearEnv();

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("非本工具写入");
    expect(dropinText()).toBe(operatorWritten);
  });
});

describe("the branches agree with each other", () => {
  it("set-env writes the marker as the first line", () => {
    // The whole ownership scheme rests on this. If set-env stopped writing it, uninstall would
    // quietly stop cleaning up and the leak would return with every test above still green.
    const setEnv = extractBranch("set-env");
    expect(setEnv).toContain(`printf '%s\\n' "$DROPIN_MARKER" > "$tmp"`);
    expect(setEnv).toContain(`printf '[Service]\\n' >> "$tmp"`);
  });

  it("the marker is a systemd comment, so it cannot change how the unit parses", () => {
    expect(MARKER.startsWith("#")).toBe(true);
  });

  it("uninstall targets the same path set-env writes", () => {
    const assignment = /dropin_dir="([^"]+)"/;
    const setEnv = assignment.exec(extractBranch("set-env"));
    const uninstall = assignment.exec(extractBranch("uninstall"));
    expect(setEnv?.[1], "set-env must assign dropin_dir").toBeTruthy();
    expect(uninstall?.[1]).toBe(setEnv?.[1]);
  });

  it("bumps VERSION so a stale helper on a host is detectable", () => {
    // install-runner-privileges.sh --check compares this against the installed copy. A behaviour
    // change shipped under the old number leaves hosts silently running the leaky uninstall.
    const v = /^VERSION=(\d+)$/m.exec(helperSource());
    expect(v, "no VERSION assignment found").toBeTruthy();
    expect(Number(v?.[1])).toBeGreaterThanOrEqual(4);
  });
});
