#!/usr/bin/env bash
# 一键启动 ci-panel 开发实例：预检 → 依赖 → 按需构建 → 启动 → 健康检查 → 打印后续操作。
#
# 重复运行安全：只重启真正被重新构建的服务，没动过的跳过。
# 前端不需要重启（vite 热重载），panel/daemon 改了源码必须重新构建 —— 它们跑的是
# webpack 产物 production/app.js，不是 ts 源码，这也是本脚本存在的主要理由。
#
# 用法：
#   bash dev.sh             预检 + 按需构建 + 启动
#   bash dev.sh --rebuild   强制全量重新构建
#   bash dev.sh --no-build  跳过构建，只把服务拉起来
#   bash dev.sh --no-deps   跳过 npm install 与二进制依赖下载
set -u

# shellcheck source=scripts/dev-lib.sh
source "$(cd "$(dirname "$0")" && pwd)/scripts/dev-lib.sh"

DO_BUILD=1 FORCE_BUILD=0 DO_DEPS=1
for arg in "$@"; do
  case "$arg" in
  --no-build) DO_BUILD=0 ;;
  --rebuild) FORCE_BUILD=1 ;;
  --no-deps) DO_DEPS=0 ;;
  -h | --help)
    sed -n '2,12p' "$0"
    exit 0
    ;;
  *)
    echo "未知参数：$arg（--help 看用法）" >&2
    exit 2
    ;;
  esac
done

die() {
  echo "[error] $*" >&2
  exit 1
}
step() { echo; echo "── $*"; }

cd "$CIP_ROOT" || die "进不去仓库根目录"
# 注意 dev_isolate_env 不在这里调：它会 unset 代理（daemon 连的是内网），而下面的
# 依赖步骤要 npm install、还要从 GitHub 下二进制，那些恰恰可能需要代理。
# 隔离只对被拉起的服务进程有意义，所以放到「启动」之前再调。

# ---- 1. 预检 ----

step "预检"
command -v node >/dev/null || die "找不到 node。DEVELOPMENT.md 要求 Node.js v16+"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 16 ] || die "Node.js 版本过低（当前 $(node -v)，需要 v16+）"
echo "node $(node -v) / npm $(npm -v)"

# ---- 2. 依赖 ----

# 二进制依赖：daemon 启动时 checkDependencies() 会硬性要求 file_zip，缺了直接抛异常退出。
# pty 决定仿真终端能不能用，7z 决定解压。文件名规则见 daemon/src/const.ts，
# 这里用 node 自己算，免得手写 uname → arch 的映射对不上。
fetch_lib() { # filename
  local name="$1" url sum
  sum="$(grep -m1 " $name\$" lib-checksums.txt | awk '{print $1}')"
  # 已存在的文件也要核对：只在缺失时下载的话，lib-checksums.txt 之后更新（换版本、
  # 或修一个错的校验和），跑过本脚本的机器会一直留着那个旧的、没核对过的二进制。
  if [ -f "daemon/lib/$name" ]; then
    if [ -n "$sum" ] && echo "$sum  daemon/lib/$name" | sha256sum -c - >/dev/null 2>&1; then
      return 0
    fi
    echo "[warn] daemon/lib/$name 与 lib-checksums.txt 不符（或无对应条目），重新下载"
  fi
  url="$(grep -m1 "/$name\$" lib-urls.txt)" ||
    { echo "[warn] lib-urls.txt 里没有 $name，请按 DEVELOPMENT.md 手动下载到 daemon/lib/"; return 0; }
  echo "下载 $name"
  curl -fsSL --max-time 120 -o "daemon/lib/$name" "$url" ||
    { rm -f "daemon/lib/$name"; die "下载 $name 失败（$url）"; }
  # 校验不过就删掉，绝不留一个来源不明的可执行文件在 lib 里。
  # 没有校验和条目同样算校验不过 —— 那说明 lib-urls.txt 和 lib-checksums.txt 已经漂移，
  # 这种时候更不该把一个没核对过的二进制 chmod +x 留在那里。
  [ -n "$sum" ] ||
    { rm -f "daemon/lib/$name"; die "lib-checksums.txt 里没有 $name 的校验和条目，已删除下载的文件"; }
  echo "$sum  daemon/lib/$name" | sha256sum -c - >/dev/null 2>&1 ||
    { rm -f "daemon/lib/$name"; die "$name 校验和不符，已删除"; }
  chmod +x "daemon/lib/$name"
}

if [ "$DO_DEPS" = 1 ]; then
  step "依赖"
  for pkg in common panel daemon frontend; do
    if [ ! -d "$pkg/node_modules" ]; then
      echo "npm install --prefix $pkg（首次，会比较久）"
      npm install --prefix "$pkg" >"$CIP_LOGDIR/npm-install-$pkg.log" 2>&1 ||
        die "npm install $pkg 失败，见 $CIP_LOGDIR/npm-install-$pkg.log"
    fi
  done
  mkdir -p daemon/lib
  read -r PLAT ARCH <<<"$(node -e 'const os=require("os");process.stdout.write(os.platform()+" "+os.arch())')"
  EXT=""
  [ "$PLAT" = "win32" ] && EXT=".exe"
  for tool in file_zip pty 7z; do fetch_lib "${tool}_${PLAT}_${ARCH}${EXT}"; done
  echo "依赖就绪（daemon/lib：$(ls daemon/lib 2>/dev/null | tr '\n' ' ')）"
fi

# ---- 3. 构建 ----

# src 里有比"上次构建"更新的文件就需要重新构建。panel/daemon 还依赖 common/dist 与
# languages/，所以那两处的改动也要算进来。
#
# 比较基准刻意用 .run 下的构建戳，而不是产物本身的 mtime：webpack 5 的
# output.compareBeforeEmit 默认为 true，产物内容没变化时它压根不重写文件，mtime 不动。
# 于是拿产物做基准会出现"改了一个不影响输出的地方之后，每次运行都重新构建"。
needs_build() { # artifact stamp srcdir...
  local art="$1" stamp="$2"
  shift 2
  [ "$FORCE_BUILD" = 1 ] && return 0
  [ -f "$art" ] || return 0   # 产物不存在，必须构建
  [ -f "$stamp" ] || return 0 # 没有构建戳（首次用本脚本），保守地构建一次
  local d
  for d in "$@"; do
    [ -e "$d" ] || continue
    [ -n "$(find "$d" -newer "$stamp" -print -quit 2>/dev/null)" ] && return 0
  done
  return 1
}

# 构建成功后落戳。必须在构建之后而不是之前：构建失败时戳不更新，下次仍会重试。
stamp_build() { touch "$CIP_LOGDIR/build-$1.stamp"; }

REBUILT_PANEL=0 REBUILT_DAEMON=0
if [ "$DO_BUILD" = 1 ]; then
  step "构建"
  # common 必须最先：panel / daemon / frontend 都消费它的产物，且四个包不是 npm workspace
  if needs_build "common/dist/index.js" "$CIP_LOGDIR/build-common.stamp" "common/src"; then
    echo "构建 common"
    npm run build --prefix common >"$CIP_LOGDIR/build-common.log" 2>&1 ||
      die "common 构建失败，见 $CIP_LOGDIR/build-common.log"
    stamp_build common
  fi
  if needs_build "panel/production/app.js" "$CIP_LOGDIR/build-panel.stamp" "panel/src" "common/dist" "languages"; then
    echo "构建 panel"
    npm run build --prefix panel >"$CIP_LOGDIR/build-panel.log" 2>&1 ||
      die "panel 构建失败，见 $CIP_LOGDIR/build-panel.log"
    stamp_build panel
    REBUILT_PANEL=1
  fi
  if needs_build "daemon/production/app.js" "$CIP_LOGDIR/build-daemon.stamp" "daemon/src" "common/dist" "languages"; then
    echo "构建 daemon"
    npm run build --prefix daemon >"$CIP_LOGDIR/build-daemon.log" 2>&1 ||
      die "daemon 构建失败，见 $CIP_LOGDIR/build-daemon.log"
    stamp_build daemon
    REBUILT_DAEMON=1
  fi
  [ "$REBUILT_PANEL$REBUILT_DAEMON" = "00" ] && echo "产物已是最新，跳过构建"
fi

# ---- 4. 启动 ----

step "启动"
dev_isolate_env # 从这里开始的子进程才需要隔离（独立扫描根 + 断开特权助手 + 不走代理）

# 配置压根不存在 = 首次启动，这时开发 daemon 必然没在跑，传空端口跳过"已在运行"检测直接起
# （端口真被占的话 daemon 自己会退出并在日志里说明）。但"配置存在却读不出合法端口"是另一
# 回事：那是异常状态，跳过检测意味着可能拉起第二个 daemon，直接拒绝，让人先去看配置。
DPORT=""
if [ -e "daemon/data/Config/global.json" ] || [ -L "daemon/data/Config/global.json" ]; then
  DPORT="$(daemon_port)" ||
    die "daemon/data/Config/global.json 存在但读不出合法端口，拒绝启动（先修配置，别盲目再起一个 daemon）"
fi

# 重新构建过就必须重启，否则跑的还是老产物 —— 这正是"改了后端没生效"最常见的原因。
# 必须等端口真的释放：固定 sleep 的话，进程没退干净时下面会打印「已在运行」跳过启动，
# 于是新构建的产物压根没跑起来，而这恰恰是本脚本要防的那个坑，还不带任何提示。
await_release() { # name port
  local name="$1" port="$2" left=15
  while [ "$left" -gt 0 ]; do
    port_up "$port" || return 0
    sleep 1
    left=$((left - 1))
  done
  die "$name 停止后 :$port 仍被占用，新构建的产物无法生效。手动检查：ss -tlnp | grep ':$port '"
}
if [ -n "$DPORT" ] && [ "$REBUILT_DAEMON" = 1 ] && port_up "$DPORT"; then
  stop_svc daemon "$DPORT"
  await_release daemon "$DPORT"
fi
if [ "$REBUILT_PANEL" = 1 ] && port_up 23333; then
  stop_svc panel 23333
  await_release panel 23333
fi

if [ -n "$DPORT" ] && port_up "$DPORT"; then
  echo "[skip] daemon 已在运行 (:$DPORT)"
else
  start_svc daemon "$DPORT" "$CIP_ROOT/daemon" node --enable-source-maps production/app.js
fi
if port_up 23333; then
  echo "[skip] panel 已在运行 (:23333)"
else
  start_svc panel 23333 "$CIP_ROOT/panel" node --enable-source-maps production/app.js
fi
if port_up 5173; then
  echo "[skip] frontend 已在运行 (:5173)"
else
  start_svc frontend 5173 "$CIP_ROOT/frontend" npm run dev
fi

# ---- 5. 健康检查 ----

step "健康检查"

# 首次启动时 daemon 还没写出配置，端口要等几秒才知道。等不到就跳过它的检查 ——
# 绝不回退到 24444：那个默认值可能是本机 systemd 托管的生产 daemon，猜错的话健康检查
# 会对着生产报「✓ daemon :24444」，而开发 daemon 其实根本没起来。
if [ -z "$DPORT" ]; then
  for _ in $(seq 15); do
    DPORT="$(daemon_port)" && break
    sleep 1
  done
fi

checks="panel:23333 frontend:5173"
if [ -n "$DPORT" ]; then
  checks="daemon:$DPORT $checks"
else
  echo "  ! daemon 端口未知（配置还没写出来），跳过它的健康检查 —— 见 $CIP_LOGDIR/daemon.log"
fi

fail=0
for svc in $checks; do
  name="${svc%%:*}" port="${svc##*:}"
  if wait_port "$port" 40; then
    echo "  ✓ $name :$port"
  else
    echo "  ✗ $name :$port 没起来 —— $CIP_LOGDIR/$name.log 末尾："
    tail -12 "$CIP_LOGDIR/$name.log" 2>/dev/null | sed 's/^/      /'
    fail=1
  fi
done
[ "$fail" = 0 ] || die "有服务未就绪，见上面的日志"

# 前端到后端的整条链路：vite 把 /api 代理到 panel，代理不通的话页面能开但一片空白
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:5173/api/auth/ 2>/dev/null)"
case "$code" in
403 | 200) echo "  ✓ vite → panel 代理正常（/api/auth/ → $code）" ;;
*) echo "  ! vite → panel 代理异常（/api/auth/ → ${code:-无响应}），检查 .run/frontend.log" ;;
esac

# ---- 6. 后续操作 ----

HAS_USER=0
[ -n "$(ls -A panel/data/User 2>/dev/null)" ] && HAS_USER=1
IPS="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | grep -v '^172\.17\.' | head -3)"

cat <<EOF

════════════════════════════════════════════════════════════
 开发实例已就绪
════════════════════════════════════════════════════════════

 访问地址（浏览器只需要能到 5173，/api 由 vite 在服务端转给 panel）
$(for ip in $IPS; do echo "   http://$ip:5173/"; done)
   http://127.0.0.1:5173/      （本机；远程访问用上面的地址，或 ssh -L 5173:127.0.0.1:5173）

 端口    frontend 5173 → panel 23333 → daemon ${DPORT:-未知（见 .run/daemon.log）}
 日志    .run/{frontend,panel,daemon}.log
 扫描根  .run/dev-runner-root
         已隔离：开发实例看不到本机任何真 runner，误操作也动不了生产

 后续操作
EOF

if [ "$HAS_USER" = 1 ]; then
  echo "  1. 浏览器打开上面任一地址，用你已有的管理员账户登录"
  echo "     注意：重启 panel 后需要重新登录 —— session 签名密钥每次启动随机生成"
else
  echo "  1. 浏览器打开上面任一地址，走安装向导创建管理员（当前还没有任何用户）"
fi

cat <<'EOF'
  2. 改前端代码  → vite 热重载，直接刷新页面
  3. 改后端代码  → bash dev.sh（自动重新构建 panel/daemon 并只重启它们）
  4. 停止全部    → bash stop-cipanel.sh
  5. 扫描根是空的，所以 runner 相关页面一开始没有数据。造一个假 runner 用来测：

       mkdir -p .run/dev-runner-root/my-runner
       cat > .run/dev-runner-root/my-runner/.runner <<'JSON'
       { "agentName": "my-runner", "gitHubUrl": "https://github.com/owner/repo" }
       JSON

     然后在面板里「导入 runner」扫描即可。假 runner 没有 systemd 服务，
     所以会显示「无人托管」，这是正常的 —— 纳管与托管是两个独立维度。
     清理：rm -rf .run/dev-runner-root/my-runner（导入过的话先在面板里取消纳管，
     否则 daemon 会留下一个指向已删目录的句柄实例）

EOF
