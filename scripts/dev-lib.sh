#!/usr/bin/env bash
# 开发实例脚本的公用函数：dev.sh / start-cipanel.sh / stop-cipanel.sh 都 source 它。
# 抽出来的直接动因是 daemon_port() 原先在 start/stop 两处各有一份，加第三处就该合并了。
# 只提供函数与路径变量，不做任何副作用（不启动、不导出隔离变量），由调用方显式调用。

[ -n "${_CIP_DEV_LIB:-}" ] && return 0
_CIP_DEV_LIB=1

CIP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CIP_LOGDIR="$CIP_ROOT/.run"
mkdir -p "$CIP_LOGDIR"

# ---- 端口 ----

# 某端口是否已在 LISTEN
port_up() { (ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep -q ":$1 "; }

# 监听某端口的进程号。
# ss 与 netstat 的进程列格式不同（ss 是 users:(("node",pid=123,fd=21))，netstat 是 123/node），
# 两种都要认：只按 ss 的格式解析的话，没装 ss 的机器上会一直取不到 pid，
# stop_svc 于是谎报「未运行」，而端口其实还占着。
pid_on_port() {
  local line
  if line="$(ss -tlnp 2>/dev/null | grep ":$1 ")" && [ -n "$line" ]; then
    printf '%s' "$line" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2
    return 0
  fi
  line="$(netstat -tlnp 2>/dev/null | grep ":$1 ")" || return 0
  printf '%s' "$line" | grep -oE '[0-9]+/' | head -1 | tr -d '/'
}

# daemon 端口以配置为准，读不出来就返回非 0 让调用方决定 —— 绝不回退到 24444。
# 那个默认值恰恰是最危险的猜测：开发机同时是 CI 节点时，24444 很可能是 systemd 托管的
# 生产 daemon，猜错的后果是 stop 去杀生产、start 把生产误当成"开发实例已在运行"而跳过。
daemon_port() {
  local cfg="$CIP_ROOT/daemon/data/Config/global.json" port
  [ -f "$cfg" ] || return 1
  port="$(node -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (Number.isInteger(c.port) && c.port > 0 && c.port < 65536) process.stdout.write(String(c.port));
  ' "$cfg" 2>/dev/null)" || return 1
  [ -n "$port" ] || return 1
  printf '%s' "$port"
}

# 等端口进入 LISTEN，超时返回非 0。用于启动后的健康检查：
# 光"进程已 fork"不代表服务可用，端口起来了才算。
wait_port() { # port timeout_seconds
  local port="$1" left="${2:-30}"
  while [ "$left" -gt 0 ]; do
    port_up "$port" && return 0
    sleep 1
    left=$((left - 1))
  done
  return 1
}

# ---- 启动 ----

# 后台拉起一个服务。
#
# pid 记录方式是刻意这样写的。原先的 `( cd "$dir" && nohup node ... & echo $! > pid )`
# 把 & 作用在整个 `cd ... && nohup ...` 复合命令上，$! 拿到的不是 node 而是 bash 为这个
# AND-list 另起的中间进程，于是 pid 文件里存着一个很快就不存在的进程号 ——
# `kill $(cat .run/panel.pid)` 静默失败，紧接着的启动又因端口仍被占而报"已在运行"跳过，
# 看起来像重启成功了、实际跑的还是老进程。改成 cd 单独一句、只把真正的命令放到后台，
# $! 才是它自己。
#
# 另外给子进程补 </dev/null 并把子 shell 自身的输出也重定向掉：否则后台进程会继承脚本的
# stdout，`bash dev.sh | grep xxx` 这类用法拿不到 EOF 会一直挂着。
start_svc() { # name port dir cmd...
  local name="$1" port="$2" dir="$3"
  shift 3
  local log="$CIP_LOGDIR/$name.log" pidfile="$CIP_LOGDIR/$name.pid"
  [ -f "$log" ] && mv -f "$log" "$log.prev" # 保留上一份，别把排障线索覆盖掉
  rm -f "$pidfile"                          # 先清掉旧的，免得启动失败时读到上一次的进程号
  (
    cd "$dir" || exit 1
    nohup "$@" </dev/null >"$log" 2>&1 &
    echo $! >"$pidfile"
  ) >/dev/null 2>&1
  local pid
  pid="$(cat "$pidfile" 2>/dev/null)"
  if [ -z "$pid" ]; then
    echo "[error] $name 启动失败（进不去 $dir？）" >&2
    return 1
  fi
  echo "[start] $name → :${port:-?} (pid $pid)"
}

# 停一个服务。
#
# 只按端口找到进程就 kill 是不够的：23333 / 5173 是写死的端口，机器上完全可能是别的东西
# 占着，那就成了一条命令把无关服务停掉。所以要求端口上的进程与 start_svc 记下的 pid 一致，
# 对不上就保留并说明——现在 pid 文件记的是真进程了（见 start_svc），这个比对才有意义。
stop_svc() { # name port
  local name="$1" port="$2" pid recorded
  pid="$(pid_on_port "$port")"
  if [ -z "$pid" ]; then
    echo "[skip] $name 未运行 (:$port)"
    return 0
  fi
  recorded="$(cat "$CIP_LOGDIR/$name.pid" 2>/dev/null)"
  if [ -z "$recorded" ]; then
    echo "[skip] :$port 上的 pid $pid 不是本脚本启动的（没有 $CIP_LOGDIR/$name.pid 记录），不动它" >&2
    return 1
  fi
  if [ "$recorded" != "$pid" ]; then
    echo "[skip] :$port 被 pid $pid 占用，但记录的 $name 是 pid $recorded，不动它" >&2
    return 1
  fi
  kill "$pid" 2>/dev/null && echo "[stop] $name (pid $pid, :$port)"
}

# ---- 开发实例隔离 ----

# 把开发实例关进自己的扫描根，并断开它和特权助手的联系。
#
# daemon 启动时会向特权助手要 ALLOWED_ROOT，拿到就覆盖 CIP_SCAN_ROOTS —— 那是刻意的
# (root 侧的边界才算数，见 prod-scripts/README.md)，但对开发实例来说恰恰不是我们要的。
# 把助手路径指向一个不存在的文件，preflight 自然失败，daemon 就老实回退用下面这个空目录。
# 这不算绕过安全边界：sudoers 只放行 /usr/local/sbin/ci-panel-runner-svc 这一条精确路径，
# 开发实例本来就没有能力去动真 runner，这里只是让它别再看见它们。
#
# 刻意不写成 ${VAR:-default}：调用者环境里若恰好有这两个变量（为别的用途 export 过，
# 或者从 profile 继承下来），就会把开发实例指回真 runner 根 —— 而这套隔离存在的意义
# 正是防止那件事。要让开发实例去管真 runner，请显式地另起，不要靠环境变量掀翻隔离。
dev_isolate_env() {
  # agent/后端连的是内网，别走代理
  unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY

  # 可选：CI Job 看板要拉 GitHub 数据就配这两个（也可写到你的 shell profile）
  export CIP_GITHUB_REPOS="${CIP_GITHUB_REPOS:-ChaoWao/simpler}"
  # export CIP_GITHUB_TOKEN="ghp_xxx"

  # 拉取 runner 安装包 / config.sh 注册的默认代理（直连 GitHub CDN 常被重置）。
  # 前端表单没填代理时，daemon 用这个兜底。
  export CIP_RUNNER_PROXY="${CIP_RUNNER_PROXY:-http://127.0.0.1:7892}"

  export CIP_RUNNER_SVC_HELPER="/nonexistent/ci-panel-runner-svc"
  export CIP_SCAN_ROOTS="$CIP_ROOT/.run/dev-runner-root"
  mkdir -p "$CIP_SCAN_ROOTS"
}
