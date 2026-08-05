import { describe, expect, it } from "vitest";
import { number2permission, permission2number } from "../permission";

describe("permission2number", () => {
  it("packs the three groups into one unix-style triple", () => {
    expect(permission2number(["4", "2", "1"], ["4", "2", "1"], ["4", "2", "1"])).toBe(777);
    expect(permission2number(["4", "2", "1"], ["4", "1"], ["4", "1"])).toBe(755);
    expect(permission2number(["4", "2"], ["4"], [])).toBe(640);
  });

  it("collapses an all-empty selection to 0 rather than to NaN", () => {
    expect(permission2number([], [], [])).toBe(0);
  });

  it("drops leading zeros, so owner=0 does not keep its column", () => {
    // parseInt("077") — the string form is positional but the return value is not.
    expect(permission2number([], ["4", "2", "1"], ["4", "2", "1"])).toBe(77);
  });
});

describe("number2permission", () => {
  it("splits a triple back into per-group flag lists", () => {
    expect(number2permission(755)).toEqual({
      owner: ["4", "2", "1"],
      usergroup: ["4", "1"],
      everyone: ["4", "1"]
    });
    expect(number2permission(640)).toEqual({
      owner: ["4", "2"],
      usergroup: ["4"],
      everyone: []
    });
  });

  it("left-pads a short number, so 7 means everyone-rwx and not owner-rwx", () => {
    expect(number2permission(7)).toEqual({
      owner: [],
      usergroup: [],
      everyone: ["4", "2", "1"]
    });
    expect(number2permission(0)).toEqual({ owner: [], usergroup: [], everyone: [] });
  });
});

describe("round trip", () => {
  it.each([777, 755, 750, 700, 640, 444, 0])("survives number -> flags -> number for %i", (n) => {
    const { owner, usergroup, everyone } = number2permission(n);
    expect(permission2number(owner, usergroup, everyone)).toBe(n);
  });
});
