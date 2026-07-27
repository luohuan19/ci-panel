#!/usr/bin/env bash
# 更新已经装好的 ci-panel，失败自动回滚。
#
#   sudo bash update.sh --check          # 只看当前版本和最新版本
#   sudo bash update.sh                  # 更新到 GitHub latest release
#   sudo bash update.sh --version 1.1.0  # 更新到指定版本
#   sudo bash update.sh --file pkg.tar.gz
#   sudo bash update.sh --rollback       # 切回上一个版本
#
# 更新是怎么做到安全的:
#   1. 新版本先完整铺到 releases/<新版本>/，此时线上还跑着旧的
#   2. 数据不动 —— data/logs/tmp 都是指向 shared/ 的软链，换 release 碰不到它们
#   3. 切换只是把 current 这个软链原子替换掉（mv -T），随时可以切回去
#   4. 切完重启并探活；起不来就自动切回旧版本再退出非零
#
# 对正在跑的 CI job 没有影响: runner 跑在自己的 actions.runner.*.service 单元里，
# 有独立 cgroup，不是 daemon 的子进程。但正在进行的 runner 创建/删除会被打断。
set -euo pipefail

_self="${BASH_SOURCE[0]:-}"
if [ -z "$_self" ] || [ ! -f "$_self" ]; then
  echo "错误: 本脚本需要同级的 lib/common.sh，请在解包后的目录里执行" >&2
  exit 1
fi
SELF_DIR="$(cd "$(dirname "$_self")" && pwd)"
if [ ! -f "$SELF_DIR/lib/common.sh" ]; then
  echo "错误: 找不到 $SELF_DIR/lib/common.sh —— 安装目录不完整？" >&2
  exit 1
fi
# shellcheck source=lib/common.sh
. "$SELF_DIR/lib/common.sh"

INSTALL_ROOT="/opt/ci-panel"
WANT_VERSION=""
TARBALL=""
KEEP=3
DO_CHECK=0
DO_ROLLBACK=0
FORCE=0
ASSUME_YES=0

SRC=""
VERSION=""
RUN_USER=""
NODE_BIN=""
RELEASE_DIR=""
ROLES=""
TMP=""

usage() {
  cat <<'EOF'
用法: sudo bash update.sh [选项]

  --check           只报告当前版本与最新版本，不做任何改动
  --version <v>     更新到指定版本（默认取 GitHub latest release）
  --file <tarball>  用本地包更新
  --rollback        切回上一个版本（来回切也可以）
  --keep <n>        releases/ 下最多保留几个版本，默认 3（current 与上一版永不删）
  --force           版本号相同也照样重新部署
  --root <path>     安装根目录（默认 /opt/ci-panel）
  --yes             不做交互确认
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --check) DO_CHECK=1 && shift ;;
      --rollback) DO_ROLLBACK=1 && shift ;;
      --force) FORCE=1 && shift ;;
      --version) WANT_VERSION="${2:?--version 需要参数}" && shift 2 ;;
      --file) TARBALL="${2:?--file 需要参数}" && shift 2 ;;
      --keep) KEEP="${2:?--keep 需要参数}" && shift 2 ;;
      --root) INSTALL_ROOT="${2:?--root 需要参数}" && shift 2 ;;
      --yes | -y) ASSUME_YES=1 && shift ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "未知参数: $1（-h 看用法）" ;;
    esac
  done
  if ! printf '%s' "$KEEP" | grep -Eq '^[1-9][0-9]*$'; then
    die "--keep 要是正整数: $KEEP"
  fi
  if [ -n "$WANT_VERSION" ]; then validate_version "$WANT_VERSION"; fi
  # 和 install.sh 同一道检查：INSTALL_ROOT 会被 sed 渲染进 systemd 单元和 ci-panel-ctl
  validate_path_for_sed "$INSTALL_ROOT" "--root"
  INSTALL_ROOT="$(readlink -m "$INSTALL_ROOT")"
  # 再验一遍：readlink -m 会跟随符号链接，解析出来的真实路径可能含有上面那次
  # 校验时根本看不到的元字符（/tmp/link → /tmp/unsafe|root 这种）。
  validate_path_for_sed "$INSTALL_ROOT" "--root（解析软链后）"

}

cleanup() {
  if [ -n "$TMP" ]; then rm -rf "$TMP"; fi
}

# 从已装好的环境里把上下文读出来，而不是让用户再传一遍
load_context() {
  if [ ! -L "$INSTALL_ROOT/current" ]; then
    die "$INSTALL_ROOT/current 不存在 —— 这台机器还没装过？先跑 install.sh"
  fi
  ROLES="$(installed_roles | tr '\n' ' ')"
  if [ -z "${ROLES// /}" ]; then die "没有找到任何 ci-panel 的 systemd 单元"; fi
  if ! NODE_BIN="$(node_from_unit)" || [ -z "$NODE_BIN" ]; then
    die "从 systemd 单元里读不出 node 路径"
  fi
  if ! RUN_USER="$(user_from_unit)" || [ -z "$RUN_USER" ]; then
    die "从 systemd 单元里读不出运行用户"
  fi
}

unit_of() { # role
  case "$1" in
    daemon) printf '%s' "$DAEMON_UNIT" ;;
    web) printf '%s' "$WEB_UNIT" ;;
    *) die "未知角色: $1" ;;
  esac
}

port_of() { # role
  case "$1" in
    daemon) daemon_port ;;
    web) web_port ;;
    *) die "未知角色: $1" ;;
  esac
}

addr_of() { # role —— 服务实际绑定的地址，探活要连它而不是想当然的回环
  case "$1" in
    daemon) daemon_addr ;;
    web) web_addr ;;
    *) die "未知角色: $1" ;;
  esac
}

current_version() {
  read_version_file "$INSTALL_ROOT/current" 2>/dev/null || printf 'unknown'
}

do_check() {
  printf '当前版本: %s\n' "$(current_version)"
  printf '已装组件: %s\n' "${ROLES% }"
  need_cmd curl
  local tag latest
  tag="$(resolve_latest_tag)"
  if [ -z "$tag" ]; then
    warn "查不到 latest release（网络或代理问题？）"
    return
  fi
  latest="${tag#"$TAG_PREFIX"}"
  printf '最新版本: %s\n' "$latest"
  if [ "$(current_version)" = "$latest" ]; then
    printf '已是最新。\n'
  else
    printf '可以更新: sudo bash update.sh\n'
  fi
}

# 升级前留一份数据。InstanceData / runner-pkg 这类大目录不备份 —— 它们动辄几百 MB，
# 而且升级根本不碰它们；真正怕丢的是 Config（含 daemon 身份 key）和 panel 的用户/节点表。
backup_data() {
  local stamp dir comp
  local items=()
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  dir="$INSTALL_ROOT/backups/$stamp"
  for comp in daemon web; do
    if [ -d "$INSTALL_ROOT/shared/$comp/data" ]; then items+=("$comp/data"); fi
  done
  if [ "${#items[@]}" -eq 0 ]; then
    warn "shared/ 下没有数据目录，跳过备份"
    return
  fi
  # 归档里有 Config/global.json，也就是这个节点的准入密钥。默认 umask 下
  # 目录是 0755、tar 出来的文件是 0644，到下面 chmod 之前的这段时间里
  # 本机任何用户都能读走它 —— 所以在创建之前就把权限收紧。
  local old_umask
  old_umask="$(umask)"
  umask 077
  mkdir -p "$dir"
  tar -C "$INSTALL_ROOT/shared" -czf "$dir/data.tar.gz" \
    --exclude='InstanceData' --exclude='runner-pkg' --exclude='InstanceLog' \
    "${items[@]}"
  umask "$old_umask"
  chmod 600 "$dir/data.tar.gz" # umask 已经保证了，这里是显式兜底
  log "已备份数据: $dir/data.tar.gz"
}

restart_all() {
  local role
  for role in $ROLES; do
    systemctl restart "$(unit_of "$role")"
  done
}

probe_all() { # 全部起来才算成功
  local role
  for role in $ROLES; do
    if ! probe_service "$(unit_of "$role")" "$(port_of "$role")" "$role" "$(addr_of "$role")"; then
      return 1
    fi
  done
  return 0
}

# 原子替换 current 软链并重启探活。成功 0，失败 1（不自己回滚，交给调用方决定）
switch_to() { # release_dir
  local target="$1"
  ln -sfnT "$target" "$INSTALL_ROOT/current.new"
  mv -T "$INSTALL_ROOT/current.new" "$INSTALL_ROOT/current"
  # 单元要跟着版本走：新版本可能改了 ExecStart 或加了单元配置，只换代码不换单元
  # 会让升级过的机器永远拿不到。放在这里，回滚时也会自动用回滚目标自己的模板。
  # shellcheck disable=SC2086  # ROLES 是空格分隔的角色列表，这里要的就是词分割
  render_units_for_roles "$target" $ROLES
  restart_all
  probe_all
}

prune_releases() {
  local cur prev kept=0 dir
  cur="$(readlink -f "$INSTALL_ROOT/current" 2>/dev/null || true)"
  if [ -z "$cur" ]; then
    warn "读不到 current 指向哪个版本，跳过清理以免误删正在跑的那份"
    return
  fi
  prev=""
  if [ -f "$INSTALL_ROOT/.previous" ]; then prev="$(cat "$INSTALL_ROOT/.previous")"; fi

  # current 和上一版无论多旧都留着 —— 那是回滚路径。配额要先算给它们再遍历其余的：
  # 它们的 mtime 是包的构建时间，在按时间排序里往往排在最后，如果等遍历到才计数，
  # 前面那些旧版本会先把 KEEP 占满，总数就压不下来。
  if [ -n "$cur" ] && [ -d "$cur" ]; then kept=$((kept + 1)); fi
  if [ -n "$prev" ] && [ -d "$prev" ] && [ "$prev" != "$cur" ]; then kept=$((kept + 1)); fi

  while IFS= read -r dir; do
    if [ "$dir" = "$cur" ] || [ "$dir" = "$prev" ]; then continue; fi
    kept=$((kept + 1))
    if [ "$kept" -gt "$KEEP" ]; then
      log "清理旧版本 $(basename "$dir")"
      rm -rf "$dir"
    fi
  done < <(ls -1dt "$INSTALL_ROOT/releases"/*/ 2>/dev/null | sed 's:/$::' || true)
}

# 特权助手装在 /usr/local/sbin，不在 releases/ 下，所以它不会跟着 current 软链一起切换。
# 新版本可能修了助手的 bug 或给它加了动作，只跑 update 的机器必须在这里补上，否则
# daemon 去调新动作时才失败 —— 而那时 runner 可能已经注册到 GitHub 了
# （见 prod-scripts/README.md）。
#
# ALLOWED_ROOT 不用让用户重传 --scan-root: 助手自己就是这个值的真相源，preflight 会打印，
# daemon 的 initRunnerRoots 也是这么读回去的。
refresh_privileges() { # release_dir [helper_path]
  local release="$1"
  # 助手路径可以传第二个参数覆盖，默认就是 install-runner-privileges.sh 装过去的位置
  local helper="${2:-/usr/local/sbin/ci-panel-runner-svc}"

  # 纯面板机（--role web）不跑 runner，助手对它毫无意义，别拿"没装助手"去吓唬人
  case " $ROLES " in
    *" daemon "*) ;;
    *)
      log "这台机器没有 daemon，跳过特权助手（面板本身不在本地管 runner）"
      return
      ;;
  esac
  local installer="$release/prod-scripts/install-runner-privileges.sh"
  local src="$release/prod-scripts/ci-panel-runner-svc"

  if [ ! -x "$helper" ]; then
    warn "这台机器没配特权助手，跳过。补上之前创建 runner 会失败："
    warn "  sudo bash $installer --user $RUN_USER --root <runner 根目录>"
    return
  fi
  if [ ! -f "$installer" ] || [ ! -f "$src" ]; then
    warn "包里没有 prod-scripts，跳过特权助手更新"
    return
  fi

  local pre want have root
  pre="$("$helper" preflight 2>/dev/null || true)"
  have="$(printf '%s' "$pre" | sed -n 's/^version=//p' | head -n1 || true)"
  root="$(printf '%s' "$pre" | sed -n 's/^allowed_root=//p' | head -n1 || true)"
  want="$(sed -n 's/^VERSION=//p' "$src" | head -n1 || true)"

  if [ -z "$root" ]; then
    warn "已装的助手不认识 preflight（版本太旧），读不到 ALLOWED_ROOT，无法自动升级。手动跑："
    warn "  sudo bash $installer --user $RUN_USER --root <runner 根目录>"
    return
  fi
  if [ -n "$want" ] && [ "$want" = "$have" ]; then
    log "特权助手已是 v$have，无需更新"
    return
  fi

  log "更新特权助手 v${have:-?} → v${want:-?}（ALLOWED_ROOT=$root，取自助手自身）"
  # 这里失败不触发服务回滚: 服务本身是好的，只是 runner 管理能力没跟上，
  # 把话说清楚让人手动处理，比把一次成功的升级整个推翻更合适。
  if ! bash "$installer" --user "$RUN_USER" --root "$root"; then
    warn "特权助手更新失败。服务不受影响，但创建/删除 runner 可能出问题。手动重试："
    warn "  sudo bash $installer --user $RUN_USER --root $root"
  fi
}

prune_backups() {
  local kept=0 dir
  while IFS= read -r dir; do
    kept=$((kept + 1))
    if [ "$kept" -gt "$KEEP" ]; then
      log "清理旧备份 $(basename "$dir")"
      rm -rf "$dir"
    fi
  done < <(ls -1dt "$INSTALL_ROOT/backups"/*/ 2>/dev/null | sed 's:/$::' || true)
}

do_rollback() {
  if [ ! -f "$INSTALL_ROOT/.previous" ]; then
    die "没有 .previous 记录，无法回滚（这台机器还没更新过？）"
  fi
  local prev cur
  prev="$(cat "$INSTALL_ROOT/.previous")"
  cur="$(readlink -f "$INSTALL_ROOT/current")"
  if [ ! -d "$prev" ]; then
    die "上一个版本的目录已经不在了: $prev"
  fi
  if [ "$prev" = "$cur" ]; then
    die ".previous 和 current 指向同一个版本（$(basename "$cur")），没有可回滚的目标"
  fi
  log "回滚: $(basename "$cur") → $(basename "$prev")"
  if ! confirm "会重启服务（正在跑的 CI job 不受影响）。继续？"; then die "已取消"; fi
  # 交换记录，这样可以再切回来
  printf '%s\n' "$cur" >"$INSTALL_ROOT/.previous"
  if ! switch_to "$prev"; then
    warn "回滚后的版本也没起来，切回 $(basename "$cur")"
    printf '%s\n' "$prev" >"$INSTALL_ROOT/.previous"
    if switch_to "$cur"; then
      die "已恢复到 $(basename "$cur")。$(basename "$prev") 起不来的原因见上面的日志"
    fi
    die "两个版本都起不来，需要人工介入。current 现在指向 $(readlink -f "$INSTALL_ROOT/current")"
  fi
  refresh_privileges "$prev" # 助手也退回这个版本，别留下新助手配旧代码的组合
  log "已回滚到 $(current_version)"
}

do_update() {
  local from
  from="$(current_version)"

  if [ -n "$TARBALL" ]; then
    if [ ! -f "$TARBALL" ]; then die "找不到包文件: $TARBALL"; fi
    TARBALL="$(readlink -m "$TARBALL")"
    verify_checksum "$TARBALL"
    unpack "$TARBALL"
  else
    need_cmd curl
    if [ -z "$WANT_VERSION" ]; then
      log "查询 $REPO 的 latest release …"
      local tag
      tag="$(resolve_latest_tag)"
      if [ -z "$tag" ]; then
        die "取不到 latest release。用 --version 指定，或 --file 用本地包"
      fi
      WANT_VERSION="${tag#"$TAG_PREFIX"}"
    fi
    if [ "$WANT_VERSION" = "$from" ] && [ "$FORCE" -ne 1 ]; then
      log "已经是 $from，无需更新（要强制重装加 --force）"
      return
    fi
    download_release "$WANT_VERSION"
  fi

  if ! VERSION="$(read_version_file "$SRC")" || [ -z "$VERSION" ]; then
    die "包里没有 VERSION 文件或缺 version= 行"
  fi
  if [ "$VERSION" = "$from" ] && [ "$FORCE" -ne 1 ]; then
    log "包里的版本和当前一致（$from），无需更新（要强制重装加 --force）"
    return
  fi

  # 架构护栏: 新包必须带本机架构的 lib，否则 daemon 起不来（checkDependencies 会抛错）
  local arch
  case "$(uname -m)" in
    x86_64 | amd64) arch="x64" ;;
    aarch64 | arm64) arch="arm64" ;;
    *) die "不支持的架构: $(uname -m)" ;;
  esac
  local f
  for f in "pty_linux_$arch" "file_zip_linux_$arch" "7z_linux_$arch"; do
    if [ ! -f "$SRC/daemon/lib/$f" ]; then die "新包里缺 daemon/lib/$f，拒绝部署"; fi
  done

  log "准备更新: $from → $VERSION（组件: ${ROLES% }）"
  if ! confirm "会重启服务。正在跑的 CI job 不受影响，但正在进行的 runner 创建/删除会中断。继续？"; then
    die "已取消"
  fi

  # prev 必须在铺开之前就定下来。--force 重装同一个版本时 releases/<version> 正是
  # current 指向的目录，等铺完再取就会指向刚被覆盖的自己，"自动回滚"等于没有。
  local prev
  prev="$(readlink -f "$INSTALL_ROOT/current")"

  RELEASE_DIR="$INSTALL_ROOT/releases/$VERSION"
  if [ "$RELEASE_DIR" = "$prev" ]; then
    # 同版本重装：铺到带时间戳的兄弟目录，不碰正在跑的那份，回滚目标才是完好的旧代码
    RELEASE_DIR="$INSTALL_ROOT/releases/$VERSION+$(date -u +%Y%m%d%H%M%S)"
    log "同版本重装，铺到 $(basename "$RELEASE_DIR") 以保住回滚路径"
  fi
  log "铺开 $RELEASE_DIR …"
  deploy_release_dir
  local role
  for role in $ROLES; do link_shared "$role"; done

  backup_data
  printf '%s\n' "$prev" >"$INSTALL_ROOT/.previous"

  log "切换到 $VERSION 并重启 …"
  if ! switch_to "$RELEASE_DIR"; then
    warn "$VERSION 没能正常起来，自动回滚到 $(basename "$prev")"
    if switch_to "$prev"; then
      die "已回滚到 $from，服务正常。$VERSION 的失败原因见上面的日志"
    fi
    die "回滚也失败了，需要人工介入。current 指向 $(readlink -f "$INSTALL_ROOT/current")"
  fi

  # 助手不在 releases/ 下，切软链带不动它，得显式跟着新版本更新
  refresh_privileges "$RELEASE_DIR"

  # systemd 单元已经在 switch_to 里跟着新版本渲染过了，这里补上 ctl
  if [ -f "$RELEASE_DIR/ci-panel-ctl" ]; then
    sed -e "s|__ROOT__|$INSTALL_ROOT|g" "$RELEASE_DIR/ci-panel-ctl" >/usr/local/bin/ci-panel-ctl.new
    chmod 755 /usr/local/bin/ci-panel-ctl.new
    mv -T /usr/local/bin/ci-panel-ctl.new /usr/local/bin/ci-panel-ctl
  fi

  prune_releases
  prune_backups
  log "更新完成: $from → $VERSION"
  printf '出问题可以回滚: sudo bash %s/current/update.sh --rollback\n' "$INSTALL_ROOT"
}

main() {
  parse_args "$@"
  need_root
  need_cmd systemctl
  need_cmd tar
  load_context
  TMP="$(mktemp -d)"
  trap cleanup EXIT

  if [ "$DO_CHECK" -eq 1 ]; then
    do_check
    return
  fi
  if [ "$DO_ROLLBACK" -eq 1 ]; then
    do_rollback
    return
  fi
  do_update
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
