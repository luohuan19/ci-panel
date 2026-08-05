import { describe, expect, it } from "vitest";
// Import the module directly, never `../../src/index` — the barrel pulls in system_info and
// every other consumer's import-time side effects for no benefit here (TESTING.md §7.1).
import { LocalFileSource, QueryMapWrapper } from "../../src/query_wrapper";

// A stub satisfying IMap. `page()` never touches it, but the constructor requires it.
const emptyMap = { size: 0, forEach: () => {} };
const wrapper = () => new QueryMapWrapper(emptyMap);

describe("paginate — rejects a page size that cannot terminate", () => {
  // Both data sources used to compute maxPage with `while (size > 0) { size -= pageSize }`,
  // which never terminates for pageSize <= 0. That loop is SYNCHRONOUS: it pins the event
  // loop, so no test timeout and no request timeout can preempt it. A single
  // `instance/select` with pageSize 0 was enough to wedge a daemon.
  it.each([0, -1, -10, 0.5, 0.999, NaN])("rejects pageSize %p", (n) => {
    expect(() => wrapper().page([1, 2, 3], 1, n)).toThrow(RangeError);
  });

  it("rejects a non-finite pageSize", () => {
    // Math.floor(Infinity) is Infinity, which survives `<= 0` — the guard needs isFinite too.
    expect(() => wrapper().page([1, 2, 3], 1, Infinity)).toThrow(RangeError);
    expect(() => wrapper().page([1, 2, 3], 1, -Infinity)).toThrow(RangeError);
  });

  it("names the offending value so the 500 is diagnosable", () => {
    expect(() => wrapper().page([1], 1, 0)).toThrow(/pageSize must be a positive number, got 0/);
  });
});

describe("paginate — rejects an unusable page index", () => {
  it.each([0, -1, 0.5, NaN, Infinity])("rejects page %p", (n) => {
    expect(() => wrapper().page([1, 2, 3], n, 10)).toThrow(RangeError);
  });

  it("names the offending value", () => {
    expect(() => wrapper().page([1], 0, 10)).toThrow(/page must be a positive number, got 0/);
  });
});

describe("paginate — floors rather than rejects a fractional value", () => {
  // Deliberate asymmetry. Callers clamp with Math.max/Math.min and the route validator only
  // runs Number(), so a fractional page_size reaches here intact from the query string. The
  // old loop tolerated 1.5; rejecting it outright would turn a request that used to work
  // into a 500. Flooring first is also what makes 0.5 reject instead of dividing by zero.
  it("floors pageSize", () => {
    expect(wrapper().page([1, 2, 3, 4], 1, 1.5).pageSize).toBe(1);
    expect(wrapper().page([1, 2, 3, 4], 1, 2.9).pageSize).toBe(2);
  });

  it("floors page, so the window never straddles two pages", () => {
    expect(wrapper().page([1, 2, 3, 4], 1.5, 2).page).toBe(1);
    expect(wrapper().page([1, 2, 3, 4], 1.5, 2).data).toEqual([1, 2]);
  });
});

describe("paginate — the arithmetic itself", () => {
  it("returns the requested window", () => {
    expect(wrapper().page([1, 2, 3], 2, 1)).toEqual({
      page: 2,
      pageSize: 1,
      maxPage: 3,
      data: [2]
    });
  });

  it("computes maxPage with a partial last page", () => {
    expect(wrapper().page([1, 2, 3, 4, 5], 1, 2).maxPage).toBe(3);
    expect(wrapper().page([1, 2, 3, 4], 1, 2).maxPage).toBe(2);
  });

  it("returns an empty window past the end rather than throwing", () => {
    expect(wrapper().page([1, 2, 3], 99, 10).data).toEqual([]);
  });

  it("handles an empty data set", () => {
    expect(wrapper().page([], 1, 10)).toEqual({ page: 1, pageSize: 10, maxPage: 0, data: [] });
  });
});

describe("LocalFileSource shares the same guard", () => {
  // The two sources used to carry separate copies of the loop; only a shared paginate()
  // keeps them from drifting apart again.
  it("rejects pageSize 0 through selectPage too", () => {
    const source = new LocalFileSource([{ k: "a" }]);
    expect(() => source.selectPage({}, 1, 0)).toThrow(RangeError);
  });

  it("adds total alongside the paginated window", () => {
    const source = new LocalFileSource([{ k: "a" }, { k: "b" }, { k: "c" }]);
    expect(source.selectPage({}, 1, 2)).toEqual({
      page: 1,
      pageSize: 2,
      maxPage: 2,
      total: 3,
      data: [{ k: "a" }, { k: "b" }]
    });
  });
});
