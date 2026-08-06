import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { labelKey, previewGroupNames } from "../runnerNaming";

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

describe("previewGroupNames matches what the daemon will actually create", () => {
  // The daemon's allocateRunnerNames is the authority; this is the copy the dialog shows before
  // anything is created. Divergence is silent and worse than a crash — the user reads one set of
  // names, confirms, and gets another. The scenarios below are deliberately the same ones as
  // daemon/test/pure-logic/runner_name_allocation.spec.ts, so a rule change on either side has to
  // be made in both places or one suite goes red.
  const group = (over: Partial<Parameters<typeof previewGroupNames>[0][0]> = {}) => ({
    prefix: "cpu",
    count: 1,
    maxIndex: 0,
    freeIndexes: [] as number[],
    ...over
  });

  it("fills holes in ascending order before extending past the top", () => {
    // used = {cpu-2, cpu-4} → maxIndex 4, holes at 1 and 3
    expect(previewGroupNames([group({ count: 3, maxIndex: 4, freeIndexes: [1, 3] })])).toEqual([
      ["cpu-1", "cpu-3", "cpu-5"]
    ]);
  });

  it("behaves exactly as before when there is no hole", () => {
    expect(previewGroupNames([group({ count: 2, maxIndex: 2 })])).toEqual([["cpu-3", "cpu-4"]]);
  });

  it("starts at 1 for a prefix nothing uses yet", () => {
    expect(previewGroupNames([group({ prefix: "npu", count: 2 })])).toEqual([["npu-1", "npu-2"]]);
  });

  it("keeps allocating past the holes once they run out", () => {
    expect(previewGroupNames([group({ count: 4, maxIndex: 3, freeIndexes: [1, 2] })])).toEqual([
      ["cpu-1", "cpu-2", "cpu-4", "cpu-5"]
    ]);
  });

  it("shares holes and the cursor between two groups on the same prefix", () => {
    // The daemon accumulates into one `used` set across the whole batch. Two groups each starting
    // from their own maxIndex would preview cpu-1 twice — and the second one would never exist.
    const [first, second] = previewGroupNames([
      group({ count: 2, maxIndex: 2, freeIndexes: [1] }),
      group({ count: 2, maxIndex: 2, freeIndexes: [1] })
    ]);
    expect(first).toEqual(["cpu-1", "cpu-3"]);
    expect(second).toEqual(["cpu-4", "cpu-5"]);
    expect(new Set([...first, ...second]).size).toBe(4);
  });

  it("takes the real anchors when an unmatched group shares the prefix and comes first", () => {
    // An unmatched group reports maxIndex 0 / freeIndexes [] — that is "unknown", not "nothing
    // exists". Seeding from whichever group happens to be listed first would zero the anchors and
    // preview cpu-1/cpu-2, while the daemon computes from the real used set and creates
    // cpu-1/cpu-3. Reachable in the dialog: an existing `linux,arm64` group named cpu, plus a new
    // group whose labels are `linux,arm64,gpu` and whose base name the user typed as cpu.
    // The daemon-side twin of this case is in
    // daemon/test/pure-logic/runner_name_allocation.spec.ts ("mirrors the preview when …").
    expect(
      previewGroupNames([
        group({ count: 1, maxIndex: 0, freeIndexes: [] }),
        group({ count: 1, maxIndex: 4, freeIndexes: [1, 3] })
      ])
    ).toEqual([["cpu-1"], ["cpu-3"]]);
  });

  it("is order-independent for that pair", () => {
    expect(
      previewGroupNames([
        group({ count: 1, maxIndex: 4, freeIndexes: [1, 3] }),
        group({ count: 1, maxIndex: 0, freeIndexes: [] })
      ])
    ).toEqual([["cpu-1"], ["cpu-3"]]);
  });

  it("keeps distinct prefixes independent", () => {
    expect(
      previewGroupNames([
        group({ count: 1, maxIndex: 3, freeIndexes: [2] }),
        group({ prefix: "npu", count: 1, maxIndex: 1 })
      ])
    ).toEqual([["cpu-2"], ["npu-2"]]);
  });

  it("returns an index-aligned empty slot for a group that creates nothing", () => {
    // The dialog reads groupNames[i] to label row i. A skipped row must not shift the rest.
    expect(
      previewGroupNames([group({ count: 0 }), group({ prefix: "  ", count: 3 }), group()])
    ).toEqual([[], [], ["cpu-1"]]);
  });

  it("does not mutate the caller's freeIndexes array", () => {
    // It comes straight off the repo_groups response object, which the dialog keeps in a ref and
    // re-reads on every keystroke; consuming it in place would empty it after the first render.
    const freeIndexes = [1, 3];
    previewGroupNames([{ prefix: "cpu", count: 2, maxIndex: 4, freeIndexes }]);
    expect(freeIndexes).toEqual([1, 3]);
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
