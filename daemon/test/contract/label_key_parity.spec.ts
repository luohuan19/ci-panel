import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { DAEMON_ROOT, REPO_ROOT } from "../setup";
import { labelKey } from "../../src/service/runner_provision";

// labelKey exists twice on purpose, and that is the hazard this file watches.
//
// It is the identity of a "label group": daemon buckets existing runners by it to work out the
// next `${prefix}-N`, and the frontend uses it to decide whether the labels a user typed match a
// group that already exists. If the two drift, the same label set hashes to two different groups,
// `-N` restarts from 1, and the fleet ends up with duplicate runner names — which GitHub accepts,
// so nothing surfaces until two runners fight over one registration.
//
// Why not just put it in common/: the frontend's imports from `mcsmanager-common` are all
// `import type`, erased at compile time. A value import would be the first one, and the barrel
// re-exports system_info (a setInterval) and system_storage (fs) — that would pull node built-ins
// into the browser bundle. Duplication is the cheaper trade; this test is the price.

const FRONTEND_COPY = path.join(REPO_ROOT, "frontend/src/tools/runnerNaming.ts");
const DAEMON_COPY = path.join(DAEMON_ROOT, "src/service/runner_provision.ts");

// Pull the function body out of a source file. Deliberately textual: the point is to compare the
// two implementations, not to run one of them — the frontend copy cannot be imported here.
const extractBody = (file: string): string => {
  const src = fs.readFileSync(file, "utf8");
  const m = src.match(/export function labelKey\(labels: string\): string \{\n([\s\S]*?)\n\}/);
  if (!m) throw new Error(`no labelKey definition found in ${file}`);
  return m[1]
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
};

describe("the two copies are identical", () => {
  it("finds a labelKey in both files", () => {
    // Fails loudly rather than vacuously: if either definition is renamed or reshaped, the
    // extraction throws and this file reports zero passing cases with a non-zero exit.
    expect(() => extractBody(DAEMON_COPY)).not.toThrow();
    expect(() => extractBody(FRONTEND_COPY)).not.toThrow();
  });

  it("has byte-identical bodies once indentation is normalised", () => {
    expect(extractBody(FRONTEND_COPY)).toBe(extractBody(DAEMON_COPY));
  });

  it("the shared body is the pipeline both sides document", () => {
    // Pins the steps themselves, so "identical" cannot be satisfied by both copies being wrong
    // in the same way after a careless find-and-replace across the repo.
    const body = extractBody(DAEMON_COPY);
    for (const step of [
      '.split(",")',
      ".map((s) => s.trim().toLowerCase())",
      ".filter(Boolean)",
      ".filter((v, i, a) => a.indexOf(v) === i)",
      ".sort()",
      '.join(",")'
    ]) {
      expect(body, step).toContain(step);
    }
  });
});

describe("the daemon implementation behaves as the frontend spec expects", () => {
  // The same cases as frontend/src/tools/__tests__/runnerNaming.spec.ts, run against the daemon
  // copy. Textual identity plus matching behaviour on both sides is what makes the parity real.
  it.each([
    ["linux,arm64", "arm64,linux"],
    ["arm64,linux", "arm64,linux"],
    ["Linux,ARM64", "arm64,linux"],
    [" linux , arm64 ", "arm64,linux"],
    ["linux,linux,arm64", "arm64,linux"],
    ["linux,,arm64", "arm64,linux"],
    [",linux,", "linux"],
    [" , , ", ""],
    ["", ""],
    ["linux", "linux"],
    ["Zulu,alpha", "alpha,zulu"],
    ["gpu10,gpu2", "gpu10,gpu2"]
  ])("labelKey(%j) === %j", (input, expected) => {
    expect(labelKey(input)).toBe(expected);
  });

  it("tolerates a nullish argument", () => {
    expect(labelKey(undefined as unknown as string)).toBe("");
  });
});
