import fs from "fs-extra";
import path from "path";
import { describe, expect, it } from "vitest";
import { DAEMON_ROOT } from "../setup";
import { withRunnerLock } from "../../src/service/runner_lock";

// Deleting a runner has to wait for its unit to actually stop before the directory goes away.
// Who does the waiting matters:
//
//   the helper's blocking `disable --now` — bounded by the unit's TimeoutStopSec=5min, while the
//   daemon only gives the call HELPER_TIMEOUT_MS. A Listener that ignores SIGTERM therefore times
//   out by construction, and an execFile timeout is indistinguishable from a sudo refusal.
//
//   the daemon itself — helper stop is `--no-block`, so it polls `systemctl show` against its own
//   deadline and gets a definite settled/not-settled answer either way.
//
// The second is what runDelete does now. The trap in writing it is the lock.

describe("the lock is not re-entrant, which is why the delete path cannot call controlService", () => {
  // runDelete already holds the runner's svc: key. controlService takes that same key on the way
  // in, so calling it from inside the delete would block the delete on itself — and because
  // withRunnerLock fails fast rather than queueing, the failure is immediate and looks like a
  // user error ("正在删除中"). runServiceAction, the inside-the-lock half, is the one to call.
  //
  // Assert the property rather than the workaround: if the lock ever gained re-entrancy or a
  // queue, the comment in stopBeforeUninstall would be stale and this case would say so.

  it("taking a held key from inside the holder throws instead of waiting", async () => {
    const key = "svc:actions.runner.example.re-entry.service";
    await expect(
      withRunnerLock([key], "delete", async () =>
        withRunnerLock([key], "service", async () => "should never get here")
      )
    ).rejects.toThrow(/正在删除中/);
  });

  it("names the contended target so a batch shows which one was blocked", async () => {
    await expect(
      withRunnerLock(["dir:/srv/runners/r1"], "provision", async () =>
        withRunnerLock(["dir:/srv/runners/r1"], "delete", async () => "no")
      )
    ).rejects.toThrow(/^\/srv\/runners\/r1 正在置备中/);
  });

  it("releases on the way out, including when the body throws", async () => {
    const key = "dir:/srv/runners/r2";
    await expect(
      withRunnerLock([key], "delete", async () => {
        throw new Error("body blew up");
      })
    ).rejects.toThrow("body blew up");
    // Still takeable — a leaked hold here would wedge this runner until the daemon restarts.
    await expect(withRunnerLock([key], "service", async () => "free")).resolves.toBe("free");
  });
});

describe("runDelete stops through the inside-the-lock path", () => {
  // Nothing in the type system distinguishes controlService from runServiceAction — both accept a
  // unit name and an action. Swapping one for the other type-checks cleanly and deadlocks only at
  // runtime, on a path that needs a real systemd to exercise. Pin it textually.
  const src = fs.readFileSync(
    path.join(DAEMON_ROOT, "src/service/runner_scan.ts"),
    "utf8"
  );
  const stopFn = src.match(/async function stopBeforeUninstall[\s\S]*?\n}\n/)?.[0];

  it("stopBeforeUninstall exists and is what runDelete gates the uninstall on", () => {
    expect(stopFn, "stopBeforeUninstall not found in runner_scan.ts").toBeTruthy();
    // Anchored loosely on purpose: what must hold is "the stop result decides whether uninstall
    // runs at all", not the exact spelling of the ternary. A prettier reflow should not redden it.
    expect(src).toMatch(/stopBeforeUninstall\(dir\)[\s\S]{0,160}uninstallSystemdService\(dir\)/);
  });

  it("it calls runServiceAction, never controlService", () => {
    expect(stopFn).toContain("runServiceAction(service, \"stop\"");
    expect(stopFn).not.toContain("controlService(");
  });

  it("it waits longer than the button-press path does", () => {
    // 8s is tuned for "clicking start/stop should feel responsive, the status poll will converge".
    // A delete that gives up has to be redone from the top, so it earns more patience.
    const settle = Number(src.match(/^const SETTLE_TIMEOUT_MS = (\d+);$/m)?.[1]);
    const del = Number(src.match(/^const DELETE_SETTLE_MS = (\d+);$/m)?.[1]);
    expect(settle).toBeGreaterThan(0);
    expect(del).toBeGreaterThan(settle);
    // ...but still well under the unit's own TimeoutStopSec=5min: the point is to reach a verdict,
    // not to outlast systemd.
    expect(del).toBeLessThan(5 * 60 * 1000);
  });
});
