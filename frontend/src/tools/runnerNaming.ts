// runner 命名与标签分组的归一化规则。
//
// ⚠️ 这份实现与 daemon 的 `runner_provision.ts` 里的 `labelKey` 必须逐字符一致。两边算出的 key
// 是同一个「标签组」的身份：daemon 用它把已有 runner 归堆并推算下一个 `${prefix}-N`，前端用它
// 判断用户填的标签是否命中某个已有组、进而锁定命名前缀。两边一旦不一致，同一组标签会被算成
// 两个不同的组，`-N` 从头开始，整个 fleet 范围内出现重名 runner。
//
// 刻意不放进 common/：前端对 `mcsmanager-common` 至今只有 `import type`，编译期全被擦除。
// 引入第一个值导入会把 common 的 barrel（re-export 了 system_info 的 setInterval、
// system_storage 的 fs）拽进浏览器 bundle。一致性改由契约测试保证 ——
// 见 daemon/test/contract/label_key_parity.spec.ts。
export function labelKey(labels: string): string {
  return (labels || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort()
    .join(",");
}

// 一个待创建组的采番锚点。maxIndex / freeIndexes 由 daemon 的 listRepoGroups 算好后随
// repo_groups 接口回传；新组（前端刚填的标签没命中任何既有组）两者分别是 0 与空数组。
export interface NamePreviewGroup {
  prefix: string;
  count: number;
  maxIndex: number;
  freeIndexes: number[];
}

// 预览每组将创建的 runner 名字，下标与入参一一对应（数量为 0 或前缀为空的组给空数组）。
//
// ⚠️ 规则必须与 daemon `runner_provision.ts` 的 `allocateRunnerNames` 一致：先按升序填删除
// 留下的空缺，填完再从 maxIndex 往后累加。这里算错的后果不是崩溃，而是用户在对话框里看到
// 一串名字、点确定后建出来的却是另一串——比报错更难发现。
//
// 同前缀的多个组共享同一份空缺与游标：两组都从各自的 maxIndex 起算的话会预览出同一个名字，
// 而 daemon 那边 used 是跨组累积的，不会。
export function previewGroupNames(groups: NamePreviewGroup[]): string[][] {
  const out: string[][] = [];
  const freeOf = new Map<string, number[]>();
  const nextOf = new Map<string, number>();
  for (const g of groups) {
    // 自己 trim，不指望调用方：daemon 那边 `base` 也是 trim 过再判空的，而全是空格的基础名
    // 若当成有效前缀，预览会出现 "  -1" 这种名字，后端却根本不会建。
    const prefix = (g.prefix || "").trim();
    if (!prefix || g.count < 1) {
      out.push([]);
      continue;
    }
    // 拷一份再消费：freeIndexes 直接来自 repo_groups 的响应对象，前端把它存在 ref 里、
    // 每次输入都重算一遍预览——就地 shift 会让它在第一次渲染后变空。
    if (!freeOf.has(prefix)) freeOf.set(prefix, [...g.freeIndexes]);
    if (!nextOf.has(prefix)) nextOf.set(prefix, g.maxIndex);
    const free = freeOf.get(prefix) as number[];
    const names: string[] = [];
    for (let k = 0; k < g.count; k++) {
      let i = free.shift();
      if (i === undefined) {
        i = (nextOf.get(prefix) ?? 0) + 1;
        nextOf.set(prefix, i);
      }
      names.push(`${prefix}-${i}`);
    }
    out.push(names);
  }
  return out;
}
