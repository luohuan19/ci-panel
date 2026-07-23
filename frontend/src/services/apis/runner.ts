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

// 某组标签命中该 repo 已有 label 组，后端强制沿用既有命名前缀时的提示项
export interface RunnerBatchAligned {
  baseName: string; // 用户填的基础名
  labels: string; // 命中的标签
  prefix: string; // 实际沿用的既有前缀
}

// 某仓库在基目录下已有的一个 label 组
export interface RepoLabelGroup {
  key: string; // 归一化标签 key（组身份）
  labels: string; // 展示用原始标签
  prefix: string; // 命名前缀（累加锚点）
  count: number; // 现有数量
  maxIndex: number; // 现有 `${prefix}-N` 的最大 N
}

// 只读：列出某仓库在基目录下已有的 label 组
export const runnerRepoGroups = useDefineApi<
  { params: { daemonId: string }; data: { baseDir: string; repoUrl: string } },
  { groups: RepoLabelGroup[] }
>({
  url: "/api/runner/repo_groups",
  method: "POST"
});

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
  { results: RunnerBatchItemResult[]; aligned: RunnerBatchAligned[] }
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
  concurrency?: number; // 同时创建几个（1..10，默认 3）
}

export const startRunnerBatch = useDefineApi<
  { params: { daemonId: string }; data: RunnerBatchData },
  { batchId: string; items: { name: string }[]; aligned: RunnerBatchAligned[] }
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

// ---- 基目录选择器：浏览 / 新建目录（限扫描根内）----
export interface DirListing {
  path: string;
  parent: string; // 空 = 已在扫描根，不能再往上
  roots: string[];
  dirs: string[];
}
export const listRunnerDirs = useDefineApi<
  { params: { daemonId: string }; data: { path?: string } },
  DirListing
>({
  url: "/api/runner/list_dirs",
  method: "POST"
});
export const makeRunnerDir = useDefineApi<
  { params: { daemonId: string }; data: { path: string; name: string } },
  { path: string }
>({
  url: "/api/runner/mkdir",
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

// 彻底删除一个 runner：停+卸 systemd、GitHub 注销、清面板侧、删目录。不可逆。
export type DeleteStepStatus = "ok" | "failed" | "skipped";
export interface DeleteStep {
  key: "systemd" | "github" | "panel" | "dir";
  label: string;
  status: DeleteStepStatus;
  detail?: string; // 失败/跳过原因
  hint?: string; // 失败时可手动执行的命令
}
export interface DeleteRunnerResult {
  dir: string;
  ok: boolean;
  steps: DeleteStep[];
  warnings: string[];
}
export const deleteRunner = useDefineApi<
  {
    params: { daemonId: string };
    // removeToken：手输的 GitHub 删除 token（可选，留空则用仓库 PAT 自动获取）
    data: { dir: string; repo?: string; force?: boolean; removeToken?: string };
  },
  DeleteRunnerResult
>({
  url: "/api/runner/delete",
  method: "POST"
});

// 批量删除一个仓库（在某节点上）的全部 runner。整批共用一个 GitHub 删除 token。
export const deleteRunnerBatch = useDefineApi<
  {
    params: { daemonId: string };
    data: { repo: string; dirs: string[]; force?: boolean; removeToken?: string };
  },
  { results: Array<DeleteRunnerResult & { error?: string }> }
>({
  url: "/api/runner/delete_batch",
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

// ---- runner 环境变量：两个目标 ----
//   override —— systemd drop-in override.conf 的 Environment=，进监听进程（代理放这里）
//   dotenv   —— runner 目录的 .env，只进 job/step（设备号、库路径放这里）
export type EnvTarget = "override" | "dotenv";

export interface RunnerEnvVar {
  key: string;
  value: string;
}

// 单个目标文件的一节：是否存在 + 其中的变量
export interface RunnerEnvSection {
  present: boolean;
  vars: RunnerEnvVar[];
}

export interface RunnerEnvResult {
  dir: string;
  service: string; // systemd 单元名，空 = 未装服务
  hasSystemd: boolean; // 未装服务则不能写 override
  override: RunnerEnvSection; // systemd drop-in（进监听进程）
  dotenv: RunnerEnvSection; // .env（只进 job/step）
}

// 读某 runner 两个目标当前托管的环境变量（只读）
export const getRunnerEnv = useDefineApi<
  { params: { daemonId: string }; data: { dir: string } },
  RunnerEnvResult
>({
  url: "/api/runner/env_get",
  method: "POST"
});

// 设置某 runner 某目标的环境变量。replace=true 整表覆盖；否则合并（upsert 增改、remove 删除）。
// override 走特权助手写盘 + daemon-reload；dotenv 直接写文件。均不重启；生效需另调 restart。
export const setRunnerEnv = useDefineApi<
  {
    params: { daemonId: string };
    data: {
      dir: string;
      target: EnvTarget;
      upsert?: RunnerEnvVar[];
      remove?: string[];
      replace?: boolean;
    };
  },
  RunnerEnvResult
>({
  url: "/api/runner/env_set",
  method: "POST"
});

// 批量设置多个 runner 某目标的环境变量（panel 侧并行）。默认 merge，保留各自已有变量（如各台不同的 DEVICE_ID）。
export const setRunnerEnvBatch = useDefineApi<
  {
    params: { daemonId: string };
    data: {
      dirs: string[];
      target: EnvTarget;
      upsert?: RunnerEnvVar[];
      remove?: string[];
      replace?: boolean;
      concurrency?: number;
    };
  },
  { results: Array<{ dir: string; ok: boolean; error?: string } & Partial<RunnerEnvResult>> }
>({
  url: "/api/runner/env_set_batch",
  method: "POST"
});

// 批量启停/重启 systemd 托管的 runner（panel 侧并行执行，无 service 的项会被跳过）
export const controlRunnerServiceBatch = useDefineApi<
  {
    params: { daemonId: string };
    data: {
      items: Array<{ dir: string; service: string }>;
      action: "start" | "stop" | "restart";
      concurrency?: number;
    };
  },
  { results: Array<{ dir: string; service: string; ok: boolean; error?: string }> }
>({
  url: "/api/runner/service_control_batch",
  method: "POST"
});
