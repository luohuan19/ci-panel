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
# 刻意不写成 ${VAR:-default}：调用者环境里若恰好有这两个变量（为别的用途 export 过，
# 或者从 profile 继承下来），就会把开发实例指回真 runner 根 —— 而这个脚本存在的意义
# 正是防止那件事。要让开发实例去管真 runner，请显式地另起，不要靠环境变量掀翻隔离。
export CIP_RUNNER_SVC_HELPER="/nonexistent/ci-panel-runner-svc"
export CIP_SCAN_ROOTS="$ROOT/.run/dev-runner-root"
mkdir -p "$CIP_SCAN_ROOTS"

port_up() { (ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep -q ":$1 "; }

# daemon 端口以配置为准，读不出来就返回非 0 让调用方决定 —— 绝不回退到 24444。
# 那个默认值恰恰是最危险的猜测：这台机器上 24444 很可能是 systemd 托管的生产节点，
# 猜错的后果是 stop 去杀生产、start 把生产误当成"开发实例已在运行"而跳过。
daemon_port() {
  local cfg="$ROOT/daemon/data/Config/global.json" port
  [ -f "$cfg" ] || return 1
  port="$(node -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (Number.isInteger(c.port) && c.port > 0 && c.port < 65536) process.stdout.write(String(c.port));
  ' "$cfg" 2>/dev/null)" || return 1
  [ -n "$port" ] || return 1
  printf '%s' "$port"
}

start_node() { # name port dir   （port 为空则跳过"已在运行"检测，见 daemon 的调用处）
  local name="$1" port="$2" dir="$3"
  if [ -n "$port" ] && port_up "$port"; then
    echo "[skip] $name 已在运行 (:$port)"
    return
  fi
  # 重启时保留上一份日志（轮转为 .prev），避免覆盖丢失排障线索
  [ -f "$LOGDIR/$name.log" ] && mv -f "$LOGDIR/$name.log" "$LOGDIR/$name.log.prev"
  ( cd "$dir" && nohup node --enable-source-maps production/app.js > "$LOGDIR/$name.log" 2>&1 & echo $! > "$LOGDIR/$name.pid" )
  echo "[start] $name → :$port (pid $(cat "$LOGDIR/$name.pid"))"
}

# 1) daemon 与 panel（用已构建的 production/app.js；改了后端源码需先 npm run build）
# 配置压根不存在 = 首次启动，这时开发 daemon 必然没在跑，传空端口跳过"已在运行"检测
# 直接起（端口真被占的话 daemon 自己会退出并在日志里说明）。
#
# 但"配置存在却读不出合法端口"是另一回事：那是异常状态，不能一并当成首次启动 ——
# 跳过检测意味着可能拉起第二个 daemon 并覆盖 PID 文件。这种情况直接拒绝，让人先去看配置。
daemon_cfg="$ROOT/daemon/data/Config/global.json"
if [ -e "$daemon_cfg" ] || [ -L "$daemon_cfg" ]; then
  if ! dport="$(daemon_port)"; then
    echo "[error] $daemon_cfg 存在但读不出合法端口，拒绝启动（先修配置，别让它盲目再起一个 daemon）" >&2
    exit 1
  fi
else
  dport="" # 首次启动，还没有配置
fi
start_node daemon "$dport" "$ROOT/daemon"
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
