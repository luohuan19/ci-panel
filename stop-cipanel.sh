#!/usr/bin/env bash
# 停止 CI Panel 三件套
ROOT="$(cd "$(dirname "$0")" && pwd)"
LOGDIR="$ROOT/.run"

# 和 start-cipanel.sh 一样从配置读端口。写死会有真实后果：这台机器上若还跑着
# systemd 托管的生产 daemon(24444)，端口写错就是一条命令把线上节点停掉。
daemon_port() {
  node -e 'try {
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(c.port || 24444));
  } catch { process.stdout.write("24444"); }' "$ROOT/daemon/data/Config/global.json" 2>/dev/null || echo 24444
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
kill_port daemon   "$(daemon_port)"
echo "已停止。"
