# prod-scripts

生产部署用的脚本与特权配置。

## 为什么需要特权配置

daemon 以非 root 用户运行（默认 `ci-runner`），但托管 runner 必须动 systemd：

| 动作 | 实现 | 触发点 |
| ---- | ---- | ------ |
| 装/卸 systemd 单元、写环境变量 drop-in | `sudo -n ci-panel-runner-svc <action>` | 创建 / 删除 runner、改环境变量 |
| 启停 runner | `sudo -n ci-panel-runner-svc start\|stop\|restart` | 面板上点启停 |

全部走同一个助手，**sudoers 里只有一条规则**、不含任何通配符。

两者都用 `sudo -n`（非交互）。**免密没配好时不会提示输密码，而是直接失败**——而且失败发生在
`config.sh` 已经把 runner 注册到 GitHub 之后，会在 GitHub 上留下一个永远不上线的 runner。
所以权限必须在部署期一次性配好并验证，不能等运行期发现。

## 部署

```bash
sudo bash prod-scripts/install-runner-privileges.sh
```

它做四件事，任何一步失败就中止并说明原因：

1. 把 `ci-panel-runner-svc` 装到 `/usr/local/sbin`（root 所有、0755、daemon 用户不可写），
   并把 `ALLOWED_ROOT` 写死成本次部署的根目录
2. 由 `.sudoers` 模板生成实际规则（替换用户名与助手路径），`visudo` 校验后落盘；同时移除
   历史遗留的 `/etc/sudoers.d/ci-panel-runner`（见下方「为什么启停也走助手」）
3. 确保根目录存在、属主是 daemon 用户
4. **端到端验证**：以 daemon 用户身份真跑一次 `sudo -n`，确认免密生效、助手是最新版、
   助手的 `ALLOWED_ROOT` 与部署参数一致

常用参数：

| 参数 | 默认 | 说明 |
| ---- | ---- | ---- |
| `--user <name>` | `$SUDO_USER` | daemon 的运行用户，也是 runner 目录属主和单元里的 `User=` |
| `--root <path>` | `/data/ci-runner` | runner 根目录。daemon 启动时自动从助手读取，无需另设 |
| `--check` | — | 只验证不修改，可随时重复跑 |

改过 `ci-panel-runner-svc` 之后要**重新跑一次**（不加 `--check`）才会生效——sudoers 不限制参数，
所以新增动作不用改 sudoers，但脚本本体必须重新部署。`--check` 会通过 `VERSION` 认出旧版本。

## 文件

| 文件 | 用途 |
| ---- | ---- |
| `install-runner-privileges.sh` | 部署入口：安装 + 验证（**唯一应该手动跑的**） |
| `ci-panel-runner-svc` | 特权小助手，root 执行；装/卸单元、写 drop-in 环境变量、`preflight` 自检 |
| `ci-panel-runner-install.sudoers` | 模板：唯一的一条白名单 → `/etc/sudoers.d/ci-panel-runner-install` |
| `linux/`、`windows/` | 上游 MCSManager 的启动脚本，与 runner 无关 |

## 权限边界

授权面只有一条规则，root 实际能做的事全部写在 `ci-panel-runner-svc` 里，并受这些约束：

- 助手 root 所有、daemon 用户不可写（否则等于把 root 直接送出去，部署脚本会检查）
- 只操作 `ALLOWED_ROOT` 下、且含 `.runner` 的目录
- 单元名必须匹配 `^actions\.runner\.[A-Za-z0-9._@-]+\.service$`，与 daemon 侧正则一致
- 绝不执行 runner 目录里的任何脚本（那里 daemon 用户可写）；unit 由助手自己的模板生成
- `set-env` 的载荷只当数据渲染进 `Environment=`，变量名走白名单、值转义

下列操作**不需要** sudo，不要往 sudoers 里加：读 `systemctl show` 状态、读 `override.conf`
（0644）、读写 runner 目录里的 `.env` / `_diag` 日志、解压安装包、跑 `config.sh` 注册。

### 为什么启停也走助手

早期版本单独放行了 `systemctl start|stop|restart actions.runner.*.service`。这条规则比看上去宽得多：
sudoers 的**命令参数通配符会匹配空白**，而 sudo 是把参数拼成一整串来比对的。`systemctl` 又接受多个
单元名，于是

```console
$ sudo -n /usr/bin/systemctl start actions.runner.probe.service 任意其它单元
Failed to start actions.runner.probe.service: Unit ... not found.
Failed to start 任意其它单元: Unit ... not found.
$ echo $?
5
```

退出码 5 来自 systemctl「找不到单元」，而不是 sudo 拒绝——说明 **sudo 已经放行了这条命令**。
同一个单元单独启动则会被拒（`sudo: a password is required`）。也就是说，一个 `actions.runner`
前缀就能把任意单元带上车。glob 排不掉空白，而 sudo 要到 1.9.10 才支持锚定正则（本机是 1.9.8）。

所以启停改由助手执行，单元名在 root 拥有的代码里用 `[[ =~ ]]` 做**整串**锚定校验（不用 `grep -E`：
它逐行匹配，输入含换行时 `^...$` 会匹配到其中一行而放行）。部署脚本会主动删除遗留的
`/etc/sudoers.d/ci-panel-runner`，并在验证阶段确认它确实不在了。

## 扫描根只有一处配置

助手的 `ALLOWED_ROOT` 是唯一真相源——它是 root 侧真正的边界，daemon 声明得再宽也没用，
只会把失败推迟到 runner 已经注册到 GitHub 之后。所以 daemon 启动时调一次
`ci-panel-runner-svc preflight` 把它读回来，用作自己的扫描根：

```text
[runner-scan] 扫描根取自特权助手(v2): /data/ci-runner
```

改扫描根**只需**跑 `install-runner-privileges.sh --root <路径>` 然后重启 daemon。

`CIP_SCAN_ROOTS` 退化为回退值，只在拿不到助手时生效（开发机没装助手、没配免密）。
两边不一致时以助手为准并打 warn。

## 扩容到新服务器

ci-panel 是「一个 panel + 多个 daemon 节点」的结构，所以加机器是**加节点**，不是搬家：
panel 和已有 runner 全程不用动。

### 先明确不能拷贝的东西

| 东西 | 为什么 |
| ---- | ------ |
| runner 目录 | `.runner` / `.credentials` 是注册到 GitHub 的凭据，对应 GitHub 侧一个具体 runner 实体。两台机器用同一份身份会抢同一个 runner。**在新机器上重新创建，旧机器上注销。** |
| systemd unit | `ExecStart` / `WorkingDirectory` / `User=` 都是 install 时按实际目录和属主生成的快照，换机后全不对。走助手重新生成即可。 |
| `daemon/data/Config/global.json` | 里面的 `key` 是该节点的身份。新机器首次启动会自己生成一份，拷过去反而会和旧节点撞车。 |

### 步骤

1. **装依赖并构建**。新机器需要 node（与现有节点同一大版本，当前 v20）。四个包不是 npm
   workspace，各自 `npm install` 再 `npm run build`；只跑 runner 的话 `daemon/` 是必需的。

2. **配特权**（本文档前半部分的全部内容，一条命令）：

   ```bash
   sudo bash prod-scripts/install-runner-privileges.sh --root <新机器的 runner 根目录>
   ```

   跑通即代表这台机器的 systemd 托管能力就绪。`--root` 只在这里说一次，daemon 会自己读回去。

3. **放 runner 安装包**。拷到新机器的 `daemon/data/runner-pkg/`：

   ```bash
   scp daemon/data/runner-pkg/actions-runner-linux-<arch>-*.tar.gz <新机器>:<路径>/daemon/data/runner-pkg/
   ```

   **架构必须匹配**：daemon 按 `process.arch` 找 `actions-runner-linux-{arm64|x64}-*.tar.gz`，
   拿版本号最高的那个。arm64 的包在 x64 机器上解压出来跑不了，反之亦然。不拷的话 daemon
   会现场下载（约 130MB，走代理很慢）。

4. **启动 daemon**，记下它生成的密钥：

   ```bash
   bash start-cipanel.sh                      # 或只起 daemon
   grep -o '"key":"[^"]*"' daemon/data/Config/global.json
   ```

5. **在 panel 里添加节点**：填新机器的 IP、daemon 端口（默认 `24444`）、上一步的密钥。

6. **在新节点上创建 runner**（面板正常流程）。此时基目录选择器只会让你在第 2 步定的
   根目录下浏览。

### 容易踩的地方

- **防火墙**：panel 要能连到新机器的 daemon 端口（默认 24444）。这是节点连不上的头号原因。
- **IP 白名单**：daemon 的 `whiteListPanelIp` 默认 `false`（不限制）。若你开过它，新增
  panel 出口 IP 到 `whiteListPanelIps`，否则认证会被拒（见 `daemon/src/routers/auth_router.ts`）。
- **代理**：拉 runner 安装包和 `config.sh` 注册都要连 GitHub。新机器上设 `CIP_RUNNER_PROXY`，
  或在创建表单里逐次填。
- **runner 根目录属主**：必须是 daemon 的运行用户。第 2 步会创建并 chown，但如果目录是你
  事先手工建的，自己确认一下属主。
