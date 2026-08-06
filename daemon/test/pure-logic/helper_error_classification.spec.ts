import { execFile } from "child_process";
import fs from "fs-extra";
import path from "path";
import { promisify } from "util";
import { describe, expect, it } from "vitest";
import { DAEMON_ROOT } from "../setup";
import { helperErrorMessage, isExecTimeout } from "../../src/service/runner_provision";

const execFileAsync = promisify(execFile);

// Every privileged-helper call goes out through `execFile("sudo", ["-n", helper, …])` with a
// timeout. Two very different failures arrive at the same catch block:
//
//   the helper was never allowed to run   → sudo writes to stderr, exit code says so
//   the helper ran but systemd never replied → Node SIGTERMs it at the timeout, stderr is EMPTY
//
// Classifying on stderr text alone cannot tell them apart, so a timeout used to be reported as
// "passwordless sudo is not configured" — which sends the reader to sudoers for a problem that
// has nothing to do with permissions. That happened on a box whose D-Bus had stalled, and cost
// a long detour. The signal must be checked before the text.

describe("what a real execFile timeout actually looks like", () => {
  // Hand-rolled `{ killed: true }` fixtures would only test our assumptions about Node. These
  // two cases provoke the genuine article.

  it("carries killed/SIGTERM and — the whole problem — an empty stderr", async () => {
    const err = await execFileAsync(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      timeout: 50
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as { killed?: unknown }).killed).toBe(true);
    expect((err as { signal?: unknown }).signal).toBe("SIGTERM");
    // This is why text classification is hopeless here: there is no text.
    expect(String((err as { stderr?: unknown }).stderr ?? "")).toBe("");
    expect(isExecTimeout(err)).toBe(true);
  });

  it("does not call an externally killed process a timeout", async () => {
    // The trap this guards: an external SIGTERM lands with signal === "SIGTERM" too, but
    // killed === false, because `killed` means *we* killed it. Matching on the signal alone
    // invents a "waited 60 seconds" timeout for a process that was shot at 80ms.
    const child = execFile(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], () => {});
    // Cleared on the way out, and guarded: firing at a child that already exited throws from
    // inside a timer callback, where nothing can catch it — vitest would report a crashed
    // worker rather than a failing assertion.
    const timer = setTimeout(() => {
      if (child.pid === undefined) return;
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }, 80);
    try {
      const err = await new Promise<unknown>((resolve) => {
        child.on("error", resolve);
        child.on("close", (_code, signal) =>
          resolve(Object.assign(new Error("Command failed"), { killed: child.killed, signal }))
        );
      });

      expect((err as { signal?: unknown }).signal).toBe("SIGTERM");
      expect((err as { killed?: unknown }).killed).toBe(false);
      expect(isExecTimeout(err)).toBe(false);
    } finally {
      clearTimeout(timer);
    }
  });

  it("does not confuse an ordinary non-zero exit for a timeout", async () => {
    const err = await execFileAsync(process.execPath, [
      "-e",
      "process.stderr.write('boom'); process.exit(3)"
    ]).catch((e) => e);

    expect((err as { code?: unknown }).code).toBe(3);
    expect(String((err as { stderr?: unknown }).stderr)).toContain("boom");
    expect(isExecTimeout(err)).toBe(false);
  });

  it("says no to values that are not errors at all", () => {
    for (const v of [
      null,
      undefined,
      "",
      "SIGTERM",
      0,
      { signal: "SIGINT" },
      { killed: false },
      { killed: false, signal: "SIGTERM" } // the externally-killed shape, as a plain object
    ]) {
      expect(isExecTimeout(v), JSON.stringify(v)).toBe(false);
    }
  });
});

describe("the three outcomes read differently", () => {
  const timeoutErr = Object.assign(new Error("Command failed: sudo -n /usr/local/sbin/x install"), {
    killed: true,
    signal: "SIGTERM",
    stderr: ""
  });

  it("a timeout is never blamed on sudo", async () => {
    const msg = helperErrorMessage("装 systemd 服务", timeoutErr, 60000);
    expect(msg).toContain("超时");
    expect(msg).toContain("60 秒");
    // The regression this file exists for. Anything steering the reader at sudoers is the bug.
    expect(msg).not.toMatch(/sudo|sudoers|免密|特权助手/);
  });

  it("a genuine sudo refusal still points at the install script", () => {
    const denied = Object.assign(new Error("Command failed"), {
      stderr: "sudo: a password is required\n"
    });
    const msg = helperErrorMessage("装 systemd 服务", denied, 60000);
    expect(msg).toContain("免密 sudo");
    expect(msg).toContain("ci-panel-runner-install.sudoers");
    expect(msg).not.toContain("超时");
  });

  it("recognises the other shape sudo refuses with", () => {
    const denied = Object.assign(new Error("Command failed"), {
      stderr: "Sorry, user ci is not allowed to execute '/usr/local/sbin/x' as root.\n"
    });
    expect(helperErrorMessage("卸载 systemd 服务", denied, 60000)).toContain("免密 sudo");
  });

  it("does not mistake the word sudo inside a message for a refusal", () => {
    // The command line itself contains "sudo -n". Only a line *starting* with "sudo:" is sudo
    // talking; a looser pattern would swallow helper-reported failures into the wrong bucket.
    const helperSaid = Object.assign(new Error("Command failed: sudo -n /usr/local/sbin/x"), {
      stderr: "ci-panel-runner-svc: 目录必须在 /data/ci-runner 下: /tmp/evil\n"
    });
    const msg = helperErrorMessage("卸载 systemd 服务", helperSaid, 60000);
    expect(msg).not.toContain("免密 sudo");
    expect(msg).toContain("目录必须在");
  });
});

describe("the classification lives in exactly one place", () => {
  // Four call sites need this decision (install / uninstall / set-env / start-stop). They used to
  // carry four copies of the regex, which had already drifted into two different strictnesses.
  // A fifth copy would silently reintroduce the timeout-looks-like-a-permission-error bug in
  // whichever path grew it, and nothing in the build would notice.
  const SRC = path.join(DAEMON_ROOT, "src");

  const sources = (): string[] => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts")) out.push(p);
      }
    };
    walk(SRC);
    return out;
  };

  it("no source file outside runner_provision.ts classifies sudo failures itself", () => {
    const offenders = sources().filter(
      (f) =>
        path.basename(f) !== "runner_provision.ts" &&
        /password is required|not allowed to execute/.test(fs.readFileSync(f, "utf8"))
    );
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});
