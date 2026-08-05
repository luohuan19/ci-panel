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
