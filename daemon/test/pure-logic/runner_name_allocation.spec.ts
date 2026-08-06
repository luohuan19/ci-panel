import fs from "fs-extra";
import path from "path";
import { beforeEach, describe, expect, it } from "vitest";
import { SCAN_ROOT } from "../setup";
import { allocateRunnerNames } from "../../src/service/runner_provision";

// Numbering used to be "highest existing N, plus one". Deleting a runner from the middle of a
// group left a hole that never closed, and the numbers only ever climbed. These cases pin the
// replacement: fill the holes first, in order, then carry on past the top.
//
// Every case here would also pass under a rule that simply never reuses a number — except the
// ones that assert a hole is filled, which is the whole point. Against the old implementation,
// `{cpu-2, cpu-4}` returns cpu-5/cpu-6/cpu-7 rather than cpu-1/cpu-3/cpu-5.

const baseDir = path.join(SCAN_ROOT, "alloc-base");

beforeEach(() => {
  fs.removeSync(baseDir);
  fs.mkdirsSync(baseDir);
});

describe("filling gaps", () => {
  it("fills holes in ascending order before extending past the top", () => {
    const used = new Set(["cpu-2", "cpu-4"]);
    expect(allocateRunnerNames("cpu", 3, used, baseDir)).toEqual(["cpu-1", "cpu-3", "cpu-5"]);
  });

  it("behaves exactly as before when there is no hole", () => {
    const used = new Set(["cpu-1", "cpu-2"]);
    expect(allocateRunnerNames("cpu", 2, used, baseDir)).toEqual(["cpu-3", "cpu-4"]);
  });

  it("starts at 1 for a prefix nothing uses yet", () => {
    expect(allocateRunnerNames("npu", 2, new Set(), baseDir)).toEqual(["npu-1", "npu-2"]);
  });

  it("reuses the top number when the top one was the one deleted", () => {
    // Not a hole — cpu-2 is simply gone, so the next allocation lands back on it. Worth pinning
    // because it is the one case where a name comes back without any gap-filling involved.
    expect(allocateRunnerNames("cpu", 1, new Set(["cpu-1"]), baseDir)).toEqual(["cpu-2"]);
  });

  it("keeps allocating past the holes once they run out", () => {
    const used = new Set(["cpu-3"]);
    expect(allocateRunnerNames("cpu", 4, used, baseDir)).toEqual([
      "cpu-1",
      "cpu-2",
      "cpu-4",
      "cpu-5"
    ]);
  });
});

describe("what counts as taken", () => {
  it("adds each allocated name to used, so a second group cannot collide", () => {
    const used = new Set(["cpu-2"]);
    const first = allocateRunnerNames("cpu", 2, used, baseDir);
    const second = allocateRunnerNames("cpu", 2, used, baseDir);
    expect(first).toEqual(["cpu-1", "cpu-3"]);
    expect(second).toEqual(["cpu-4", "cpu-5"]);
    expect(new Set([...first, ...second]).size).toBe(4);
  });

  it("skips a number whose directory exists even when used does not know about it", () => {
    // used is a snapshot; a directory left behind by a half-finished provision is not in it.
    // Handing out that name would overwrite the directory, which is the one outcome ruled out.
    fs.mkdirsSync(path.join(baseDir, "cpu-1"));
    const used = new Set(["cpu-3"]);
    expect(allocateRunnerNames("cpu", 2, used, baseDir)).toEqual(["cpu-2", "cpu-4"]);
  });

  it("ignores names belonging to a different prefix", () => {
    const used = new Set(["npu-1", "npu-2", "cpu-3"]);
    expect(allocateRunnerNames("cpu", 2, used, baseDir)).toEqual(["cpu-1", "cpu-2"]);
  });

  it("does not treat a zero or negative suffix as an anchor", () => {
    // `cpu-0` can only have been made by hand. Counting it would invent a hole at a number the
    // allocator never hands out, and every later run would try to fill it again.
    const used = new Set(["cpu-0", "cpu-1"]);
    expect(allocateRunnerNames("cpu", 1, used, baseDir)).toEqual(["cpu-2"]);
  });

  it("ignores a suffix that is not a plain integer", () => {
    const used = new Set(["cpu-01x", "cpu-1.5", "cpu-", "cpu-2"]);
    expect(allocateRunnerNames("cpu", 2, used, baseDir)).toEqual(["cpu-1", "cpu-3"]);
  });

  it("treats a prefix containing regex metacharacters literally", () => {
    // The prefix comes from a marker file, so it is not a trusted literal. An unescaped `.`
    // would let `axb-1` count as a used index for prefix `a.b` and shift the whole allocation.
    const used = new Set(["axb-1", "axb-2"]);
    expect(allocateRunnerNames("a.b", 1, used, baseDir)).toEqual(["a.b-1"]);
  });
});
