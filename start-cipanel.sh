#!/usr/bin/env bash
# 一键启动 CI Panel 三件套：daemon(24444) + panel(23333) + frontend(vite 5173)
# 用法：bash start-cipanel.sh    （重复运行安全：已在跑的服务会跳过）
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

port_up() { (ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep -q ":$1 "; }

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
start_node daemon 24444 "$ROOT/daemon"
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
