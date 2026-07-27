#!/usr/bin/env bash
# 停止 CI Panel 三件套
ROOT="$(cd "$(dirname "$0")" && pwd)"
LOGDIR="$ROOT/.run"

# 和 start-cipanel.sh 一样从配置读端口，并且同样绝不回退到 24444：
# 这台机器上 24444 很可能是 systemd 托管的生产节点，猜错就是一条命令把线上停掉。
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
if dport="$(daemon_port)"; then
  kill_port daemon "$dport"
else
  echo "[skip] daemon 读不到端口配置，跳过（不拿 24444 去猜，那可能是生产节点）"
fi
echo "已停止。"
