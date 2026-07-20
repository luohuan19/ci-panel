// 仓库注册表 + runner 归属（自研补充，对应 panel 的 /api/repo 路由）
//
// runner 列表不是面板存的，而是每次去各节点扫磁盘得到的：
// runner 目录下的 .runner 决定它属于哪个仓库，.service 决定它由哪个 systemd 单元托管。
import { useDefineApi } from "@/stores/useDefineApi";

// runner 由谁托管。both 和 none 都是要在 UI 上报警的异常态
export type RunnerManagedBy = "systemd" | "panel" | "both" | "none";

export interface RepoRunner {
  daemonId: string;
  nodeName: string;
  dir: string;
  dirName: string;
  agentName: string; // runner 在 GitHub 上的名字，未必等于目录名
  managedBy: RunnerManagedBy;
  service: string; // systemd 单元名，空 = 没装服务
  instanceUuid: string;
  running: boolean;
  busy: boolean; // 正在跑 job——停它会中断 CI 任务
  statusText: string;
  since: string;
  source: "provision" | "import" | ""; // .cipanel 里的纳管来源
  group: string; // .cipanel 里的所属组
  markerId: string; // .cipanel 里的管理标识
  broken?: string;
}

export interface RepoSummary {
  slug: string;
  url: string;
  remark?: string;
  createdAt?: number;
  hasToken?: boolean;
  runners: RepoRunner[];
  total: number;
  running: number;
  busy: number; // 正在跑 job 的 runner 数
  orphaned: number; // 没人托管，永远接不到任务
  conflicted: number; // systemd 和面板抢同一个目录
}

export interface RepoListResult {
  repos: RepoSummary[];
  unregistered: RepoSummary[]; // 磁盘上有 runner，但注册表里没有
  untaggedRunners: RepoRunner[];
  failedNodes: Array<{ daemonId: string; nodeName: string; error: string }>;
}

export const repoList = useDefineApi<any, RepoListResult>({
  url: "/api/repo/list",
  method: "GET"
});

export const repoAdd = useDefineApi<{ data: { url: string; remark?: string } }, RepoSummary>({
  url: "/api/repo/add",
  method: "POST"
});

export const repoDelete = useDefineApi<{ params: { slug: string } }, boolean>({
  url: "/api/repo/delete",
  method: "DELETE"
});

export const repoSetToken = useDefineApi<{ data: { slug: string; token: string } }, boolean>({
  url: "/api/repo/token",
  method: "POST"
});
