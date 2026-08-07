import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { DAEMON_ROOT, REPO_ROOT } from "../setup";
import { expandEnvTemplate, envTemplateIndexOf } from "../../src/service/runner_env_template";

// The placeholder expander exists twice on purpose, and that is the hazard this file watches.
//
// The daemon copy is the one that runs: it expands `{{(index-1)*4}}` into the value written to a
// systemd drop-in and to `<dir>/.env`. The frontend copy renders the "npu-1 will get 0-3" preview
// under the env box in the add-runner dialog, and rejects a broken expression before a batch
// starts. If the two drift, the preview stops describing what gets written — and this is a bulk
// operation, so the gap surfaces only after twenty runners are already registered with the wrong
// device range.
//
// Why not just put it in common/: the frontend's imports from `mcsmanager-common` are all
// `import type`, erased at compile time. A value import would be the first one, and the barrel
// re-exports system_info (a setInterval) and system_storage (fs) — that would pull node built-ins
// into the browser bundle. Same trade as labelKey; see label_key_parity.spec.ts.

const DAEMON_COPY = path.join(DAEMON_ROOT, "src/service/runner_env_template.ts");
const FRONTEND_COPY = path.join(REPO_ROOT, "frontend/src/tools/envTemplate.ts");

describe("the two copies are identical", () => {
  it("both files exist", () => {
    // Fails loudly rather than vacuously: a rename on either side must break this file, not make
    // the comparison below quietly compare nothing.
    expect(fs.existsSync(DAEMON_COPY), DAEMON_COPY).toBe(true);
    expect(fs.existsSync(FRONTEND_COPY), FRONTEND_COPY).toBe(true);
  });

  it("is byte-identical, whole file", () => {
    // Whole-file rather than a extracted function body: the module is pure and import-free
    // precisely so that this can be a plain equality. Anything added to one side — a helper, an
    // extra exported entry point, a changed operator table — has to be added to the other.
    expect(fs.readFileSync(FRONTEND_COPY, "utf8")).toBe(fs.readFileSync(DAEMON_COPY, "utf8"));
  });

  it("stays import-free, so the copies cannot diverge through their dependencies", () => {
    expect(fs.readFileSync(DAEMON_COPY, "utf8")).not.toMatch(/^\s*import\s/m);
  });

  it("names both paths in its own header, so whoever edits one finds the other", () => {
    const header = fs.readFileSync(DAEMON_COPY, "utf8");
    expect(header).toContain("daemon/src/service/runner_env_template.ts");
    expect(header).toContain("frontend/src/tools/envTemplate.ts");
  });
});

describe("the daemon implementation behaves as the frontend preview promises", () => {
  // The same cases as frontend/src/tools/__tests__/envText.spec.ts, run against the daemon copy.
  // Textual identity plus matching behaviour on both sides is what makes the parity real.
  const ctx = { name: "npu-3", index: 3, seq: 1 };

  it.each([
    ["{{name}}", "npu-3"],
    ["{{index}}", "3"],
    ["{{seq}}", "1"],
    ["{{(index-1)*4}}-{{(index-1)*4+3}}", "8-11"],
    ["http://127.0.0.1:7892", "http://127.0.0.1:7892"]
  ])("expandEnvTemplate(%j) === %j", (input, expected) => {
    expect(expandEnvTemplate(input, ctx)).toBe(expected);
  });

  it("derives the same index from a runner name", () => {
    expect(envTemplateIndexOf("npu-3", 1)).toBe(3);
    expect(envTemplateIndexOf("custom", 5)).toBe(5);
  });
});
