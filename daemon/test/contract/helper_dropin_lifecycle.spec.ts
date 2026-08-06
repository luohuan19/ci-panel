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
// to a runner that no longer exists. Nothing in the daemon can see this; the two branches live a
// hundred lines apart in a root-owned bash script that no suite otherwise executes.
//
// So this runs the real branch text. Only the /etc prefix and systemctl are replaced — the rm /
// rmdir / test / `set -e` semantics are the shipped ones, which is where the hazard actually is:
// an `[ -d "$dir" ] && echo ...` guard would abort a perfectly good uninstall under `set -e`.

const HELPER = path.join(REPO_ROOT, "prod-scripts/ci-panel-runner-svc");
const SVC = "actions.runner.example-org-example-repo.runner-1.service";
const REAL_SYSTEMD_DIR = "/etc/systemd/system";

// Pull one `case` branch out of the helper. Fails loudly if the branch is renamed or reshaped —
// every case below then errors instead of passing vacuously.
const extractBranch = (label: string): string => {
  const src = fs.readFileSync(HELPER, "utf8");
  const m = new RegExp(`^  ${label}\\)\\n([\\s\\S]*?)\\n    ;;$`, "m").exec(src);
  if (!m) throw new Error(`no ${label}) branch found in ${HELPER}`);
  return m[1];
};

let sandbox = "";
let systemdDir = "";
let dropinDir = "";
let runnerDir = "";

// Run the branch verbatim against the sandbox. systemctl is stubbed to a no-op: this box has no
// systemd, and the branch's dealings with it are not what is under test.
const runBranch = (label: string): { status: number | null; stderr: string; stdout: string } => {
  const body = extractBranch(label).split(REAL_SYSTEMD_DIR).join(systemdDir);
  expect(body, "the branch must not keep addressing the real /etc").not.toContain(REAL_SYSTEMD_DIR);
  const script = [
    "set -euo pipefail",
    "systemctl() { :; }",
    `svc='${SVC}'`,
    `unit="${systemdDir}/$svc"`,
    `dir='${runnerDir}'`,
    body
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  return { status: r.status, stderr: r.stderr || "", stdout: r.stdout || "" };
};

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ci-panel-dropin-"));
  // Deliberately not ".../etc/systemd/system" — the substitution check below has to be able to
  // tell "rewritten to the sandbox" apart from "still pointing at the real thing".
  systemdDir = path.join(sandbox, "units");
  dropinDir = path.join(systemdDir, `${SVC}.d`);
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
  it("removes the drop-in file and its directory", () => {
    fs.mkdirsSync(dropinDir);
    fs.writeFileSync(path.join(dropinDir, "override.conf"), '[Service]\nEnvironment="HTTP_PROXY=x"\n');

    const r = runBranch("uninstall");

    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(dropinDir, "override.conf"))).toBe(false);
    expect(fs.existsSync(dropinDir)).toBe(false);
    // The unit and the marker are the pre-existing job; a regression there is just as fatal.
    expect(fs.existsSync(path.join(systemdDir, SVC))).toBe(false);
    expect(fs.existsSync(path.join(runnerDir, ".service"))).toBe(false);
  });

  it("succeeds when there is no drop-in at all", () => {
    // The common case, and the one an `&&`-chained guard would break under `set -e`: a runner that
    // never had env vars set must still uninstall cleanly, exit 0, and say nothing about drop-ins.
    const r = runBranch("uninstall");

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain(dropinDir);
    expect(fs.existsSync(path.join(systemdDir, SVC))).toBe(false);
  });

  it("keeps a drop-in directory holding files this tool did not write", () => {
    // Hand-placed operator config is not ours to delete. Leave it, keep exit 0, and say so on
    // stderr so the leftover is visible rather than silent.
    fs.mkdirsSync(dropinDir);
    fs.writeFileSync(path.join(dropinDir, "override.conf"), "[Service]\n");
    fs.writeFileSync(path.join(dropinDir, "10-operator.conf"), "[Service]\nNice=-5\n");

    const r = runBranch("uninstall");

    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(dropinDir, "override.conf"))).toBe(false);
    expect(fs.readFileSync(path.join(dropinDir, "10-operator.conf"), "utf8")).toContain("Nice=-5");
    expect(r.stderr).toContain(dropinDir);
  });
});

describe("the two branches agree on where the drop-in lives", () => {
  it("uninstall targets the same path set-env writes", () => {
    // Both spell the path out; if one is ever changed alone, uninstall goes on cleaning a
    // directory nobody writes to and the leak comes back with no failing test to show for it.
    const assignment = /dropin_dir="([^"]+)"/;
    const setEnv = assignment.exec(extractBranch("set-env"));
    const uninstall = assignment.exec(extractBranch("uninstall"));
    expect(setEnv?.[1], "set-env must assign dropin_dir").toBeTruthy();
    expect(uninstall?.[1]).toBe(setEnv?.[1]);
  });

  it("bumps VERSION so a stale helper on a host is detectable", () => {
    // install-runner-privileges.sh --check compares this against the installed copy. A behaviour
    // change shipped under the old number leaves hosts silently running the leaky uninstall.
    const v = /^VERSION=(\d+)$/m.exec(fs.readFileSync(HELPER, "utf8"));
    expect(v, "no VERSION assignment found").toBeTruthy();
    expect(Number(v?.[1])).toBeGreaterThanOrEqual(4);
  });
});
