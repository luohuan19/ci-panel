# 部署与更新

面向运维：把 ci-panel 装到一台新机器上，以及后续怎么更新、怎么回滚。
开发环境搭建见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 结构与前提

ci-panel 是 **一个 panel + 多个 daemon 节点**。加机器就是加节点，panel 和已有 runner
全程不用动。所以最常见的操作是 `--role daemon`。

一个发布包同时含 x64 与 arm64 的二进制，一个包通用。四个 npm 包里没有原生模块，
按架构分文件的只有 `daemon/lib/` 下的 pty / 7z / file_zip，运行时自己挑。

目标机需要：

| 项 | 说明 |
| --- | --- |
| Linux + systemd | 装的是 systemd 单元；daemon 托管 runner 也依赖 systemd |
| node ≥ 20 | 没有就加 `--install-node`，脚本会把官方运行时放到 `<root>/runtime/` |
| root | 要装单元、配 sudoers 白名单 |
| 防火墙放开 daemon 端口 | 默认 24444，**节点连不上最常见的原因就是这个** |

## 发版（维护者）

打一个 `cip-v*` 的 tag，[release workflow](.github/workflows/release.yml) 会构建、
smoke-test、然后发布 Release：

```bash
git tag cip-v1.0.0 && git push origin cip-v1.0.0
```

前缀是 `cip-v` 而不是裸的 `v`——仓库里有一百多个从上游 MCSManager 继承的 `v9.x`/`v10.x`
tag，共用命名空间会让版本语义混乱。也可以在 Actions 页面手动触发（`workflow_dispatch`）。

本地打包（内网发布、或想先验证）：

```bash
bash scripts/release/pack.sh 1.0.0
bash scripts/release/smoke-test.sh dist-release/ci-panel-1.0.0-linux.tar.gz
```

`pack.sh` 不会影响本机在跑的服务：`build.sh` 会把 `daemon/production/app.js` 移走，
脚本退出前会把**打包前那一份**原样放回。

## 装一个 runner 节点

### 1. 取包

```bash
TAG=$(curl -fsSL https://api.github.com/repos/luohuan19/ci-panel/releases/latest \
      | grep -o '"tag_name": *"[^"]*"' | cut -d'"' -f4)
VER=${TAG#cip-v}
curl -fLO "https://github.com/luohuan19/ci-panel/releases/download/$TAG/ci-panel-$VER-linux.tar.gz"
curl -fLO "https://github.com/luohuan19/ci-panel/releases/download/$TAG/ci-panel-$VER-linux.tar.gz.sha256"
sha256sum -c "ci-panel-$VER-linux.tar.gz.sha256"
tar xzf "ci-panel-$VER-linux.tar.gz" && cd "ci-panel-$VER"
```

### 2. 安装

```bash
sudo bash install.sh --scan-root /data/ci-runner
```

常用参数（全部见 `bash install.sh --help`）：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--scan-root <path>` | `/data/ci-runner` | runner 根目录，写进特权助手的 `ALLOWED_ROOT` |
| `--user <name>` | `ci-runner` | daemon 运行用户，也是 runner 目录属主；不存在会问你是否创建 |
| `--root <path>` | `/opt/ci-panel` | 安装根目录 |
| `--daemon-port <n>` | `24444` | 只在首次安装写入配置 |
| `--runner-pkg <path>` | — | 预置 GitHub runner 安装包，省掉首次创建时现场下载约 130MB |
| `--install-node` | — | 没有 node ≥ 20 时下载官方运行时 |
| `--role all` | `daemon` | 同机再装一套 web 面板 |
| `--yes` | — | 不做交互确认 |

脚本做完这些事：解包到 `releases/<版本>/`、把 `data`/`logs`/`tmp` 软链到 `shared/`、
写初始配置、跑 [prod-scripts/install-runner-privileges.sh](prod-scripts/README.md)
配好 sudo 白名单、装 systemd 单元、切 `current` 软链、启动并探活。

**重复运行是安全的**：`shared/` 里的数据、daemon 的身份密钥、`.env` 里已有的值都不会被覆盖。

### 3. 在面板里添加节点

装完会直接打印接入信息：

```
在面板里添加这个节点：
  地址   10.x.x.x
  端口   24444
  密钥   <该节点的准入凭据>
```

拿这三个值在面板的节点页面添加即可。密钥等同凭据，只填到面板里。之后随时可以
`sudo ci-panel-ctl node-key` 再看一次。

**不要跨机器拷贝 `daemon/data/Config/global.json`**——里面的 `key` 是这个节点的身份，
两台机器用同一份会互相顶掉。新机器首次启动会自己生成。

## 更新与回滚

```bash
ci-panel-ctl check                  # 当前版本 vs 最新版本
sudo ci-panel-ctl update            # 更新到 latest release
sudo ci-panel-ctl update --version 1.1.0
sudo ci-panel-ctl update --file ./ci-panel-1.1.0-linux.tar.gz   # 离线
sudo ci-panel-ctl rollback          # 切回上一个版本
```

更新是这样保证安全的：

1. 新版本先完整铺到 `releases/<新版本>/`，此时线上还跑着旧的
2. 数据不动——`data`/`logs`/`tmp` 都是指向 `shared/` 的软链
3. 升级前把 `shared/*/data` 备份到 `backups/<时间戳>/`（跳过 `InstanceData`、`runner-pkg` 这类大目录）
4. 切换只是把 `current` 软链原子替换掉
5. 切完重启并探活，**起不来就自动切回旧版本**并以非零退出
6. 最后单独处理特权助手——它装在 `/usr/local/sbin/`，不在 `releases/` 下，切软链带不动它。
   更新会比对助手版本，落后就重装一遍；`ALLOWED_ROOT` 从助手自己的 `preflight` 读回来，
   不用你重传 `--scan-root`

第 6 步失败不会触发回滚：服务本身是好的，只是 runner 管理能力没跟上，脚本会把手动
补救的命令打出来。

**更新不需要重传安装时的参数**。它不"记住"参数，而是从已安装状态反推：`--role` 看装了
哪些 systemd 单元，`--user` 和 node 路径从单元的 `User=` / `ExecStart=` 读，端口在
`shared/daemon/data/Config/global.json`，代理和仓库列表在 `.env`，`--scan-root` 由特权
助手自己保管。这样就算有人装完之后手工改过配置，更新也不会拿旧参数把改动覆盖掉。
唯一例外是 `--root`：直接跑 `bash update.sh` 时默认 `/opt/ci-panel`，装在别处要显式传——
用 `ci-panel-ctl` 则不用管，它记着安装时的根目录。

**对正在跑的 CI job 没有影响**：runner 跑在自己的 `actions.runner.*.service` 单元里，
有独立 cgroup，不是 daemon 的子进程。但**正在进行的 runner 创建/删除会被打断**——
那个流程中途会把 runner 注册到 GitHub，中断可能在 GitHub 上留下一个不上线的 runner。

多节点逐台更新即可。panel 的节点列表会用 `daemonVersion` 比对各节点上报的版本，
落后的节点会亮黄色标记，据此判断哪些还没升。

## 目录布局

```
/opt/ci-panel/
├── releases/<版本>/        每个版本一份；其中 data/logs/tmp 是指向 shared 的软链
├── current -> releases/…   systemd 的 WorkingDirectory 指着它，回滚就是切它
├── shared/daemon/data      节点身份、runner 安装包、实例数据 —— 数据唯一真相源
├── shared/daemon/logs      daemon 自己写的日志（current.log）
├── shared/web/…            --role all 时才有
├── backups/<时间戳>/       更新前的数据快照
├── runtime/                --install-node 下载的 node
└── .env                    CIP_* 环境变量，600 root:root
```

数据必须放在 `shared/` 而不是跟着 release 走，是因为 panel 和 daemon 的数据路径全部基于
`process.cwd()` 拼出来（`daemon/src/service/system_file.ts`、
`panel/src/app/common/storage/jsonl_storage.ts`）。换 release 目录升级会把用户、
节点表和 daemon 身份一起留在旧目录里。

## 环境变量（`.env`）

两组变量的归属不同，**只装了 daemon 的机器上，panel 那组没有进程会读**：

| 变量 | 谁读 | 作用 |
| --- | --- | --- |
| `CIP_RUNNER_PROXY` | daemon | 拉 runner 安装包和跑 `config.sh` 注册时的代理兜底；前端表单填了就用表单的 |
| `CIP_GITHUB_REPOS` | panel | CI Job 看板的仓库列表。**只在面板仓库列表为空时导入一次**，之后由面板 UI 管理 |
| `CIP_GITHUB_TOKEN` | panel | 各仓库没配专用 PAT 时的全局兜底 |

改完要 `sudo ci-panel-ctl restart` 才生效。这个文件是 600 root:root，但终究是明文，
不要复制到别处。

## 离线 / 内网部署

目标机连不上 GitHub 时：

```bash
# 有网的机器上打包（或从 Release 下载），然后拷过去
scp ci-panel-1.0.0-linux.tar.gz* 目标机:~/
# 目标机上
tar xzf ci-panel-1.0.0-linux.tar.gz && cd ci-panel-1.0.0
sudo bash install.sh --scan-root /data/ci-runner \
     --runner-pkg ~/actions-runner-linux-arm64-2.331.0.tar.gz
```

包里已经含全部生产依赖（`node_modules` 打包在内），装的时候不碰 npm registry。
后续更新用 `sudo ci-panel-ctl update --file <新包>`。

`--runner-pkg` 的**架构必须和目标机一致**（脚本会校验文件名里的 `linux-<arch>`），
arm64 的包在 x64 上解出来跑不了。不给这个参数的话，首次创建 runner 时 daemon 会现场下载。

## 排障

| 现象 | 先查这里 |
| --- | --- |
| 面板里节点连不上 | 防火墙有没有放开 daemon 端口；`ci-panel-ctl status` 看服务是否 active |
| daemon 起不来 | `ci-panel-ctl logs`（systemd 日志）与 `ci-panel-ctl applog`（应用日志） |
| 安装时报"用户 X 跑不了 node" | 那个 node 装在别的用户 home 里；换系统级 node，或加 `--install-node` |
| 创建 runner 失败，GitHub 上留下不上线的 runner | 特权没配好：`sudo bash <root>/current/prod-scripts/install-runner-privileges.sh --check` |
| 拉 runner 安装包很慢或失败 | `.env` 里设 `CIP_RUNNER_PROXY`，或用 `--runner-pkg` 预置 |
| 更新后服务异常 | `sudo ci-panel-ctl rollback`；数据快照在 `backups/` |

`ci-panel-ctl` 的完整命令见 `ci-panel-ctl --help`。特权助手的授权边界、为什么启停也要走
助手，见 [prod-scripts/README.md](prod-scripts/README.md)。
