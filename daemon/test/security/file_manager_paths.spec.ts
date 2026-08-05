import fs from "fs-extra";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { SCAN_ROOT, OUTSIDE_ROOT } from "../setup";
import FileManager from "../../src/service/system_file";

// FileManager is what the browser's file manager talks to. Every path it is handed comes from the
// client, so containment inside topPath is the whole security property — and `resolveRealPath` is
// what makes it survive symlinks rather than just `..`.

const WS = path.join(SCAN_ROOT, "fm-workspace");
const SECRET = path.join(OUTSIDE_ROOT, "fm-secret");

beforeAll(() => {
  fs.mkdirsSync(path.join(WS, "sub", "deep"));
  fs.writeFileSync(path.join(WS, "inside.txt"), "inside\n");
  fs.mkdirsSync(SECRET);
  fs.writeFileSync(path.join(SECRET, "stolen.txt"), "SECRET\n");
});

const fm = () => new FileManager(WS);

describe("containment inside topPath", () => {
  it("accepts paths within the workspace", () => {
    const m = fm();
    expect(m.checkPath("inside.txt")).toBe(true);
    expect(m.checkPath("sub")).toBe(true);
    expect(m.checkPath("sub/deep")).toBe(true);
    expect(m.checkPath(".")).toBe(true);
  });

  it("rejects traversal out of the workspace", () => {
    const m = fm();
    for (const p of ["../", "../../etc", "sub/../../..", "../fm-secret/stolen.txt"]) {
      expect(() => m.checkPath(p), p).toThrow();
    }
  });

  it("re-interprets an absolute path as workspace-relative rather than rejecting it", () => {
    // Current behaviour, and safe — but surprising enough to pin. toAbsolutePath ends in
    // `path.join(topPath, cwd, fileName)`, and path.join treats a leading "/" as just another
    // separator, so "/etc/passwd" becomes "<workspace>/etc/passwd". Containment holds; the
    // client simply does not get an error for a path it probably meant literally.
    const m = fm();
    expect(m.toAbsolutePath("/etc/passwd")).toBe(path.join(WS, "etc/passwd"));
    expect(m.checkPath("/etc/passwd")).toBe(true);
    expect(m.toAbsolutePath(SECRET)).toBe(path.join(WS, SECRET));
    // The important half: nothing outside the workspace is reachable this way.
    expect(m.toAbsolutePath("/etc/passwd").startsWith(WS + path.sep)).toBe(true);
  });

  it("rejects a symlink pointing out of the workspace", () => {
    // The reason isOutsideWorkspace resolves real paths instead of comparing strings: the link
    // itself is lexically inside topPath.
    const link = path.join(WS, "escape-link");
    if (!fs.existsSync(link)) fs.symlinkSync(SECRET, link);
    expect(() => m2().checkPath("escape-link")).toThrow();
    expect(() => m2().checkPath("escape-link/stolen.txt")).toThrow();
  });

  it("rejects a sibling directory whose name merely extends the workspace's", () => {
    // `<ws>-evil` starts with `<ws>` as a string; the per-segment comparison is what stops it.
    const sibling = `${WS}-evil`;
    fs.mkdirsSync(sibling);
    expect(() => fm().checkPath(sibling)).toThrow();
  });

  const m2 = () => new FileManager(WS);
});

describe("toAbsolutePath", () => {
  it("resolves relative to topPath + cwd", () => {
    const m = fm();
    expect(m.toAbsolutePath("inside.txt")).toBe(path.join(WS, "inside.txt"));
  });

  it("throws rather than returning a path outside the workspace", () => {
    expect(() => fm().toAbsolutePath("../../etc/passwd")).toThrow();
  });
});

describe("the global instance short-circuits every guard — current behaviour, documented", () => {
  // system_instance.ts gives the built-in global instance `cwd: "/"`, so its FileManager has
  // topPath "/" and isRootTopRath() is true. checkPath, isOutsideWorkspace and copy/move's guard
  // all return early on that, which means the global instance can address the entire filesystem.
  //
  // That is intentional — the global instance exists to give an operator a shell and a file
  // browser on the host — but it is a large amount of authority resting on one boolean, and
  // nothing else in the file layer re-checks. Pinned so that if the short-circuit is ever
  // removed or narrowed, that is a deliberate change with a red test, not a silent one.
  const root = () => new FileManager("/");

  it("reports itself as root-topped", () => {
    expect(root().isRootTopRath()).toBe(true);
    expect(fm().isRootTopRath()).toBe(false);
  });

  it("accepts any path at all, including outside anything", () => {
    const m = root();
    for (const p of ["/etc/passwd", "../../..", SECRET, "/"]) {
      expect(m.checkPath(p), p).toBe(true);
    }
  });

  it("a non-root workspace does not get that treatment", () => {
    // The root-topped manager returns the path as given; a scoped one confines it. Same input,
    // materially different reach — which is the whole point of the short-circuit.
    expect(root().toAbsolutePath("/etc/passwd")).toBe("/etc/passwd");
    expect(fm().toAbsolutePath("/etc/passwd")).toBe(path.join(WS, "etc/passwd"));
  });
});

describe("topPath normalisation", () => {
  it("resolves a relative topPath against cwd", () => {
    // The suite chdirs into a sandbox, so a relative topPath lands there rather than in the repo.
    const m = new FileManager("relative-ws");
    expect(path.isAbsolute(m.topPath)).toBe(true);
    expect(m.topPath).toBe(path.join(process.cwd(), "relative-ws"));
  });

  it("keeps an absolute topPath as given, normalised", () => {
    expect(new FileManager(`${WS}/sub/..`).topPath).toBe(WS);
  });
});
