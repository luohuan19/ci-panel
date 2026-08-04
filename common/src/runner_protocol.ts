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

// runner 单元在 systemd 里的状态，daemon 从 systemctl show 解析
export interface SystemdState {
  service: string; // 单元名，来自 .service 文件
  loaded: boolean; // systemd 认不认识它（false = 服务文件已被删）
  activeState: string; // active / inactive / failed
  subState: string; // running / dead / ...
  enabled: string; // enabled / disabled / static
  since: string; // 主进程启动时间
}

export type SystemdAction = "start" | "stop" | "restart";

// 启停结果。daemon 侧走的是 systemctl --no-block（阻塞式 restart 遇上停不掉的单元能挂满
// 5 分钟），提交后最多轮询 8 秒确认落地：settled=false 表示 systemd 已受理但还没跑到位，
// 这不是失败，状态由页面自己的轮询继续收敛。
export interface ServiceControlResult {
  service: string;
  action: SystemdAction;
  settled: boolean; // false = systemd 收下了 job，但等待窗口内还没跑到位（多半是停不掉的单元）
  status: SystemdState | null; // settled 时是终态；否则是等待窗口结束时的即时状态
}
