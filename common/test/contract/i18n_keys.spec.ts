import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// The language catalogues are a contract between the source catalogue and eleven translations.
// Nothing in the build checks them: a key present in en_US but absent from a translation renders
// as the raw key, and a placeholder that does not survive translation renders as nothing at all.
//
// Scope: this compares catalogues against each other. It does NOT scan source for `t()` / `$t()`
// call sites, so a TXT_CODE_ key referenced in code but missing from en_US entirely is still
// undetected — that needs a different gate (`scan-useless-key` cannot serve, see §4).
//
// The gate here is deliberately narrower than "all languages must be complete". Ten of the eleven
// translations are missing the same 16 ci-panel-specific keys and carry placeholder mismatches
// inherited from upstream MCSManager. A gate that fails from its first commit gets ignored, so
// this pins what is green today and no more — see §10 of TESTING.md.

const LANG_DIR = path.resolve(__dirname, "../../../languages");
const SOURCE = "en_US.json";

// Complete today. Widen this list as translations catch up — that is the point of the gate.
const COMPLETE = ["zh_CN.json"];
// Placeholder-clean today.
const PLACEHOLDER_CLEAN = ["zh_CN.json", "zh_TW.json"];

// Memoised: each catalogue is ~1350 keys, and the assertions below iterate the source key set
// per language. Re-parsing inside a filter callback turns that into thousands of reads — the 2s
// testTimeout in common/vitest.config.ts caught exactly that while this spec was being written.
const cache = new Map<string, Record<string, string>>();
const read = (file: string): Record<string, string> => {
  let d = cache.get(file);
  if (!d) {
    d = JSON.parse(fs.readFileSync(path.join(LANG_DIR, file), "utf8"));
    cache.set(file, d!);
  }
  return d!;
};

const catalogues = fs
  .readdirSync(LANG_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();
const source = read(SOURCE);
const others = catalogues.filter((f) => f !== SOURCE);

// Keep the brace form: `{{x}}` is the backend's $t() and `{x}` is the frontend's t(). A translation
// that changes the count of braces breaks interpolation just as surely as renaming the variable,
// so the two must not be normalised together.
const TOKEN = /\{\{[^{}]+\}\}|\{[^{}]+\}/g;
const tokens = (v: unknown): string[] =>
  typeof v === "string" ? (v.match(TOKEN) ?? []).sort() : [];

describe("the catalogues are well-formed", () => {
  it("finds the source and every translation", () => {
    // Adding a locale is expected to red this — bump the count and decide which gate lists it
    // belongs in (COMPLETE / PLACEHOLDER_CLEAN above).
    expect(catalogues).toContain(SOURCE);
    expect(others.length).toBe(11);
  });

  it("parses every file as a flat string map", () => {
    for (const file of catalogues) {
      const d = read(file);
      expect(typeof d, file).toBe("object");
      const nonString = Object.entries(d).filter(([, v]) => typeof v !== "string");
      expect(nonString.map(([k]) => `${file}:${k}`)).toEqual([]);
    }
  });

  it("has no empty keys or values in the source", () => {
    expect(Object.keys(source).filter((k) => !k.trim())).toEqual([]);
    expect(Object.entries(source).filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([]);
  });
});

describe("no translation invents keys the source does not have", () => {
  // This one is green for all eleven, so it is gated across the board. An extra key is either a
  // typo or a key deleted from the source and left behind — both are dead weight in the bundle.
  it.each(others)("%s has no keys absent from the source", (file) => {
    const extra = Object.keys(read(file)).filter((k) => !(k in source));
    expect(extra).toEqual([]);
  });
});

describe("completeness", () => {
  it.each(COMPLETE)("%s covers every source key", (file) => {
    const d = read(file);
    expect(Object.keys(source).filter((k) => !(k in d))).toEqual([]);
  });

  it("records the known gap in the other translations rather than failing", () => {
    // Not an assertion that the gap is acceptable — an assertion that it is exactly this and
    // has not grown by accident. These are ci-panel's own additions, which upstream never had
    // and no translator has picked up.
    //
    // ⚠️ ADDING AN ENGLISH-ONLY KEY IS EXPECTED TO RED THIS CASE. That is not a signal to weaken
    // the assertion — add the key to the list below in the same commit. Listing them rather than
    // counting them is deliberate: the edit is then a reviewable declaration of what is
    // untranslated, not a number someone bumps without looking. Delete a key from the list when
    // it gets translated.
    const KNOWN_UNTRANSLATED = [
      "TXT_CODE_REPO_AUTO_REGISTER_BACKFILL",
      "TXT_CODE_REPO_AUTO_REGISTER_IMPORT",
      "TXT_CODE_REPO_AUTO_REGISTER_PROVISION",
      "TXT_CODE_REPO_REMOVE_HAS_RUNNERS",
      "TXT_CODE_REPO_REMOVE_NODE_UNREACHABLE",
      "TXT_CODE_RUNNER_BATCH_ALL_DONE",
      "TXT_CODE_RUNNER_BATCH_PROGRESS_DISCONNECTED",
      "TXT_CODE_RUNNER_BATCH_PROGRESS_LOST",
      "TXT_CODE_RUNNER_BATCH_RECONNECT",
      "TXT_CODE_RUNNER_BATCH_RETRYING",
      "TXT_CODE_RUNNER_BATCH_RETRY_FAILED",
      "TXT_CODE_RUNNER_BATCH_RETRY_TOKEN_PLACEHOLDER",
      "TXT_CODE_RUNNER_IMPORT_OK",
      "TXT_CODE_RUNNER_IMPORT_OK_WITH_REPOS",
      "TXT_CODE_RUNNER_SCAN_COLLECT",
      "TXT_CODE_RUNNER_SCAN_COLLECT_TIP"
    ].sort();

    const gaps = new Map<string, string[]>();
    for (const file of others) {
      const d = read(file);
      const missing = Object.keys(source).filter((k) => !(k in d));
      if (missing.length) gaps.set(file, missing.sort());
    }
    // Every incomplete translation is missing exactly this set — they diverge from the source in
    // one place, not eleven. Both halves matter: a key that appears here but not in the list is a
    // new gap, and one in the list but not here has been translated and should be removed.
    for (const [file, missing] of gaps) {
      expect(missing, file).toEqual(KNOWN_UNTRANSLATED);
    }
    expect([...gaps.keys()].sort()).toEqual(
      others.filter((f) => f !== "zh_CN.json").sort()
    );
  });
});

describe("placeholders survive translation", () => {
  it.each(PLACEHOLDER_CLEAN)("%s keeps every placeholder the source uses", (file) => {
    const d = read(file);
    const broken = Object.keys(source)
      .filter((k) => k in d)
      .filter((k) => tokens(source[k]).join() !== tokens(d[k]).join())
      .map((k) => `${k}: ${tokens(source[k]).join()} -> ${tokens(d[k]).join()}`);
    expect(broken).toEqual([]);
  });

  it("catches a translated placeholder NAME, not just a missing one", () => {
    // The failure this is really for. th_TH renders `{{seconds}}` as `{{วินาที}}` — the variable
    // name itself was translated, so vue-i18n has nothing to substitute and the number vanishes.
    // Neither a key-completeness check nor a "same number of braces" check would notice.
    const th = read("th_TH.json");
    const translatedNames = Object.keys(source)
      .filter((k) => k in th)
      .filter((k) => tokens(source[k]).length === tokens(th[k]).length)
      .filter((k) => tokens(source[k]).join() !== tokens(th[k]).join());
    expect(translatedNames.length).toBeGreaterThan(0);
    expect(tokens(th["TXT_CODE_c093bec9"])).not.toEqual(tokens(source["TXT_CODE_c093bec9"]));
  });
});
