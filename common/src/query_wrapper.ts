interface IMap {
  size: number;
  forEach: (value: any, key?: any) => void;
}

interface Page<T> {
  page: number;
  pageSize: number;
  maxPage: number;
  total: number;
  data: T[];
}

// Shared pagination for both data sources below. Previously each carried its own copy of
//   while (size > 0) { size -= pageSize; maxPage++; }
// which never terminates for pageSize <= 0. That loop is synchronous, so no timeout can
// preempt it: a single request with pageSize 0 pinned the whole event loop. Callers reach
// it through `toNumber(data.pageSize) ?? 1`, and toNumber("") is 0, which ?? does not catch.
function paginate<T>(data: T[], page: number, pageSize: number) {
  // Floor before validating, not after: callers clamp with Math.max/Math.min, which keeps a
  // fractional page_size from the query string intact (the route validator only runs
  // Number()). The old loop tolerated 1.5, so rejecting it outright would turn a request
  // that used to work into a 500. Flooring first also rejects 0.5, which would otherwise
  // survive the > 0 check and then divide by zero.
  const size = Math.floor(pageSize);
  if (!Number.isFinite(size) || size <= 0)
    throw new RangeError(`pageSize must be a positive number, got ${pageSize}`);
  // page 同样要取整：一个小数 page 会让 start 落在页边界之间，返回的窗口跨着两页。
  const index = Math.floor(page);
  if (!Number.isFinite(index) || index <= 0)
    throw new RangeError(`page must be a positive number, got ${page}`);
  const start = (index - 1) * size;
  return {
    page: index,
    pageSize: size,
    maxPage: Math.ceil(data.length / size),
    data: data.slice(start, start + size)
  };
}

// Provide the MAP query interface used by the routing layer
export class QueryMapWrapper {
  constructor(public map: IMap) {}

  select<T>(condition: (v: T) => boolean): T[] {
    const result: T[] = [];
    this.map.forEach((v: T) => {
      if (condition(v)) result.push(v);
    });
    return result;
  }

  page<T>(data: T[], page = 1, pageSize = 10) {
    return paginate(data, page, pageSize);
  }
}

// Data source interface for QueryWrapper to use
export interface IDataSource<T> {
  selectPage: (condition: any, page: number, pageSize: number) => Page<T>;
  select: (condition: any) => any[];
  update: (condition: any, data: any) => void;
  delete: (condition: any) => void;
  insert: (data: any) => void;
}

// MYSQL data source
export class MySqlSource<T> implements IDataSource<T> {
  constructor(public data: any) {}
  selectPage(condition: any, page: number, pageSize: number) {
    return {
      page,
      pageSize,
      maxPage: 0,
      total: 0,
      data: []
    };
  }
  select(condition: any) {
    return [];
  }
  update(condition: any, data: any) {}
  delete(condition: any) {}
  insert(data: any) {}
}

// local file data source (embedded microdatabase)
export class LocalFileSource<T> implements IDataSource<T> {
  constructor(public data: any) {}

  selectPage(condition: any, page = 1, pageSize = 10) {
    const result: T[] = [];
    this.data.forEach((v: any) => {
      for (const key in condition) {
        const dataValue = v[key];
        const targetValue = condition[key];
        // Only a %needle% value — leading AND trailing % — is treated as a substring match.
        // manage_user_router builds `%${userName}%` for its admin search and relies on this.
        //
        // Anything else compares exactly. The previous form keyed off the leading % alone and
        // searched for `slice(1, length - 1)`, so a bare "%" searched for "" — and
        // "".includes("") is always true, matching every record. getUuidByApiKey accepts on
        // total === 1, so `?apikey=%` resolved to the user on a single-user panel. The same
        // slice was off by one without a trailing %: "%abc" searched for "ab".
        const isPattern =
          typeof targetValue === "string" &&
          targetValue.length > 2 &&
          targetValue.startsWith("%") &&
          targetValue.endsWith("%");
        if (isPattern) {
          const needle = targetValue.slice(1, -1);
          if (typeof dataValue !== "string" || !dataValue.includes(needle)) return;
        } else if (targetValue !== dataValue) {
          return;
        }
      }
      result.push(v);
    });
    return this.page(result, page, pageSize);
  }

  page(data: T[], page = 1, pageSize = 10) {
    return { ...paginate(data, page, pageSize), total: data.length };
  }

  select(condition: any): any[] {
    return [];
  }
  update(condition: any, data: any) {}
  delete(condition: any) {}
  insert(data: any) {}
}

// Provide the unified data query interface used by the routing layer
export class QueryWrapper<T> {
  constructor(public dataSource: IDataSource<T>) {}

  selectPage(condition: any, page = 1, pageSize = 10) {
    return this.dataSource.selectPage(condition, page, pageSize);
  }
}
