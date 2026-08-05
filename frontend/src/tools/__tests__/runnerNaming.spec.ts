import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { labelKey } from "../runnerNaming";

// labelKey decides group identity. daemon uses it to bucket existing runners and work out the next
// `${prefix}-N`; the frontend uses it to tell whether the labels a user typed match a group that
// already exists. Two implementations that disagree hand out the same name twice.
//
// Parity with the daemon copy is asserted separately, in
// daemon/test/contract/label_key_parity.spec.ts. This file pins the behaviour itself.

describe("normalisation", () => {
  it("is order-insensitive", () => {
    expect(labelKey("linux,arm64")).toBe(labelKey("arm64,linux"));
    expect(labelKey("a,b,c")).toBe(labelKey("c,b,a"));
  });

  it("is case-insensitive", () => {
    expect(labelKey("Linux,ARM64")).toBe(labelKey("linux,arm64"));
  });

  it("ignores surrounding whitespace", () => {
    expect(labelKey(" linux , arm64 ")).toBe(labelKey("linux,arm64"));
    expect(labelKey("\tlinux\t,\narm64\n")).toBe("arm64,linux");
  });

  it("drops duplicates", () => {
    expect(labelKey("linux,linux,arm64")).toBe("arm64,linux");
    expect(labelKey("Linux,linux")).toBe("linux");
  });

  it("drops empty segments", () => {
    expect(labelKey("linux,,arm64")).toBe("arm64,linux");
    expect(labelKey(",linux,")).toBe("linux");
    expect(labelKey(" , , ")).toBe("");
  });

  it("emits a comma-joined sorted string", () => {
    expect(labelKey("zulu,alpha,mike")).toBe("alpha,mike,zulu");
  });
});

describe("degenerate input", () => {
  it("maps every form of nothing to the empty key", () => {
    for (const input of ["", "   ", ",", ",,,"]) {
      expect(labelKey(input), JSON.stringify(input)).toBe("");
    }
  });

  it("tolerates a nullish argument", () => {
    // AddRunnerDialog binds this to a text input; Vue can hand over undefined before first paint.
    expect(labelKey(undefined as unknown as string)).toBe("");
    expect(labelKey(null as unknown as string)).toBe("");
  });

  it("handles a single label", () => {
    expect(labelKey("linux")).toBe("linux");
  });
});

describe("sorting is lexicographic on the normalised values", () => {
  it("sorts after lowercasing, not before", () => {
    // "Zulu" lowercases to "zulu", which sorts after "alpha" — a sort applied before the
    // lowercase would put uppercase first and produce a different key for the same set.
    expect(labelKey("Zulu,alpha")).toBe("alpha,zulu");
    expect(labelKey("alpha,Zulu")).toBe("alpha,zulu");
  });

  it("is stable for numeric-looking labels", () => {
    // Plain string sort, no natural ordering — pinned so a future "smart" sort is a deliberate
    // change rather than an accident that splits existing groups.
    expect(labelKey("gpu10,gpu2")).toBe("gpu10,gpu2");
  });
});

describe("the invariant that justifies duplicating labelKey at all", () => {
  // labelKey exists twice because the frontend's imports from `mcsmanager-common` are all
  // `import type` — erased at compile time, so common's runtime code never reaches the browser.
  // A value import would be the first, and common's barrel re-exports system_info (a setInterval)
  // and system_storage (fs), which would pull node built-ins into the bundle.
  //
  // That invariant had no guard: turning `import type {...}` into `import {...}` is a one-word
  // edit. Keeping a duplicated implementation to protect a rule that nothing enforces is the
  // worst of both worlds, so this enforces it.
  const SRC = path.resolve(__dirname, "../..");

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(ts|vue)$/.test(entry.name)) out.push(full);
    }
    return out;
  };

  it("has no value import of mcsmanager-common anywhere under src/", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, "utf8");
      if (!text.includes("mcsmanager-common")) continue;
      // Every import statement mentioning the package must be `import type`. A re-export
      // (`export type { … } from`) is equally fine; a bare `export { … } from` is not.
      // `[^;]*?` rather than `[\s\S]*?`: a statement cannot contain a semicolon, so the match
      // cannot run backwards across earlier statements into an unrelated `import` on some
      // previous line. It still spans the newlines of a multi-line named-import block.
      const stmts = text.match(/^[ \t]*(?:import|export)\b[^;]*?from\s+"mcsmanager-common";/gm) ?? [];
      for (const s of stmts) {
        if (!/^\s*(?:import|export)\s+type\b/.test(s)) {
          offenders.push(`${path.relative(SRC, file)}: ${s.replace(/\s+/g, " ").trim()}`);
        }
      }
      // A bare `require` or dynamic import would bypass the statement match above.
      if (/require\(\s*"mcsmanager-common"|import\(\s*"mcsmanager-common"/.test(text)) {
        offenders.push(`${path.relative(SRC, file)}: dynamic/require import`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("actually finds the type imports it is policing", () => {
    // Guards against the check passing because the walk found nothing. If the frontend ever
    // stops importing from common at all, this reds and the rule above can be reconsidered.
    const hits = walk(SRC).filter((f) => fs.readFileSync(f, "utf8").includes("mcsmanager-common"));
    expect(hits.length).toBeGreaterThan(0);
  });
});
