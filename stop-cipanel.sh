#!/usr/bin/env bash
# 停止 CI Panel 三件套
ROOT="$(cd "$(dirname "$0")" && pwd)"
LOGDIR="$ROOT/.run"

kill_port() { # name port
  local name="$1" port="$2"
  local pid
  pid="$( (ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | grep ":$port " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 )"
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null && echo "[stop] $name (pid $pid, :$port)"
  else
    echo "[skip] $name 未运行 (:$port)"
  fi
}

kill_port frontend 5173
kill_port panel    23333
kill_port daemon   24444
echo "已停止。"
