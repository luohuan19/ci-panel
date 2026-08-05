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
  const PKG = "mcsmanager-common";

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      // .tsx and .jsx count too — vue-jsx is configured in vite.config.ts.
      else if (/\.(m?[jt]sx?|vue)$/.test(entry.name)) out.push(full);
    }
    return out;
  };

  // Matches an import/export declaration naming the package, in either quote style. `[^;]*?`
  // rather than `[\s\S]*?` so the match cannot run backwards across an earlier statement into
  // some unrelated `import` on a previous line; it still spans a multi-line named-import block.
  // Applies to .vue too — the script block is plain TS as far as this is concerned.
  const DECL = new RegExp(
    String.raw`^[ \t]*(?:import|export)\b[^;]*?from\s+['"]` + PKG + String.raw`['"];`,
    "gm"
  );
  const TYPE_ONLY = /^[ \t]*(?:import|export)\s+type\b/;
  // A dynamic import or require bypasses the declaration form entirely.
  const DYNAMIC = new RegExp(String.raw`(?:require|import)\(\s*['"]` + PKG + String.raw`['"]`);

  const declarationsIn = (file: string) => {
    const text = fs.readFileSync(file, "utf8");
    return { text, decls: text.match(DECL) ?? [] };
  };

  it("has no value import of mcsmanager-common anywhere under src/", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const { text, decls } = declarationsIn(file);
      for (const d of decls) {
        if (!TYPE_ONLY.test(d)) offenders.push(`${path.relative(SRC, file)}: ${d.replace(/\s+/g, " ")}`);
      }
      if (DYNAMIC.test(text)) offenders.push(`${path.relative(SRC, file)}: dynamic import / require`);
    }
    expect(offenders).toEqual([]);
  });

  it("actually finds type-only declarations, so the check above cannot pass vacuously", () => {
    // Counts real declarations, not files that merely mention the string — this spec file names
    // the package in its own comments and regexes, and runnerNaming.ts does in a comment, so a
    // text-occurrence check would be satisfied by those alone and prove nothing.
    const decls = walk(SRC).flatMap((f) => declarationsIn(f).decls);
    expect(decls.length).toBeGreaterThan(0);
    expect(decls.every((d) => TYPE_ONLY.test(d))).toBe(true);
  });

  it("recognises both quote styles and the dynamic forms it is meant to reject", () => {
    // Pins the matchers themselves. Without this, a regex that silently matched nothing would
    // make every assertion above trivially true.
    expect(`import { x } from "${PKG}";`.match(DECL)).toHaveLength(1);
    expect(`import { x } from '${PKG}';`.match(DECL)).toHaveLength(1);
    expect(`export { x } from "${PKG}";`.match(DECL)).toHaveLength(1);
    expect(TYPE_ONLY.test(`import type { x } from "${PKG}";`)).toBe(true);
    expect(TYPE_ONLY.test(`import { x } from "${PKG}";`)).toBe(false);
    expect(DYNAMIC.test(`const m = require('${PKG}');`)).toBe(true);
    expect(DYNAMIC.test(`await import("${PKG}")`)).toBe(true);
  });
});
