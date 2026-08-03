#!/usr/bin/env bash
# 停止 CI Panel 三件套
set -u

# shellcheck source=scripts/dev-lib.sh
source "$(cd "$(dirname "$0")" && pwd)/scripts/dev-lib.sh"

# 按端口找进程（stop_svc / pid_on_port 见 scripts/dev-lib.sh）。
# daemon 端口从配置读，并且绝不回退到 24444：这台机器上 24444 很可能是 systemd 托管的
# 生产节点，猜错就是一条命令把线上停掉。
stop_svc frontend 5173
stop_svc panel 23333
if dport="$(daemon_port)"; then
  stop_svc daemon "$dport"
else
  echo "[skip] daemon 读不到端口配置，跳过（不拿 24444 去猜，那可能是生产节点）"
fi
echo "已停止。"
