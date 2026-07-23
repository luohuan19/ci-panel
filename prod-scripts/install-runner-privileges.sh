#!/usr/bin/env bash
# CI Panel：一次性部署 runner 托管所需的全部特权配置，并端到端验证它真的生效。
#
# 为什么要这个脚本：daemon 以非 root 用户跑，装/卸/启停 systemd 单元全靠 sudo -n(免密)。
# 免密没配好时，创建 runner 会走到「解压 → config.sh 注册到 GitHub」之后才失败，
# 在 GitHub 上留下一个永远不上线的 runner。所以权限必须在部署期保证，而不是运行期发现。
#
# 用法（需 root）：
#   sudo bash prod-scripts/install-runner-privileges.sh
#   sudo bash prod-scripts/install-runner-privileges.sh --user ci-runner --root /data/ci-runner
#   sudo bash prod-scripts/install-runner-privileges.sh --check    # 只校验，不改任何东西
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RUN_USER="${SUDO_USER:-ci-runner}" # daemon 的运行用户 = runner 目录属主 = 单元里的 User=
ALLOWED_ROOT="/data/ci-runner"     # 写进助手脚本；daemon 启动时会调 preflight 读回去当扫描根
ROOT_EXPLICIT=0                    # 是否显式传了 --root（--check 时决定拿什么跟助手比对）
HELPER_DEST="/usr/local/sbin/ci-panel-runner-svc"
SYSTEMCTL=""
CHECK_ONLY=0

SUDOERS_HELPER="/etc/sudoers.d/ci-panel-runner-install" # 助手一条，这是唯一的规则
# 旧的启停白名单。它用 `systemctl start actions.runner.*.service` 这种带通配符的规则，而 sudoers
# 的参数通配符会匹配空白、且 sudo 把参数拼成一整串比对，于是加个 actions.runner 前缀就能把任意
# 单元一起启动。启停已改走助手校验，所以这个文件必须从机器上删掉，不能只是不再安装。
SUDOERS_SVC_LEGACY="/etc/sudoers.d/ci-panel-runner"
# 探针单元：只用来验证授权链路打通，故意取一个不可能存在的名字（systemctl 会以
# "Unit not found" 失败，不产生任何副作用）。名字仍需通过助手的 SERVICE_RE 校验。
PROBE_UNIT="actions.runner.cipanel-preflight-probe.service"

if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; RESET=""
fi
ok()   { echo "${GREEN}[ok]${RESET}   $*"; }
warn() { echo "${YELLOW}[warn]${RESET} $*"; }
die()  { echo "${RED}[fail]${RESET} $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --user)       RUN_USER="${2:?--user 需要参数}"; shift 2 ;;
    --root)       ALLOWED_ROOT="${2:?--root 需要参数}"; ROOT_EXPLICIT=1; shift 2 ;;
    --helper)     HELPER_DEST="${2:?--helper 需要参数}"; shift 2 ;;
    --systemctl)  SYSTEMCTL="${2:?--systemctl 需要参数}"; shift 2 ;;
    --check)      CHECK_ONLY=1; shift ;;
    -h|--help)    sed -n '2,11p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)            die "未知参数: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "需要 root 运行：sudo bash $0 $*"

# ---- 1) 前置条件 ----
id "$RUN_USER" >/dev/null 2>&1 || die "用户不存在: $RUN_USER（用 --user 指定 daemon 的运行用户）"
[ "$RUN_USER" != "root" ] || die "daemon 不应以 root 运行；本套设计的前提就是它是普通用户"

if [ -z "$SYSTEMCTL" ]; then
  SYSTEMCTL="$(command -v systemctl || true)"
fi
[ -n "$SYSTEMCTL" ] && [ -x "$SYSTEMCTL" ] || die "找不到 systemctl（用 --systemctl 指定绝对路径）"
# sudoers 里必须是绝对真实路径：写成裸命令名会让 sudo 按 PATH 解析，等于把提权面交给环境变量
SYSTEMCTL="$(readlink -f "$SYSTEMCTL")"

command -v visudo >/dev/null 2>&1 || die "找不到 visudo，无法校验 sudoers 语法"

ALLOWED_ROOT="$(readlink -m "$ALLOWED_ROOT")"
case "$ALLOWED_ROOT" in
  /|/usr|/etc|/var|/home) die "根目录太宽: $ALLOWED_ROOT" ;;
esac

# 以目标用户身份跑一条命令（合并 stderr，供后面判定 sudo 是不是拒绝了我们）
as_user() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$RUN_USER" -- "$@" 2>&1
  else
    su -s /bin/bash -c "$(printf '%q ' "$@")" "$RUN_USER" 2>&1
  fi
}

# ---- 2) 安装（--check 时整段跳过）----
if [ "$CHECK_ONLY" -eq 0 ]; then
  src_helper="$SRC_DIR/ci-panel-runner-svc"
  [ -f "$src_helper" ] || die "找不到助手脚本源文件: $src_helper"

  # 根目录：daemon 要在这里建 runner 目录，必须存在且属于它
  if [ ! -d "$ALLOWED_ROOT" ]; then
    install -d -m 0755 -o "$RUN_USER" -g "$(id -gn "$RUN_USER")" "$ALLOWED_ROOT"
    ok "创建根目录 $ALLOWED_ROOT（属主 $RUN_USER）"
  fi

  # 助手脚本：装成 root 所有、目标用户不可写。ALLOWED_ROOT 在安装时写死进去——
  # 不从外部配置文件读，是为了不给攻击者多一个「改配置就能扩大操作范围」的面。
  tmp_helper="$(mktemp)"
  sed "s|^ALLOWED_ROOT=.*|ALLOWED_ROOT=\"$ALLOWED_ROOT\" # 由 install-runner-privileges.sh 写入|" \
    "$src_helper" > "$tmp_helper"
  grep -q "^ALLOWED_ROOT=\"$ALLOWED_ROOT\"" "$tmp_helper" || die "写入 ALLOWED_ROOT 失败（助手脚本格式变了？）"
  bash -n "$tmp_helper" || die "助手脚本语法错误，拒绝安装"
  install -m 0755 -o root -g root "$tmp_helper" "$HELPER_DEST"
  rm -f "$tmp_helper"
  ok "安装助手脚本 $HELPER_DEST (root:root 0755, ALLOWED_ROOT=$ALLOWED_ROOT)"

  # sudoers：把模板里的用户名/路径替换成实际值，visudo 校验通过后才落盘。
  # 先写临时文件再 install，避免半截文件出现在 /etc/sudoers.d 里把 sudo 整个搞坏。
  # 落盘前先备份既有文件：一个坏掉的 /etc/sudoers.d 会让整台机器的 sudo 不可用，
  # 所以最后的整体 visudo -c 若失败，必须能原样退回去。
  BACKUP_DIR="$(mktemp -d)"
  SUDOERS_TOUCHED=() # 只记「本次真的动过的」文件；没动过的绝不能在回滚时被删掉
  SUDOERS_DONE=0

  restore_sudoers() {
    local f base
    # set -u 下空数组要用 ${a[@]+"${a[@]}"} 展开，否则 bash <4.4 会报未绑定变量
    for f in ${SUDOERS_TOUCHED[@]+"${SUDOERS_TOUCHED[@]}"}; do
      base="$(basename "$f")"
      if [ -f "$BACKUP_DIR/$base" ]; then
        install -m 0440 -o root -g root "$BACKUP_DIR/$base" "$f"
      else
        rm -f "$f" # 有记录但无备份 = 本次新建的，删掉
      fi
    done
  }

  # 任何一步失败(die/set -e)都要回滚，而不只是最后那次整体校验失败时。否则第二个
  # install_sudoers 失败会让第一条规则残留在机器上，处于「装了一半」的状态。
  cleanup_sudoers() {
    local rc=$?
    if [ "$SUDOERS_DONE" -eq 0 ]; then
      restore_sudoers
      echo "${YELLOW}[warn]${RESET} sudoers 已回滚到部署前的状态" >&2
    fi
    rm -rf "$BACKUP_DIR"
    return $rc
  }
  trap cleanup_sudoers EXIT

  # 在改动某个 sudoers 文件「之前」调用：登记它、并备份既有内容。必须先登记再改，
  # 这样回滚只会碰我们真的动过的文件——早期版本无条件遍历一个固定列表，会把根本没
  # 走到那一步、原封未动的文件也删掉。
  mark_touched() {
    SUDOERS_TOUCHED+=("$1")
    if [ -f "$1" ]; then cp -p "$1" "$BACKUP_DIR/$(basename "$1")"; fi
  }

  install_sudoers() { # src dest
    local src="$1" dest="$2" tmp
    [ -f "$src" ] || die "找不到 sudoers 模板: $src"
    mark_touched "$dest"
    tmp="$(mktemp)"
    sed -e "s|^ci-runner\([[:space:]]\)|$RUN_USER\1|" \
        -e "s|/usr/local/sbin/ci-panel-runner-svc|$HELPER_DEST|g" \
        "$src" > "$tmp"
    chmod 0440 "$tmp"
    visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; die "生成的 sudoers 语法错误: $src"; }
    install -m 0440 -o root -g root "$tmp" "$dest"
    rm -f "$tmp"
    ok "安装 $dest"
  }
  install_sudoers "$SRC_DIR/ci-panel-runner-install.sudoers" "$SUDOERS_HELPER"

  # 删掉旧的启停白名单：它放行的是带通配符的 systemctl，等于允许启动任意单元(见文件顶部说明)。
  # 启停现在走助手校验，所以这条规则不再需要，留着就是个洞。
  if [ -f "$SUDOERS_SVC_LEGACY" ]; then
    mark_touched "$SUDOERS_SVC_LEGACY"
    rm -f "$SUDOERS_SVC_LEGACY"
    ok "移除旧的启停白名单 $SUDOERS_SVC_LEGACY（通配符可放行任意单元，已由助手取代）"
  fi

  # 整体校验：单文件都合法但合起来出问题（重复定义等）也要拦住。
  visudo -c >/dev/null || die "整体 sudoers 校验失败"
  SUDOERS_DONE=1
fi

# ---- 3) 端到端验证。这一段才是「部署期保证」的真正含义 ----
echo
echo "== 验证 =="

# 3a) 助手脚本必须 root 所有且目标用户不可写，否则等于把 root 直接送出去
[ -x "$HELPER_DEST" ] || die "助手脚本不存在或不可执行: $HELPER_DEST"
helper_meta="$(stat -c '%U %a' "$HELPER_DEST")"
[ "${helper_meta%% *}" = "root" ] || die "$HELPER_DEST 属主不是 root（当前 ${helper_meta%% *}）"
# stat %a 可能是 755 也可能是 04755（带 setuid），统一取后三位，再单独看 group/other 两位
helper_mode="$(printf '%03d' "$((10#${helper_meta##* } % 1000))")"
case "${helper_mode:1:1}${helper_mode:2:1}" in
  *[2367]*) die "$HELPER_DEST 组/其他可写（mode=$helper_mode）——非 root 用户能改写它就等于拿到 root" ;;
esac
if as_user test -w "$HELPER_DEST"; then die "$RUN_USER 可写 $HELPER_DEST——这是提权口子"; fi
ok "助手脚本权限正确（$helper_meta，$RUN_USER 不可写）"

# 3b) 助手那条免密规则：走 preflight 真实调用一次（无副作用），顺带核对版本与根目录。
#     不用 `sudo -l` 探测——若该用户还有 (ALL) ALL 之类的兜底规则，sudo -l 会对任意命令
#     都返回成功，给出假阳性。只有真跑一次才作数。
pre_out="$(as_user sudo -n "$HELPER_DEST" preflight || true)"
# 先区分「sudo 不放行」和「助手自己报错」，否则装了旧版脚本会被误报成免密没配
if echo "$pre_out" | grep -Eqi 'password is required|not allowed to execute|^sudo:'; then
  die "免密调用助手被 sudo 拒绝，检查 $SUDOERS_HELPER：
$pre_out"
fi
echo "$pre_out" | grep -q '^ok$' || \
  die "助手不认识 preflight——机器上装的是旧版脚本。重跑本脚本(不加 --check)以更新：
$pre_out"
helper_root="$(echo "$pre_out" | sed -n 's/^allowed_root=//p')"
helper_ver="$(echo "$pre_out" | sed -n 's/^version=//p')"
ok "免密调用助手成功（version=$helper_ver, allowed_root=$helper_root）"

# 只在「装过一遍」或「显式传了 --root」时才比对。否则单跑 --check 会拿默认 /data/ci-runner
# 去和一个用 --root /custom 装出来的助手比，必然失败——那是脚本的错，不是部署的错。
if [ "$CHECK_ONLY" -eq 0 ] || [ "$ROOT_EXPLICIT" -eq 1 ]; then
  [ "$helper_root" = "$ALLOWED_ROOT" ] ||
    die "助手的 ALLOWED_ROOT($helper_root) 与本次部署的根目录($ALLOWED_ROOT) 不一致——重跑本脚本不加 --check"
else
  # --check 且没传 --root：以助手为准，后续的根目录检查都用它
  ALLOWED_ROOT="$helper_root"
fi

# --check 可能是单独拷出来跑的，此时手边没有仓库源文件，跳过版本比对即可
src_ver=""
if [ -f "$SRC_DIR/ci-panel-runner-svc" ]; then
  src_ver="$(sed -n 's/^VERSION=//p' "$SRC_DIR/ci-panel-runner-svc" | head -1)"
fi
if [ -n "$src_ver" ] && [ "$src_ver" != "$helper_ver" ]; then
  die "机器上装的助手是旧版(version=$helper_ver)，仓库里是 version=$src_ver——重跑本脚本不加 --check"
fi

# 3c) 启停：start/stop/restart 都有副作用，所以拿一个不存在的探针单元跑 start。授权链路会放行
#     (名字通过助手的 SERVICE_RE)，systemctl 再以 "Unit not found" 失败。于是「被拒」和「单元
#     不存在」可区分，且全程零副作用。
if "$SYSTEMCTL" cat "$PROBE_UNIT" >/dev/null 2>&1; then
  die "探针单元居然存在: $PROBE_UNIT——改掉脚本里的 PROBE_UNIT 再试，否则这次探测会真的启动它"
fi
probe_out="$(as_user sudo -n "$HELPER_DEST" start "$PROBE_UNIT" || true)"
if echo "$probe_out" | grep -Eqi 'password is required|not allowed to execute|^sudo:'; then
  die "启停未放行，检查 $SUDOERS_HELPER：
$probe_out"
fi
if echo "$probe_out" | grep -q '非法的单元名'; then
  die "助手拒绝了探针单元名，说明装的助手版本不支持 start/stop/restart：
$probe_out"
fi
ok "启停已生效（经助手校验后执行，sudoers 不含任何通配符规则）"

# 3c-2) 旧的启停白名单必须已经不在了：它放行带通配符的 systemctl，等于允许启动任意单元
if [ -f "$SUDOERS_SVC_LEGACY" ]; then
  die "$SUDOERS_SVC_LEGACY 仍存在——该规则的通配符可放行任意单元，重跑本脚本(不加 --check)以移除"
fi
ok "旧的通配符启停白名单已不存在"

# 3d) 根目录必须由 daemon 用户可写，否则创建 runner 会在解压阶段就失败
as_user test -w "$ALLOWED_ROOT" || die "$RUN_USER 不可写根目录 $ALLOWED_ROOT"
ok "根目录 $ALLOWED_ROOT 可写"

# 3e) daemon 启动时会调 preflight 把 ALLOWED_ROOT 读回去当扫描根，所以不需要另设 CIP_SCAN_ROOTS。
#     该变量只剩「拿不到助手时的回退值」这一个用途；设了且不一致的话 daemon 以助手为准并打 warn。
echo
if [ -n "${CIP_SCAN_ROOTS:-}" ] && [ "$CIP_SCAN_ROOTS" != "$ALLOWED_ROOT" ]; then
  warn "当前环境 CIP_SCAN_ROOTS=$CIP_SCAN_ROOTS 与 ALLOWED_ROOT=$ALLOWED_ROOT 不一致"
  warn "daemon 会以助手为准($ALLOWED_ROOT)并打 warn；建议直接去掉这个环境变量"
fi
echo "扫描根: $ALLOWED_ROOT —— daemon 启动时自动从助手读取，重启 daemon 后生效"

echo
ok "全部检查通过：$RUN_USER 已具备管理 $ALLOWED_ROOT 下 runner 的全部权限"
