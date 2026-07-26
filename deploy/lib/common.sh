#!/usr/bin/env bash
# install.sh 与 update.sh 的公共部分。不要直接执行 —— 由那两个脚本 source。
#
# 约定：调用方在 source 之后自己把这些全局变量准备好，下面的函数不做兜底。
#   TMP           临时目录（下载、解包用）
#   INSTALL_ROOT  安装根目录
#   RELEASE_DIR   本次操作的 release 目录（link_shared 用）
#   RUN_USER      服务运行用户（link_shared 的 chown 用）
#   NODE_BIN      node 的绝对路径（read_json_field / wait_tcp 用）
# unpack 会设置 SRC，指向解包出来的 ci-panel-<version>/ 目录。

REPO="luohuan19/ci-panel"
TAG_PREFIX="cip-v"
DAEMON_UNIT="ci-panel-daemon.service"
WEB_UNIT="ci-panel-web.service"

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m警告:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[31m错误:\033[0m %s\n' "$*" >&2
  exit 1
}

confirm() { # prompt
  if [ "${ASSUME_YES:-0}" -eq 1 ]; then return 0; fi
  local reply
  printf '%s [y/N] ' "$1"
  # 从 /dev/tty 读而不是 stdin：脚本可能是被管道喂进来的
  if ! read -r reply </dev/tty 2>/dev/null; then
    die "没有可交互的终端，无法确认。加 --yes 以非交互方式运行"
  fi
  case "$reply" in
    [yY] | [yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then die "缺少命令: $1"; fi
}

need_root() {
  if [ "$(id -u)" -ne 0 ]; then die "需要 root：sudo bash $(basename "$0") ..."; fi
}

# ---- 取包 ----
verify_checksum() { # tarball
  local f="$1"
  if [ -f "$f.sha256" ]; then
    log "校验 sha256 …"
    if ! (cd "$(dirname "$f")" && sha256sum -c "$(basename "$f").sha256" >/dev/null 2>&1); then
      die "sha256 校验失败: $f"
    fi
  else
    warn "$(basename "$f") 旁边没有 .sha256，跳过完整性校验"
  fi
}

unpack() { # tarball → 设置 SRC
  log "解包 $(basename "$1") …"
  mkdir -p "$TMP/unpack"
  # --no-same-owner: root 解包默认会保留归档里的 uid/gid，那样包的构建环境就能决定
  # 目标机上的文件属主。后面 deploy_release_dir 会统一 chown root，这里先不给机会。
  tar --no-same-owner -C "$TMP/unpack" -xzf "$1"
  SRC="$(find "$TMP/unpack" -mindepth 1 -maxdepth 1 -type d -name 'ci-panel-*' | head -n1)"
  if [ -z "$SRC" ]; then die "包结构不对：里面没有 ci-panel-<version>/ 顶层目录"; fi
}

# 版本号会被拼进下载 URL 和 $TMP 下的文件名，必须先卡住格式
validate_version() { # version
  if ! printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.]+)?$'; then
    die "版本号格式不对: $1（应形如 1.0.0 或 1.0.0-rc1）"
  fi
}

resolve_latest_tag() {
  # 末尾的 || true 是必须的：set -o pipefail 下 curl 一失败整个管道就返回非 0，
  # 而这里要的是"返回空串让调用方给出有用的提示"，不是让脚本当场死掉。
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1 || true
}

download_release() { # version → 下载 + 校验 + 解包
  local version="$1"
  validate_version "$version"
  local name="ci-panel-$version-linux.tar.gz"
  local base="https://github.com/$REPO/releases/download/$TAG_PREFIX$version"
  log "下载 $name …"
  if ! curl -fL --retry 3 --retry-delay 2 -o "$TMP/$name" "$base/$name"; then
    die "下载失败: $base/$name（版本号写错了？或者需要设 https_proxy）"
  fi
  if ! curl -fsSL --retry 2 -o "$TMP/$name.sha256" "$base/$name.sha256" 2>/dev/null; then
    rm -f "$TMP/$name.sha256" # 校验和缺失不致命，verify_checksum 会 warn
  fi
  verify_checksum "$TMP/$name"
  unpack "$TMP/$name"
}

read_version_file() { # dir → 打印 version=
  local f="$1/VERSION"
  if [ ! -f "$f" ]; then return 1; fi
  # 和 resolve_latest_tag 一样：pipefail 下 head 提前关闭管道会让整条命令失败
  sed -n 's/^version=//p' "$f" | head -n1 || true
}

# ---- 目录布局 ----
# data/logs/tmp 必须落在 shared 上：panel 和 daemon 的路径全是基于 process.cwd() 拼的，
# 换 release 目录升级会把用户、节点表和 daemon 身份一起留在旧目录里。
link_shared() { # component: daemon|web
  local comp="$1" sub
  for sub in data logs tmp; do
    mkdir -p "$INSTALL_ROOT/shared/$comp/$sub"
    rm -rf "$RELEASE_DIR/$comp/$sub"
    ln -sfnT "$INSTALL_ROOT/shared/$comp/$sub" "$RELEASE_DIR/$comp/$sub"
  done
  chown -R "$RUN_USER:$RUN_USER" "$INSTALL_ROOT/shared/$comp"
  # 目录收到 750: daemon 的 data/Config/global.json 里存着这个节点的准入密钥，
  # 而那个文件是 daemon 自己写的（属主 umask 说了算，通常 0644）。挡在目录这一层，
  # 本机其他用户就进不来了。
  chmod 750 "$INSTALL_ROOT/shared/$comp"
  chmod 750 "$INSTALL_ROOT/shared/$comp/data"
}

installed_roles() { # 打印本机装了哪些单元对应的组件
  if [ -f "/etc/systemd/system/$DAEMON_UNIT" ]; then echo daemon; fi
  if [ -f "/etc/systemd/system/$WEB_UNIT" ]; then echo web; fi
}

# 单元里的 ExecStart / User 是 install.sh 当初验证过的，比现场再猜一遍可靠
installed_unit_path() {
  local unit="/etc/systemd/system/$DAEMON_UNIT"
  if [ ! -f "$unit" ]; then unit="/etc/systemd/system/$WEB_UNIT"; fi
  if [ ! -f "$unit" ]; then return 1; fi
  printf '%s' "$unit"
}

node_from_unit() {
  local unit
  if ! unit="$(installed_unit_path)"; then return 1; fi
  sed -n 's|^ExecStart=\([^ ]*\).*|\1|p' "$unit" | head -n1 || true
}

user_from_unit() {
  local unit
  if ! unit="$(installed_unit_path)"; then return 1; fi
  sed -n 's|^User=||p' "$unit" | head -n1 || true
}

# 把 SRC 里的包铺到 RELEASE_DIR。调用方负责先确认是否覆盖。
# 代码归 root: 服务以 RUN_USER 运行，不该能改自己的代码；数据都在 shared 里（link_shared 链过去）。
#
# 覆盖已有目录时先把旧的挪到一边而不是直接 rm -rf ——否则 cp 中途失败（磁盘满、包损坏）
# 就把线上正在跑的代码删没了，且没有任何可回退的东西。
deploy_release_dir() {
  case "$RELEASE_DIR/" in
    "$SRC/"*) die "包所在目录 ($SRC) 在安装目标 ($RELEASE_DIR) 里面，换个地方解包再跑" ;;
  esac
  local stash=""
  if [ -d "$RELEASE_DIR" ]; then
    stash="$RELEASE_DIR.replacing"
    rm -rf "$stash"
    mv -T "$RELEASE_DIR" "$stash"
  fi
  mkdir -p "$RELEASE_DIR"
  if ! cp -a "$SRC/." "$RELEASE_DIR/"; then
    rm -rf "$RELEASE_DIR"
    if [ -n "$stash" ]; then
      mv -T "$stash" "$RELEASE_DIR"
      die "铺开 $RELEASE_DIR 失败，已还原成原来的内容"
    fi
    die "铺开 $RELEASE_DIR 失败"
  fi
  if [ -n "$stash" ]; then rm -rf "$stash"; fi
  chown -R root:root "$RELEASE_DIR"
  chmod -R go-w "$RELEASE_DIR"
  chmod a+x "$RELEASE_DIR"/daemon/lib/* 2>/dev/null || true
}

# 单元由 install.sh 和 update.sh 共用：更新时也要重渲染，否则新版本改了 ExecStart
# 或加了单元配置，升级过的机器永远拿不到。回滚时同样会用回滚目标自己的模板。
render_unit() { # tmpl dest
  sed -e "s|__USER__|$RUN_USER|g" \
    -e "s|__ROOT__|$INSTALL_ROOT|g" \
    -e "s|__NODE__|$NODE_BIN|g" \
    "$1" >"$2.new"
  chmod 644 "$2.new"
  mv -T "$2.new" "$2" # 原地截断写入会让并发读到半截文件
}

render_units_for_roles() { # release_dir role…
  local release="$1"
  shift
  local role tmpl unit
  for role in "$@"; do
    case "$role" in
      daemon)
        tmpl="$release/systemd/ci-panel-daemon.service.tmpl"
        unit="$DAEMON_UNIT"
        ;;
      web)
        tmpl="$release/systemd/ci-panel-web.service.tmpl"
        unit="$WEB_UNIT"
        ;;
      *) die "未知角色: $role" ;;
    esac
    if [ ! -f "$tmpl" ]; then die "包里缺单元模板: $tmpl"; fi
    render_unit "$tmpl" "/etc/systemd/system/$unit"
  done
  systemctl daemon-reload
}

# ---- 探活 ----
read_json_field() { # file field
  "$NODE_BIN" -e '
const fs = require("fs");
try {
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]];
  if (value !== undefined && value !== null) process.stdout.write(String(value));
} catch {}
' "$1" "$2"
}

wait_tcp() { # port timeout_seconds
  local waited=0
  while [ "$waited" -lt "$2" ]; do
    if "$NODE_BIN" -e '
const socket = require("net").connect(Number(process.argv[1]), "127.0.0.1");
socket.on("connect", () => { socket.destroy(); process.exit(0); });
socket.on("error", () => process.exit(1));
socket.setTimeout(2000, () => { socket.destroy(); process.exit(1); });
' "$1" 2>/dev/null; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# 成功返回 0，失败返回 1 并把日志打出来 —— 由调用方决定是 die 还是回滚
probe_service() { # unit port label
  local unit="$1" port="$2" label="$3"
  if ! systemctl is-active --quiet "$unit"; then
    warn "$unit 不是 active 状态"
    systemctl status "$unit" --no-pager --lines 20 >&2 || true
    return 1
  fi
  if ! wait_tcp "$port" 30; then
    warn "$label 30 秒内没有监听 $port"
    journalctl -u "$unit" -n 30 --no-pager >&2 || true
    return 1
  fi
  log "$label 已就绪（:$port）"
  return 0
}

daemon_port() {
  local cfg="$INSTALL_ROOT/shared/daemon/data/Config/global.json" port=""
  if [ -f "$cfg" ]; then port="$(read_json_field "$cfg" port)"; fi
  if [ -z "$port" ]; then port="24444"; fi
  printf '%s' "$port"
}

web_port() {
  local cfg="$INSTALL_ROOT/shared/web/data/SystemConfig/config.json" port=""
  if [ -f "$cfg" ]; then port="$(read_json_field "$cfg" httpPort)"; fi
  if [ -z "$port" ]; then port="23333"; fi
  printf '%s' "$port"
}

detect_ip() {
  # 同样需要 || true：机器上没有 iproute2 时，pipefail 会让整个管道失败
  ip route get 1.1.1.1 2>/dev/null |
    sed -n 's/.*[[:space:]]src[[:space:]]\([0-9.]*\).*/\1/p' | head -n1 || true
}
