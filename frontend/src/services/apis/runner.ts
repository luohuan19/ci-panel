// 一键添加 Runner 接口（自研补充，对应 panel 的 /api/runner 路由）
import { useDefineApi } from "@/stores/useDefineApi";

export interface ProvisionRunnerResult {
  instanceUuid: string;
  nickname: string;
  alreadyConfigured: boolean;
}

export const provisionRunner = useDefineApi<
  {
    params: { daemonId: string };
    data: {
      repoUrl: string;
      token: string;
      name: string;
      labels?: string;
      targetDir: string;
      proxy?: string;
    };
  },
  ProvisionRunnerResult
>({
  url: "/api/runner/provision",
  method: "POST"
});

// ---- 批量：多组标签，每组 <基础名>-1..-N ----
export interface RunnerBatchGroup {
  baseName: string;
  labels?: string;
  count: number;
}

export interface RunnerBatchItemResult {
  name: string;
  ok: boolean;
  instanceUuid?: string;
  error?: string;
}

export const startRunnerDownload = useDefineApi<
  { params: { daemonId: string }; data: { version?: string; proxy?: string; force?: boolean } },
  { downloadId: string; version: string; url: string; skipped: boolean }
>({
  url: "/api/runner/download_start",
  method: "POST"
});

export interface RunnerDownloadProgress {
  total: number;
  received: number;
  percent: number;
  speed: number; // bytes/s
  done: boolean;
  error?: string;
  version: string;
  path: string;
}

export const runnerDownloadProgress = useDefineApi<
  { params: { daemonId: string }; data: { downloadId: string } },
  RunnerDownloadProgress
>({
  url: "/api/runner/download_progress",
  method: "POST"
});

export interface RunnerCheckResult {
  mode: "direct" | "import";
  path: string;
  exists: boolean;
  localVersion?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  checkError?: string;
  isTarGz?: boolean;
  sizeMB?: number;
  version?: string;
}

export const checkRunnerPackage = useDefineApi<
  {
    params: { daemonId: string };
    data: { mode: string; packagePath?: string; proxy?: string };
  },
  RunnerCheckResult
>({
  url: "/api/runner/check",
  method: "POST"
});

export const provisionRunnerBatch = useDefineApi<
  {
    params: { daemonId: string };
    data: {
      repoUrl: string;
      token: string;
      proxy?: string;
      baseDir: string;
      groups: RunnerBatchGroup[];
      packagePath?: string;
    };
  },
  { results: RunnerBatchItemResult[] }
>({
  url: "/api/runner/provision_batch",
  method: "POST"
});

// ---- 异步批量：启动后台任务 + 轮询进度 ----
interface RunnerBatchData {
  repoUrl: string;
  token: string;
  proxy?: string;
  baseDir: string;
  groups: RunnerBatchGroup[];
  packagePath?: string;
}

export const startRunnerBatch = useDefineApi<
  { params: { daemonId: string }; data: RunnerBatchData },
  { batchId: string; items: { name: string }[] }
>({
  url: "/api/runner/batch_start",
  method: "POST"
});

export type RunnerBatchItemStatus = "pending" | "running" | "done" | "failed";

export interface RunnerBatchProgressItem {
  name: string;
  status: RunnerBatchItemStatus;
  step: string;
  instanceUuid?: string;
  error?: string; // 简短错误
  log?: string; // 完整错误日志（复制/下载用）
}

export interface RunnerBatchProgress {
  done: boolean;
  total: number;
  doneCount: number;
  failCount: number;
  items: RunnerBatchProgressItem[];
}

export const runnerBatchProgress = useDefineApi<
  { params: { daemonId: string }; data: { batchId: string } },
  RunnerBatchProgress
>({
  url: "/api/runner/batch_progress",
  method: "POST"
});

// 重试某批的失败项（新 token 重跑，复用同一 batchId 轮询）
export const retryRunnerBatch = useDefineApi<
  { params: { daemonId: string }; data: { batchId: string; token: string; proxy?: string } },
  { batchId: string; retrying: number }
>({
  url: "/api/runner/batch_retry",
  method: "POST"
});

// 收集：扫描基目录，纳入已注册但未建实例的 runner
export interface CollectRunnersResult {
  baseDir: string;
  collected: { name: string; instanceUuid: string; repo: string }[];
  skipped: { name: string; reason: string }[];
}

export const collectRunners = useDefineApi<
  { params: { daemonId: string }; data: { baseDir: string } },
  CollectRunnersResult
>({
  url: "/api/runner/collect",
  method: "POST"
});

// ---- 扫描：以磁盘为准列出节点上真实存在的 runner（只读，不建实例）----
export interface ScannedRunner {
  dir: string;
  dirName: string;
  repo: string;
  agentName: string;
  systemd: {
    service: string;
    loaded: boolean;
    activeState: string;
    subState: string;
    enabled: string;
    since: string;
  } | null;
  instanceUuid: string;
  instanceStatus: number;
  managedBy: "systemd" | "panel" | "both" | "none";
  busy: boolean; // 正在跑 job
  managed: boolean; // 是否已纳管（有 .cipanel）
  markerId: string; // marker 管理标识，空 = 未纳管
  source: "provision" | "import" | ""; // 纳管来源
  group: string; // 所属组
  exists: boolean; // 目录是否还在且含 .runner
  broken?: string;
}

export const scanRunners = useDefineApi<
  { params: { daemonId: string }; data: { roots?: string[] } },
  { roots: string[]; runners: ScannedRunner[]; errors: Array<{ dir: string; error: string }> }
>({
  url: "/api/runner/scan",
  method: "POST"
});

// ---- 纳管 / 取消纳管：写、删 .cipanel 标记 ----
export interface RegisterRunnerItem {
  dir: string;
  repo?: string;
  group?: string;
}

export interface RegisterRunnerResult {
  dir: string;
  ok: boolean;
  markerId?: string;
  instanceUuid?: string; // 句柄实例 uuid
  error?: string;
}

// 纳管选中的 runner（只写标记，不建实例）。source 缺省为 import
export const registerRunners = useDefineApi<
  {
    params: { daemonId: string };
    data: { items: RegisterRunnerItem[]; source?: "provision" | "import" };
  },
  { results: RegisterRunnerResult[] }
>({
  url: "/api/runner/register",
  method: "POST"
});

// 取消纳管（删 .cipanel）。removedInstance=true 说明顺带回收了句柄实例
export const unregisterRunner = useDefineApi<
  { params: { daemonId: string }; data: { dir: string } },
  { dir: string; ok: boolean; hadInstance: boolean; removedInstance: boolean }
>({
  url: "/api/runner/unregister",
  method: "POST"
});

// 探单个 runner 的实时状态（详情页基本信息 + 定时刷新）。返回 daemon 的 ScannedRunner 结构
export const runnerState = useDefineApi<
  { params: { daemonId: string }; data: { dir: string } },
  { runner: ScannedRunner | null }
>({
  url: "/api/runner/state",
  method: "POST"
});

// ---- NPU(昇腾)占用率 ----
export interface NpuChip {
  npuId: number;
  chipId: number;
  phyId: number;
  name: string;
  health: string;
  power: number; // W
  temp: number; // ℃
  util: number; // AICore(%) 占用率
  hbmUsed: number; // MB
  hbmTotal: number; // MB
}

export interface NpuStatus {
  available: boolean; // 该节点有没有 npu-smi
  chips: NpuChip[];
  avgUtil: number;
  busyChips: number;
  hbmUsed: number; // MB
  hbmTotal: number; // MB
  chart: number[];
  sampledAt: number;
  error?: string;
}

// 所有节点的 NPU 状态：{ daemonId: NpuStatus }
export const npuStatusAll = useDefineApi<undefined, Record<string, NpuStatus>>({
  url: "/api/runner/npu_status",
  method: "POST"
});

// ---- runner 的 _diag 运行日志（看控制台，只读，免 sudo）----
export interface DiagLogFile {
  name: string;
  size: number;
  mtime: number;
}

export interface DiagLogResult {
  dir: string;
  files: DiagLogFile[]; // _diag 下所有 *.log，最新在前
  file: string; // 实际返回内容的文件名
  content: string; // 初次=尾部；跟随=新增段
  size: number; // 该文件当前总字节数
  nextOffset: number; // 下次跟随从这里继续
  reset: boolean; // true = 文件被截断/轮转，客户端应清屏后用 content 重铺
  truncated: boolean;
}

export const runnerDiagLogs = useDefineApi<
  {
    params: { daemonId: string };
    data: { dir: string; file?: string; lines?: number; offset?: number };
  },
  DiagLogResult
>({
  url: "/api/runner/diag_logs",
  method: "POST"
});

// 启停 systemd 托管的 runner。依赖 daemon 侧的 sudoers 免密白名单
export const controlRunnerService = useDefineApi<
  { params: { daemonId: string }; data: { service: string; action: "start" | "stop" | "restart" } },
  { service: string; activeState: string; subState: string } | null
>({
  url: "/api/runner/service_control",
  method: "POST"
});
