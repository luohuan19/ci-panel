#!/usr/bin/env bash
# 只拉起 CI Panel 三件套：daemon + panel(23333) + frontend(vite 5173)。
# 用法：bash start-cipanel.sh    （重复运行安全：已在跑的服务会跳过）
#
# 不做预检、不构建、不做健康检查 —— 要那些请用 `bash dev.sh`（推荐的开发入口）。
# 本脚本保留下来是给"我知道产物是新的，只想把进程拉起来"的场合。
#
# 如果这台机器同时还是一个受面板管理的 runner 节点（systemd 的 ci-panel-daemon，
# 默认 24444），开发实例必须和它错开两样东西：
#   端口   —— 把 daemon/data/Config/global.json 的 port 改掉（比如 24445）即可，
#             本脚本从那里读，不写死
#   扫描根 —— 比端口要紧得多。两个 daemon 共用一个 runner 根，等于开发面板上误点一次
#             停止/删除，动的就是生产 runner。隔离逻辑见 scripts/dev-lib.sh 的
#             dev_isolate_env()
set -u

# shellcheck source=scripts/dev-lib.sh
source "$(cd "$(dirname "$0")" && pwd)/scripts/dev-lib.sh"

dev_isolate_env

# 1) daemon 与 panel（用已构建的 production/app.js；改了后端源码需先 npm run build）
# 配置压根不存在 = 首次启动，这时开发 daemon 必然没在跑，传空端口跳过"已在运行"检测
# 直接起（端口真被占的话 daemon 自己会退出并在日志里说明）。
#
# 但"配置存在却读不出合法端口"是另一回事：那是异常状态，不能一并当成首次启动 ——
# 跳过检测意味着可能拉起第二个 daemon。这种情况直接拒绝，让人先去看配置。
daemon_cfg="$CIP_ROOT/daemon/data/Config/global.json"
if [ -e "$daemon_cfg" ] || [ -L "$daemon_cfg" ]; then
  if ! dport="$(daemon_port)"; then
    echo "[error] $daemon_cfg 存在但读不出合法端口，拒绝启动（先修配置，别让它盲目再起一个 daemon）" >&2
    exit 1
  fi
else
  dport="" # 首次启动，还没有配置
fi

if [ -n "$dport" ] && port_up "$dport"; then
  echo "[skip] daemon 已在运行 (:$dport)"
else
  start_svc daemon "$dport" "$CIP_ROOT/daemon" node --enable-source-maps production/app.js
fi

if port_up 23333; then
  echo "[skip] panel 已在运行 (:23333)"
else
  start_svc panel 23333 "$CIP_ROOT/panel" node --enable-source-maps production/app.js
fi

# 2) frontend 开发服务器（vite，热重载）
if port_up 5173; then
  echo "[skip] frontend 已在运行 (:5173)"
else
  start_svc frontend 5173 "$CIP_ROOT/frontend" npm run dev
fi

echo
echo "全部拉起。日志在 $CIP_LOGDIR/*.log"
echo "本机验证：浏览器开 http://127.0.0.1:5173（远程用 ssh -L 5173:127.0.0.1:5173 转发）"
