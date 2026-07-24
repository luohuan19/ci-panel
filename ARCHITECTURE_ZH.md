# ci-panel 架构说明

一个跨多台机器管理 **GitHub Actions self-hosted runner** 的 Web 面板。

ci-panel 是 [MCSManager](https://github.com/MCSManager/MCSManager) 的 fork。它保留了上游
的面板/守护进程拓扑——一个中心 Web 后端，通过长连 Socket.IO 与每台机器上的一个 daemon
通信——把游戏服领域替换成了 runner 管理。Minecraft/游戏服相关功能已全部移除，见
[与上游的差异](#与上游的差异)。

> English version: [ARCHITECTURE.md](ARCHITECTURE.md)

## 目录

- [拓扑](#拓扑)
- [包结构](#包结构)
- [Panel](#panel)
- [Daemon](#daemon)
- [Panel ↔ Daemon 协议](#panel--daemon-协议)
- [前端](#前端)
- [Common](#common)
- [Runner 管理](#runner-管理)
- [仓库注册表与 CI 看板](#仓库注册表与-ci-看板)
- [磁盘上的数据](#磁盘上的数据)
- [构建与部署](#构建与部署)
- [国际化](#国际化)
- [与上游的差异](#与上游的差异)

## 拓扑

```text
                  浏览器
                    │  HTTP + Socket.IO   （默认 :23333，数据端口 :23334）
                    ▼
   ┌────────────────────────────────┐
   │  panel（Koa, mcsmanager-panel）│   用户 · 认证 · 权限 · HTTP API
   │  data/  User RemoteServiceConfig│  SystemConfig RepoConfig operation_logs
   └───────────────┬────────────────┘
                   │ 每个节点一个 Socket.IO 客户端，用共享密钥认证
      ┌────────────┼────────────┐
      ▼            ▼            ▼
 ┌─────────┐  ┌─────────┐  ┌─────────┐
 │ daemon  │  │ daemon  │  │ daemon  │   节点本地：文件系统、systemd、Docker
 │  :24444 │  │         │  │         │
 └────┬────┘  └─────────┘  └─────────┘
      │ 扫描 / 部署 / 读取
      ▼
  磁盘上的 actions-runner 目录
  <目录>/.runner  .service  .cipanel  _diag/
      │ 托管方式
      ▼
  systemd 单元  actions.runner.<owner>-<repo>.<name>.service
```

面板从不直接碰 runner。所有节点本地的动作——文件系统访问、`systemctl`、Docker、拉起
进程——都发生在 daemon 里，面板通过在 socket 上发一个具名事件来触达。

## 包结构

四个包，**不是** npm workspace。各自有独立的 `node_modules`，需要分别安装和构建。
改动 `common/` 后必须先重新构建，其余三个包才看得到类型变化。

| 包 | npm 名称 | 职责 |
| --- | -------- | ---- |
| `panel/` | `mcsmanager-panel` | Web 后端：用户、认证、节点连接、HTTP API |
| `daemon/` | `mcsmanager-daemon` | 节点代理：runner 扫描/部署/日志、实例、文件、Docker |
| `frontend/` | `mcsmanager-ui` | Vue 3 单页应用（`<script setup lang="ts">`） |
| `common/` | `mcsmanager-common` | 共享类型与工具，被其余三个包引用 |

npm 包名沿用上游、刻意未改——`panel/` 和 `daemon/` 是按名字 `mcsmanager-common` 引入的。

```bash
npm run install-dependents   # 安装 panel + daemon + frontend
npm run preview-build        # 构建 common/（要先于其余三个）
npm run dev                  # 三个一起跑
./build.sh                   # 生产构建 -> production-code/
```

开发态端口：前端走 Vite 的 `:5173`，把 `/api` 代理到 `:23333` 的面板。

## Panel

Koa 应用。入口 `panel/src/app.ts`，路由在 `panel/src/app/index.ts` 里以 `/api` 前缀挂载。

### HTTP API 分布

| 路由文件 | 前缀 | 覆盖范围 |
| -------- | ---- | -------- |
| `runner_router.ts` | `/api/runner` | runner 扫描、部署、纳管/取消纳管、批量操作、环境变量、服务控制、诊断日志、目录选择器 |
| `repo_router.ts` | `/api/repo` | 仓库注册表：列表、新增、更新、删除 |
| `ci_router.ts` | `/api/ci` | CI 看板——代理 GitHub Actions API |
| `daemon_router.ts` | `/api/service` | 节点（daemon）连接管理 |
| `instance_admin_router.ts` | `/api/instance` | 实例增删改查、多实例操作 |
| `instance_operate_router.ts` | `/api/protected_instance` | 单实例启停/终止/发命令、终端数据通道、配置更新 |
| `filemananger_router.ts` | `/api/files` | 文件管理代理 |
| `environment_router.ts` | `/api/environment` | Docker 镜像、容器、网络 |
| `schedule_router.ts` | `/api/protected_schedule` | 计划任务 |
| `login_router.ts`、`general_user_router.ts`、`manage_user_router.ts`、`user_overview_router.ts` | `/api/auth` | 登录、会话、API Key、用户管理 |
| `sso_router.ts` | `/api/auth/sso` | OIDC / OAuth 2.0 单点登录 |
| `overview_router.ts`、`settings_router.ts` | `/api/overview` | 总览数据与系统设置 |

### 服务层

| 服务 | 职责 |
| ---- | ---- |
| `remote_service.ts` | 持有每个节点的 Socket.IO 客户端；连接生命周期与可用性 |
| `remote_command.ts` | `RemoteRequest`——带 UUID 和超时的 socket 请求/响应 |
| `repo_service.ts` | 仓库注册表，以及把 `runner/scan` 扇出到各节点 |
| `user_service.ts`、`passport_service.ts`、`permission_service.ts` | 用户、会话、API Key、按实例授权 |
| `sso_service.ts`、`user_sso_service.ts` | SSO 提供方与账号绑定 |
| `frontend_layout.ts` | 下发并持久化前端的卡片布局配置 |
| `operation_logger.ts` | 只追加的审计日志（JSONL） |
| `visual_data.ts` | 总览图表用的请求/实例计数 |
| `instance_service.ts` | 实例列表拼装、跨节点转发 |
| `version_adapter.ts` | 版本间的磁盘配置迁移 |

### 认证与权限

`ROLE` 为 `ADMIN = 10`、`USER = 1`、`GUEST = 0`、`BAN = -1`
（`panel/src/app/entity/user.ts`）。路由通过 `permission` 中间件声明最低等级；涉及实例的
路由还会经 `permission_service` 校验归属。会话基于 cookie，另有 API Key 请求头供程序化
访问，支持 2FA（TOTP）和可选 SSO。`middleware/limit.ts` 做限流，
`middleware/validator.ts` 在边界校验 query 与 body 的形状。

## Daemon

Socket.IO **服务端**（默认 `:24444`）。它不主动外连，是面板连过来。入口
`daemon/src/app.ts`；各路由把事件处理器注册到共享的 `routerApp` 事件发射器上
（`daemon/src/service/router.ts`）。

### 事件分布

| 路由文件 | 事件 |
| -------- | ---- |
| `runner_router.ts` | `runner/scan` `managed_list` `register` `unregister` `delete` `provision` `provision_batch` `batch_start` `batch_progress` `batch_retry` `check` `collect` `repo_groups` `state` `service_control` `env_get` `env_set` `diag_logs` `list_dirs` `mkdir` `download_start` `download_progress` |
| `Instance_router.ts` | `instance/select` `overview` `section` `detail` `new` `update` `open` `stop` `restart` `kill` `command` `delete` `forward` `asynchronous` `stop_asynchronous` `outputlog` |
| `file_router.ts` | `file/list` `chmod` `chmod_batch` `status` `touch` `mkdir` `copy` `move` `delete` `edit` `compress` `download_from_url` `download_from_url_stop` |
| `environment_router.ts` | `environment/images` `containers` `networkModes` `new_image` `del_image` `progress` `image_platforms` |
| `stream_router.ts` | `stream/auth` `detail` `input` `write` `resize` |
| `schedule_router.ts` | `schedule/register` `list` `delete` |
| `auth_router.ts`、`passport_router.ts`、`info_router.ts` | `auth`、`passport/register`、`info/overview`、`info/setting` |

### 服务层

runner 专属服务见 [Runner 管理](#runner-管理)，其余是沿用的进程/容器基础设施：

| 服务 | 职责 |
| ---- | ---- |
| `system_instance.ts` | 实例注册表；加载、创建、删除、转发 I/O |
| `docker_process_service.ts` | `SetupDockerContainer`——组装容器规格（端口、卷、cgroup 限额、GPU 设备直通）并 attach |
| `system_file.ts` | 以实例 cwd 为根的沙箱文件访问 |
| `download_manager.ts`、`upload_manager.ts` | 文件传输任务 |
| `network_limit_service.ts`、`disk_limit_service.ts` | 按容器的流量与磁盘配额 |
| `system_visual_data.ts` | 节点的 200 点滚动 CPU% / 内存% 序列 |
| `async_task_service/` | 长任务基类（`AsyncTask`） |

### 实例与命令

**实例**是 daemon 的进程管理单元。`FunctionDispatcher`
（`entity/commands/dispatcher.ts`）根据实例配置给它挂上一组预设命令：

| 预设 | 实现 |
| ---- | ---- |
| `start` | `GeneralStartCommand`；开了仿真终端用 `PtyStartCommand`；Docker 模式用 `DockerStartCommand` |
| `stop` / `kill` / `restart` / `update` / `command` | `general/*` 系列命令 |
| `resize` | `PtyResizeCommand` / `DockerResizeCommand` |

同时注册生命周期任务（`TimeCheck`、`InstanceDiskCheckTask`、`DockerStatsTask`）。
在这个 fork 里，绝大多数实例是**句柄实例**，见下文。

## Panel ↔ Daemon 协议

- 传输：Socket.IO。面板是客户端，daemon 是服务端。
- 认证：daemon 在配置里生成 `key`，面板按节点保存并在 `auth` 事件里发过去。除 `auth` 和
  `stream/*` 通道外，其余一律要求已认证会话。密钥比较是常量时间的。
- 请求/响应：`RemoteRequest.request(event, data, timeout)` 给报文附一个 UUID，收到同
  UUID 的回包时 resolve（`{ uuid, data, status }`）。默认超时 6 秒。
- 推送：daemon 主动发 `instance/stdout`、`instance/stopped`、`instance/opened`、
  `instance/failure`，用于实时终端输出与状态变化。
- 终端数据通道：`stream/*` 是独立的授权路径。面板经 `passport/register` 下发一次性口令，
  浏览器拿它自己直连 daemon，终端 I/O 不经过面板。

## 前端

Vue 3 + TypeScript + Vite，Ant Design Vue、Pinia、`vue-i18n`、xterm.js、ECharts。

### 卡片布局系统

大部分页面不是手写的，而是运行时解析出的一串**卡片**：

1. `panel/src/app/service/frontend_layout.ts` 下发布局配置——用户保存的 `layout.json`
   或内置默认值——形式是页面列表，每页含若干卡片项
   `{ id, type, title, width, height, meta }`。
2. `LayoutContainer.vue` 取出当前路由对应的卡片项。
3. `LayoutCard.vue` 通过 `LAYOUT_CARD_TYPES`（`frontend/src/config/index.ts`）把
   `card.type` 映射成组件并渲染。

`type` 是纯字符串，**没有任何静态检查会校验它**。若已保存的布局引用了不再存在的卡片
类型，`LayoutCard.vue` 会渲染带类型名的 `CardError`，而不是留一块空白。

有两个页面刻意绕开卡片系统，是普通的路由组件：`/ci`（`CiJobs.vue`）和
`/instances/runner`（`RunnerDetail.vue`，用懒加载规避一处循环依赖导致的求值顺序问题）。

### 目录布局

| 路径 | 内容 |
| ---- | ---- |
| `views/` | 路由级外壳：`LayoutContainer`、`Login`、`Install`、`SsoBindLogin` |
| `widgets/` | 卡片组件：`RunnerExplorer`、`RunnerDetail`、`RunnerLogView`、`CiJobs`、`NodeList`、`UserList`、`Settings`、`instance/*` 等 |
| `components/` | 可复用 UI。**此目录下的组件全部由 `unplugin-vue-components` 全局自动注册**，因此可以不 import、直接用 `<kebab-case-tag>` |
| `hooks/` | 组合式函数：`useInstance`、`useTerminal`、`useFileManager`、`useRemoteNode`、`useCardTools` 等 |
| `services/apis/` | 基于 `useDefineApi` 的带类型 API 客户端 |
| `stores/` | Pinia store：应用状态、应用配置、布局配置、卡片池 |
| `config/` | `router.ts`（路由）、`index.ts`（卡片注册表 + 卡片池） |

### Runner 相关界面

| 组件 | 作用 |
| ---- | ---- |
| `RunnerExplorer.vue` | `/instances` 主页面：按仓库分组的 runner 列表、批量勾选与操作 |
| `AddRunnerDialog.vue` | 部署 runner——单个或批量，可设标签与代理 |
| `ImportRunnerDialog.vue` | 全盘扫描后纳管已存在的 runner |
| `RunnerDetail.vue` | `/instances/runner`：实时状态、环境变量、内嵌文件管理、删除流程 |
| `RunnerLogView.vue` | 增量跟随 `_diag` 日志 |
| `CiJobs.vue` | `/ci`：各仓库最近的 workflow 运行记录 |

## Common

用 `tsc` 构建到 `common/dist`，按包名引用。导出：`StorageSubsystem`（JSON 文件持久化）、
`GlobalVariable`、`InstanceStreamListener`、`ProcessWrapper` / `killProcess`、
`QueryWrapper` / `QueryMapWrapper` / `LocalFileSource`（分页查询）、`systemInfo`、
Docker 平台归一化，以及类型转换工具（`toText`、`toNumber`、`toBoolean`、`isEmpty`、
`configureEntityParams`）。

`common/global.d.ts` 声明跨包共享的全局接口，主要是 `IGlobalInstanceConfig` 和
`IGlobalInstanceDockerConfig`。

## Runner 管理

这是这个 fork 存在的意义所在。整套设计建立在一个决定之上：

> **文件系统是真相源，而不是面板侧的数据库。**

### 标记文件

每个 runner 目录下有三个文件，各记一件事，互不覆盖：

| 文件 | 写入方 | 记录内容 |
| ---- | ------ | -------- |
| `.runner` | GitHub 官方 runner，注册时写 | 归属——`gitHubUrl`、`agentName` |
| `.service` | `svc.sh`，装单元时写 | systemd 单元名 |
| `.cipanel` | ci-panel（`runner_marker.ts`） | 该 runner 归面板纳管，以及来源是 `provision` 还是 `import` |

`.cipanel` 是纳管关系的**唯一**真相源。面板不再另存一份注册表去和磁盘对账——这正是两者
不会漂移的原因。

### 服务

| 服务 | 职责 |
| ---- | ---- |
| `runner_scan.ts` | 遍历白名单根目录，报告磁盘上真实存在的东西。`scanManagedRunners`（带 `.cipanel`）驱动日常展示，`scanRunners`（全部）只给导入流程用。用异步 `execFile`：它每约 10 秒跑一次，同步调用 `systemctl` 可能卡住 daemon 的单线程事件循环，久到丢掉 WebSocket 心跳 |
| `runner_provision.ts` | 解压安装包 → `config.sh` 注册到 GitHub → 安装并启动 systemd 单元 → 建立句柄实例 |
| `runner_marker.ts` | 读写 `.cipanel`（v2 格式，新增 `labels`） |
| `runner_env.ts` | 两个语义不同的环境变量目标，见下 |
| `runner_logs.ts` | 增量 tail `_diag/Runner_*.log` 与 `Worker_*.log`，单次回读上限 512 KB |

### 托管模型

**只用 systemd。** 部署出来的 runner 由它自己的 systemd 单元拉起，因此能扛住重启和
daemon 重启，`managedBy` 只会是 `systemd` 或 `none`。

面板侧的实例是**句柄实例**：不带启动命令，永远不跑 runner。它存在的意义是给文件管理、
配置和详情页——这些接口都按 `instanceUuid` 授权、以实例 cwd 为根——提供一个抓手。早期
设计是让 daemon 把 `run.sh` 当子进程托管，已废弃：两个托管方会抢同一个 GitHub 身份。

### 特权操作

daemon 以非 root 用户（`ci-runner`）运行，只通过一个脚本提权——
`prod-scripts/ci-panel-runner-svc`，用 `sudo -n` 调用：

- 脚本 root 所有，`ci-runner` 不可写；
- 只把自己生成的 unit 写进 `/etc/systemd/system`，绝不执行 runner 目录里的脚本
  （那个目录 `ci-runner` 是**可写**的）；
- 生成的 unit 以 `User=<目录属主>` 运行 `runsvc.sh`，runner 本身仍是普通用户身份；
- 目标目录必须在白名单根下且含 `.runner`，单元名必须匹配
  `^actions\.runner\.[A-Za-z0-9._@-]+\.service$`。

`install-runner-privileges.sh` 负责安装脚本与对应的 sudoers 条目；助手带 `VERSION`，
部署时可用 `preflight` 认出机器上装的是旧版本。

### 环境变量

两个目标，因为这批机器上的 `runsvc.sh` 不 source `.env`：

| 目标 | 位置 | 作用范围 | 权限 |
| ---- | ---- | -------- | ---- |
| `override` | systemd drop-in `/etc/systemd/system/<unit>.d/override.conf` | 监听进程——代理等 `Runner.Listener` 连 GitHub 所需的变量 | 需 root，走特权助手 |
| `dotenv` | `<runner 目录>/.env` | 仅 job/step 执行环境，由 runner 程序读取注入 | 不需要——文件属主就是 daemon 运行用户 |

两者都按「整表托管」处理：读回显 → 用户编辑 → 覆盖写回。变量名走白名单
（`^[A-Za-z_][A-Za-z0-9_]*$`），值禁止含换行。

## 仓库注册表与 CI 看板

`panel/data/RepoConfig/<owner@repo>.json` 记录哪些仓库被纳入管理，以及可选的 PAT 和备注。
它刻意**不**存「某仓库有哪些 runner」——那个问题靠扫描各节点回答，因为机器上大多数
runner 由 systemd 托管，压根不在任何实例表里。

CI 看板（`/api/ci`）用按仓库配置的 PAT 调 GitHub Actions API 拉 workflow 运行记录，
没配就回退到环境变量 `CIP_GITHUB_TOKEN`。公开仓库 PAT 可选（匿名 60 次/小时，带 token
5000 次/小时），私有仓库必须配。

## 磁盘上的数据

| 路径 | 内容 |
| ---- | ---- |
| `panel/data/User/` | 用户记录 |
| `panel/data/RemoteServiceConfig/` | 节点连接配置（地址、密钥、备注） |
| `panel/data/SystemConfig/` | 面板设置 |
| `panel/data/RepoConfig/` | 仓库注册表 |
| `panel/data/operation_logs/` | JSONL 审计日志 |
| `panel/data/layout.json` | 保存的卡片布局（未自定义前不存在） |
| `daemon/data/Config/` | daemon 配置，含认证密钥 |
| `daemon/data/InstanceConfig/` | 实例配置 |
| `daemon/data/InstanceData/` | 实例工作目录 |
| `daemon/data/InstanceLog/` | 终端日志 |
| `daemon/data/TaskConfig/` | 计划任务 |
| `daemon/data/runner-pkg/` | actions-runner 安装包（可用 `CIP_RUNNER_PKG` 覆盖） |

持久化一律是经 `StorageSubsystem` 写的普通 JSON 文件，没有数据库。Redis 仅作为可选的
会话/缓存后端。

### 环境变量

| 变量 | 读取方 | 用途 |
| ---- | ------ | ---- |
| `CIP_RUNNER_PKG` | daemon | actions-runner 安装包路径 |
| `CIP_RUNNER_PROXY` | daemon | runner 注册时的兜底代理 |
| `CIP_GITHUB_TOKEN` | panel | CI 看板的兜底 PAT |
| `CHOKIDAR_USEPOLLING` | 前端开发态 | inotify 上限低的机器上改用轮询 |

## 构建与部署

`./build.sh`（或 `build.bat`）按 `common` → `daemon` → `panel` → `frontend` 的顺序构建，
产物收拢到 `production-code/`：

```text
production-code/
├── daemon/app.js          + package.json、package-lock.json
└── web/app.js             + package.json、package-lock.json
    └── public/            构建好的前端
```

daemon 另需上游的两个二进制助手放在 `daemon/lib/`——`pty` 与压缩工具。`lib-urls.txt`
列了下载地址，`install-dependents.sh` / `.bat` 负责抓取。启动时 `checkDependencies()`
会在缺失时直接报错退出。

`prod-scripts/` 存放生产环境的安装与服务脚本，含部署时必须执行的 runner 特权配置，
见 `prod-scripts/README.md`。`dockerfile/` 用于构建面板与 daemon 的容器镜像。

## 国际化

12 种语言放在 `languages/*.json`，是扁平的 `TXT_CODE_*` 映射，被三个运行时包静态引入。
前端用单花括号的 `t()`，后端用双花括号的 `$t()`。12 个文件的键集完全一致，因此任何语言
都不会回退到别的语言才有的键。

`npm run i18n` 扫描新增的键；`npm run scan-useless-key` 报告已无引用的键。

## 与上游的差异

已从上游 MCSManager 移除，且不会回来：

- Minecraft 与游戏服支持：服务端 ping（Java + 基岩）、玩家数、Steam RCON、SteamCMD、
  MCDR、模组管理、Java 运行时管理、`server.properties`/yml/toml 配置编辑器，以及全部
  `minecraft/*`、`steam/*`、`hytale` 实例类型
- 应用市场及其快速安装任务
- 商业化/兑换码模式，以及 Pro 面板 iframe 桥
- 向上游的匿名使用统计上报

刻意保留：Apache-2.0 许可证与上游版权声明；持久化标识符 `__MCSM_GLOBAL_INSTANCE__`、
`{mcsm_*}` 命令占位符、Docker 标签 `mcsmanager.instance.uuid`；`mcsmanager-*` npm 包名；
以及 PTY / Zip-Tools 的下载地址。

实例、终端、文件管理、计划任务、Docker 这些子系统全部保留——runner 相关功能正是搭在
它们之上的。
