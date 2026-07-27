#!/usr/bin/env bash
# 一键启动 CI Panel 三件套：daemon + panel(23333) + frontend(vite 5173)
# 用法：bash start-cipanel.sh    （重复运行安全：已在跑的服务会跳过）
#
# 如果这台机器同时还是一个受面板管理的 runner 节点（systemd 的 ci-panel-daemon，
# 默认 24444），开发实例必须和它错开两样东西：
#   端口   —— 把 daemon/data/Config/global.json 的 port 改掉（比如 24445）即可，
#             本脚本从那里读，不写死
#   扫描根 —— 比端口要紧得多。两个 daemon 共用一个 runner 根，等于开发面板上误点一次
#             停止/删除，动的就是生产 runner。见下面 CIP_SCAN_ROOTS 的说明。
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
LOGDIR="$ROOT/.run"
mkdir -p "$LOGDIR"

# agent/后端连的是内网，别走代理
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY

# 可选：CI Job 看板要拉 GitHub 数据就配这两个（也可写到你的 shell profile）
export CIP_GITHUB_REPOS="${CIP_GITHUB_REPOS:-ChaoWao/simpler}"
# export CIP_GITHUB_TOKEN="ghp_xxx"

# 拉取 runner 安装包 / config.sh 注册的默认代理（直连 GitHub CDN 常被重置）。
# 前端表单没填代理时，daemon 用这个兜底。
export CIP_RUNNER_PROXY="${CIP_RUNNER_PROXY:-http://127.0.0.1:7892}"

# 把开发实例关进自己的扫描根。
# daemon 启动时会向特权助手要 ALLOWED_ROOT，拿到就覆盖 CIP_SCAN_ROOTS —— 那是刻意的
# (root 侧的边界才算数，见 prod-scripts/README.md)，但对开发实例来说恰恰不是我们要的。
# 把助手路径指向一个不存在的文件，preflight 自然失败，daemon 就老实回退用下面这个空目录。
# 这不算绕过安全边界：sudoers 只放行 /usr/local/sbin/ci-panel-runner-svc 这一条精确路径，
# 开发实例本来就没有能力去动真 runner，这里只是让它别再看见它们。
export CIP_RUNNER_SVC_HELPER="${CIP_RUNNER_SVC_HELPER:-/nonexistent/ci-panel-runner-svc}"
export CIP_SCAN_ROOTS="${CIP_SCAN_ROOTS:-$ROOT/.run/dev-runner-root}"
mkdir -p "$CIP_SCAN_ROOTS"

port_up() { (ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep -q ":$1 "; }

# daemon 端口以配置为准。写死的话，别人克隆下来配置还是默认 24444，
# 脚本却盯着另一个端口，就会以为没起来而重复拉起。
daemon_port() {
  node -e 'try {
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(c.port || 24444));
  } catch { process.stdout.write("24444"); }' "$ROOT/daemon/data/Config/global.json" 2>/dev/null || echo 24444
}

start_node() { # name port dir
  local name="$1" port="$2" dir="$3"
  if port_up "$port"; then
    echo "[skip] $name 已在运行 (:$port)"
    return
  fi
  # 重启时保留上一份日志（轮转为 .prev），避免覆盖丢失排障线索
  [ -f "$LOGDIR/$name.log" ] && mv -f "$LOGDIR/$name.log" "$LOGDIR/$name.log.prev"
  ( cd "$dir" && nohup node --enable-source-maps production/app.js > "$LOGDIR/$name.log" 2>&1 & echo $! > "$LOGDIR/$name.pid" )
  echo "[start] $name → :$port (pid $(cat "$LOGDIR/$name.pid"))"
}

# 1) daemon 与 panel（用已构建的 production/app.js；改了后端源码需先 npm run build）
start_node daemon "$(daemon_port)" "$ROOT/daemon"
start_node panel  23333 "$ROOT/panel"

# 2) frontend 开发服务器（vite，热重载）
if port_up 5173; then
  echo "[skip] frontend 已在运行 (:5173)"
else
  [ -f "$LOGDIR/frontend.log" ] && mv -f "$LOGDIR/frontend.log" "$LOGDIR/frontend.log.prev"
  ( cd "$ROOT/frontend" && nohup npm run dev > "$LOGDIR/frontend.log" 2>&1 & echo $! > "$LOGDIR/frontend.pid" )
  echo "[start] frontend → :5173 (pid $(cat "$LOGDIR/frontend.pid"))"
fi

echo
echo "全部拉起。日志在 $LOGDIR/*.log"
echo "本机验证：ssh -L 5173:127.0.0.1:5173 ci-runner@<服务器>  然后浏览器开 http://127.0.0.1:5173"
