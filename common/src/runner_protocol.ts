// runner 纳管协议：daemon 实现、panel 转发、frontend 调用，三方共用同一份声明。
//
// 之前 daemon 与 frontend 各手写一份、panel 再声明一次自己用到的字段，给结果加一个
// 字段要改三处，漏一处只会在运行时才发现。
//
// 刻意只放类型、不引任何运行时依赖：前端用 `import type` 引它，编译期就被擦除，
// 不会把 common 里的 fs / child_process 代码带进浏览器 bundle。
export type RunnerSource = "provision" | "import";

// 纳管一个 runner 目录的入参
export interface RegisterRunnerItem {
  dir: string;
  repo?: string; // 仅作兜底：daemon 以目录里的 .runner 为准
  group?: string;
}

// 单个 runner 的纳管结果
export interface RegisterRunnerResult {
  dir: string;
  ok: boolean;
  markerId?: string;
  instanceUuid?: string; // 句柄实例 uuid（文件管理/配置/详情页要用）
  repo?: string; // daemon 从 .runner 解析出的仓库 slug，校验通过才有值
  error?: string;
}

// panel 在 daemon 的结果上追加 registeredRepos：本次顺带纳管进仓库注册表的仓库
export interface RegisterRunnersResponse {
  results: RegisterRunnerResult[];
  registeredRepos?: string[];
}
