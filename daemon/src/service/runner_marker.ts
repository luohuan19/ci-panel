// CI Panel 扩展：runner 目录下的 .cipanel 标记文件。
//
// 它是「这个 runner 归面板纳管」的磁盘凭据，也是纳管关系的唯一真相源——面板不再另存一份
// 注册表去和磁盘对账，避免两份数据漂移。日常展示时 daemon 只返回带 .cipanel 的目录，
// 于是「面板管哪些 runner」由 marker 决定，而不是「机器上存在哪些 .runner」。
//
// 与同目录下另外两个文件各记一件事、互不覆盖：
//   .runner   —— GitHub 官方写的，记归属（gitHubUrl / agentName）
//   .service  —— svc.sh 写的，记 systemd 单元名（托管方式之一）
//   .cipanel  —— 本文件，记面板纳管来源（provision 创建 / import 导入）
//
// 全程只读/只写这一个文件，不碰 runner 本身。
import fs from "fs-extra";
import path from "path";
import { v4 } from "uuid";

export const MARKER_FILE = ".cipanel";
// v2：新增 labels 字段。v1 老 marker 无 labels，读出为 ""（标签未知），安全降级。
const MARKER_VERSION = 2;

// source 刻意只记「来源」（创建还是导入）这个不变量，不记 systemd/panel/both 这种
// 会漂移的实时托管方式——后者每次探测现算，存进静态文件只会过期误导。
export type RunnerSource = "provision" | "import";

export interface RunnerMarker {
  v: number;
  id: string; // 面板管理标识（与 GitHub agentName、面板实例 uuid 都无关）
  group: string; // 命名前缀（baseName），是同标签组「往后累加」的锚；单个导入可空
  repo: string; // owner/repo
  labels: string; // 注册时的原始 labels（逗号分隔，原样保留）；v1 老 marker / import 无此值时为 ""
  source: RunnerSource;
  managedSince: number; // 纳管时间（ms 时间戳）
}

export function markerPath(dir: string) {
  return path.join(dir, MARKER_FILE);
}

export function hasMarker(dir: string): boolean {
  return fs.existsSync(markerPath(dir));
}

export function readMarker(dir: string): RunnerMarker | null {
  try {
    const raw = fs.readFileSync(markerPath(dir), "utf8").replace(/^\uFEFF/, "");
    const j = JSON.parse(raw);
    if (!j || typeof j.id !== "string" || !j.id) return null;
    return {
      v: Number(j.v) || MARKER_VERSION,
      id: String(j.id),
      group: String(j.group || ""),
      repo: String(j.repo || ""),
      labels: String(j.labels || ""),
      source: j.source === "import" ? "import" : "provision",
      managedSince: Number(j.managedSince) || 0
    };
  } catch {
    return null;
  }
}

// 写 marker，幂等：目录已有 marker 时保留原 id / source / managedSince，只补齐 repo、group、labels。
// 这样重复纳管既不会换掉管理标识，也不会把「创建」误改成「导入」。
export function writeMarker(
  dir: string,
  data: { source: RunnerSource; repo?: string; group?: string; labels?: string; id?: string }
): RunnerMarker {
  const existing = readMarker(dir);
  const marker: RunnerMarker = existing
    ? {
        ...existing,
        v: MARKER_VERSION, // 顺带把 v1 老 marker 升到当前版本
        repo: data.repo || existing.repo,
        group: data.group ?? existing.group,
        labels: data.labels ?? existing.labels
      }
    : {
        v: MARKER_VERSION,
        id: data.id || v4().replace(/-/gim, ""),
        group: data.group || "",
        repo: data.repo || "",
        labels: data.labels || "",
        source: data.source,
        managedSince: Date.now()
      };
  fs.writeFileSync(markerPath(dir), JSON.stringify(marker, null, 2) + "\n", "utf8");
  return marker;
}

export function removeMarker(dir: string) {
  fs.removeSync(markerPath(dir));
}
