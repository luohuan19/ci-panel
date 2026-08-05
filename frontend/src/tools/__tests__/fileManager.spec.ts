import { beforeAll, describe, expect, it } from "vitest";
import { initI18n } from "@/lang/i18n";
import { filterFileName, getFileExtName, isCompressFile } from "../fileManager";

// `let i18n` in src/lang/i18n.ts is assigned only by initI18n, and filterFileName calls t() —
// without this it throws "not a function". Kept local rather than in vitest.setup.ts so the
// specs that need nothing from the app's import graph stay hermetic.
beforeAll(async () => {
  await initI18n("en_us");
});

describe("isCompressFile", () => {
  it("accepts single-volume archives", () => {
    for (const name of ["a.zip", "a.rar", "a.7z", "a.tar.gz", "a.tar.xz", "a.iso", "a.cab"]) {
      expect(isCompressFile(name), name).toBe(true);
    }
  });

  it("offers extraction only on the first volume of a split archive", () => {
    // Regression guard: `rar` is in the single-volume list, so testing that list first made every
    // volume of a .partN.rar set look extractable and the file manager offered "decompress" on
    // volume 2 onwards, where extraction cannot work.
    expect(isCompressFile("a.part1.rar")).toBe(true);
    expect(isCompressFile("a.part2.rar")).toBe(false);
    expect(isCompressFile("a.part10.rar")).toBe(false);
    expect(isCompressFile("a.7z.001")).toBe(true);
    expect(isCompressFile("a.7z.002")).toBe(false);
  });

  it("rejects continuation volumes of a rar / zip set", () => {
    expect(isCompressFile("a.r00")).toBe(false);
    expect(isCompressFile("a.z01")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isCompressFile("A.PART1.RAR")).toBe(true);
    expect(isCompressFile("A.PART2.RAR")).toBe(false);
    expect(isCompressFile("A.ZIP")).toBe(true);
  });

  it("rejects non-archives", () => {
    for (const name of ["a.txt", "a", "", "rar", "a.zipx"]) {
      expect(isCompressFile(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe("getFileExtName", () => {
  it("returns the last segment, lowercased", () => {
    expect(getFileExtName("archive.TAR.GZ")).toBe("gz");
    expect(getFileExtName("a.txt")).toBe("txt");
  });

  it("returns an empty string when there is no dot", () => {
    expect(getFileExtName("README")).toBe("");
  });

  it("treats a dotfile as all extension", () => {
    // Documents current behaviour: the leading dot is not special-cased.
    expect(getFileExtName(".gitignore")).toBe("gitignore");
  });
});

describe("filterFileName", () => {
  it("returns the bare uppercase extension when onlyExtname is set", () => {
    expect(filterFileName("a.tar.gz", true)).toBe("GZ");
    expect(filterFileName("README", true)).toBe("UNKNOWN");
  });

  it("resolves the i18n suffix instead of rendering the raw key", () => {
    const label = filterFileName("a.txt");
    expect(label.startsWith("TXT ")).toBe(true);
    expect(label).not.toContain("TXT_CODE_");
  });
});
