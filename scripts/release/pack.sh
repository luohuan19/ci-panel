#!/usr/bin/env bash
# 打包 ci-panel 发布 tarball。
#
# 用法:
#   bash scripts/release/pack.sh 1.0.0
#   bash scripts/release/pack.sh 1.0.0 --skip-lib     # 无外网时跳过 lib 二进制下载
#   bash scripts/release/pack.sh 1.0.0 --skip-build   # 复用上一次的 production-code/
#
# 产物: dist-release/ci-panel-<version>-linux.tar.gz 与同名 .sha256
#
# 一个包同时适用 x64 与 arm64: 四个包里没有任何原生模块(node_modules 下无 .node)，
# 唯一按架构分文件的是 daemon/lib 下的 pty / 7z / file_zip，运行时由 daemon/src/const.ts
# 按 os.arch() 自己挑，所以全架构一起打进去即可。
#
# 版本号为什么要写进三个字段: 概览页显示的版本取自 web/package.json 的 version，
# 而节点列表上"该 daemon 待更新"的告警是拿 web/package.json 的 daemonVersion 去比
# daemon 上报的 version(frontend/src/tools/version.ts 只比 major.minor)。三者写成同一个
# 值，告警才只在节点真的落后时才亮。改动只落在 stage 副本上，源码树保持干净。
#
# 打包对本机零影响: build.sh 会把 daemon/production/app.js 和 panel/production/app.js
# mv 进 production-code/ 再删掉 production/ 目录，而本机的 daemon/panel 正是用这两个文件
# 启动的(start-cipanel.sh)。本脚本退出前把**打包前那一份**原样放回（不是新构建的产物），
# 构建中途失败也还原 —— 打包不该顺手把现网服务的代码换成当前分支的版本，
# 要更新本机服务请走部署/更新流程。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/dist-release"

usage() {
  cat <<'EOF'
用法: bash scripts/release/pack.sh <version> [--skip-build] [--skip-lib]

  <version>      语义化版本号，如 1.0.0 或 1.0.0-rc1
  --skip-build   复用上一次的 production-code/（迭代脚本时省时间）
  --skip-lib     跳过 daemon/lib 二进制下载。注意这样的包不能部署也过不了 smoke test：
                 daemon 启动时 checkDependencies() 找不到 file_zip 会直接抛错退出
EOF
}

VERSION=""
SKIP_BUILD=0
SKIP_LIB=0
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1 ;;
    --skip-lib) SKIP_LIB=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "未知参数: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$VERSION" ]; then
        echo "只能给一个版本号（多余的: $1）" >&2
        exit 2
      fi
      VERSION="$1"
      ;;
  esac
  shift
done

if [ -z "$VERSION" ]; then
  usage >&2
  exit 2
fi

# major.minor 要能被 frontend/src/tools/version.ts 的 split(".") 取到，格式必须是 semver
if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'; then
  echo "版本号格式不对: $VERSION（应形如 1.0.0 或 1.0.0-rc1）" >&2
  exit 2
fi

STAGE="$OUT/ci-panel-$VERSION"
TARBALL="$OUT/ci-panel-$VERSION-linux.tar.gz"

# ---- 保护本机现网的 production/app.js（见文件头说明）----
BACKUP_DIR=""

backup_local_production() {
  BACKUP_DIR="$(mktemp -d)"
  local pkg
  for pkg in daemon panel; do
    if [ -f "$ROOT/$pkg/production/app.js" ]; then
      mkdir -p "$BACKUP_DIR/$pkg"
      cp -f "$ROOT/$pkg/production/app.js" "$BACKUP_DIR/$pkg/app.js"
      if [ -f "$ROOT/$pkg/production/app.js.map" ]; then
        cp -f "$ROOT/$pkg/production/app.js.map" "$BACKUP_DIR/$pkg/app.js.map"
      fi
    fi
  done
}

restore_local_production() {
  local pkg sub dst src origin
  for pkg in daemon panel; do
    if [ "$pkg" = panel ]; then sub=web; else sub=daemon; fi
    dst="$ROOT/$pkg/production"
    if [ -f "$dst/app.js" ]; then continue; fi # 还在原地，不用管
    if [ -n "$BACKUP_DIR" ] && [ -f "$BACKUP_DIR/$pkg/app.js" ]; then
      src="$BACKUP_DIR/$pkg" # 打包前在跑的那一份，原样放回
      origin="打包前的备份"
    elif [ -f "$ROOT/production-code/$sub/app.js" ]; then
      src="$ROOT/production-code/$sub" # 本机从没构建过，放一份新的总比没有好
      origin="本次构建产物"
    else
      continue
    fi
    mkdir -p "$dst"
    cp -f "$src/app.js" "$dst/app.js"
    if [ -f "$src/app.js.map" ]; then cp -f "$src/app.js.map" "$dst/app.js.map"; fi
    echo "[还原] $pkg/production/app.js ← $origin（本机服务保持可重启）"
  done
  if [ -n "$BACKUP_DIR" ]; then rm -rf "$BACKUP_DIR"; fi
}

echo "== 打包 ci-panel $VERSION =="

backup_local_production
trap restore_local_production EXIT

if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "[1/8] 构建（build.sh: common → daemon → panel → frontend，并装生产依赖）…"
  bash "$ROOT/build.sh"
else
  echo "[1/8] 跳过构建，复用 production-code/"
  for sub in web daemon; do
    if [ ! -f "$ROOT/production-code/$sub/app.js" ]; then
      echo "production-code/$sub/app.js 不存在，--skip-build 无从复用；先跑一次不带该参数的打包" >&2
      exit 1
    fi
  done
fi

echo "[2/8] 装配 ${STAGE#"$ROOT"/} …"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r "$ROOT/production-code/web" "$STAGE/web"
cp -r "$ROOT/production-code/daemon" "$STAGE/daemon"

# rollup-plugin-visualizer 在 frontend/vite.config.ts 里是无条件启用的，每次构建都会产出
# 一个 2.5MB 的 stats.html。它会被 panel 的 koa-static 照常对外服务
# (http://<panel>:23333/stats.html)，把整个前端模块结构和源码路径公开出去，所以不进发布包。
rm -f "$STAGE/web/public/stats.html"

echo "[3/8] 写版本号: web/package.json(version, daemonVersion) 与 daemon/package.json(version)…"
node -e '
const fs = require("fs");
const [stage, version] = process.argv.slice(1);
const stamp = (file, keys) => {
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const key of keys) pkg[key] = version;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
};
stamp(`${stage}/web/package.json`, ["version", "daemonVersion"]);
stamp(`${stage}/daemon/package.json`, ["version"]);
' "$STAGE" "$VERSION"

if [ "$SKIP_LIB" -eq 0 ]; then
  echo "[4/8] 准备 daemon/lib 二进制（pty / 7z / file_zip，全架构；走 http_proxy 环境变量）…"
  LIB_CACHE="$OUT/.lib-cache"
  mkdir -p "$LIB_CACHE" "$STAGE/daemon/lib"
  # 清单与 dockerfile/daemon.dockerfile 共用。缓存在 dist-release/.lib-cache/，
  # 重复打包就不必再下一遍（-nc 跳过已存在的文件）。
  find "$LIB_CACHE" -type f -empty -delete # 上次下载中断留下的 0 字节文件，-nc 不会重下
  wget -q -nc --tries=3 --timeout=60 --input-file="$ROOT/lib-urls.txt" \
    --directory-prefix="$LIB_CACHE"
  cp -f "$LIB_CACHE"/* "$STAGE/daemon/lib/"
  chmod a+x "$STAGE/daemon/lib"/*
else
  echo "[4/8] 跳过 lib 二进制下载 —— 这个包不能部署（daemon 启动会因缺 file_zip 直接退出），仅用于验证打包流程"
fi

echo "[5/8] 收集部署脚本与特权配置…"
cp -r "$ROOT/prod-scripts" "$STAGE/prod-scripts"
if [ -d "$ROOT/deploy" ]; then
  cp -r "$ROOT/deploy/." "$STAGE/"
else
  echo "      提示: deploy/ 尚不存在（install.sh / update.sh / systemd 模板是下一阶段的内容），本包内暂不含部署脚本"
fi

echo "[6/8] 写 VERSION …"
{
  printf 'version=%s\n' "$VERSION"
  printf 'commit=%s\n' "$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  printf 'built_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'node_required=20\n'
  printf 'arch=x64,arm64\n'
} >"$STAGE/VERSION"

echo "[7/8] 校验包内清单…"
missing=0
check() {
  if [ ! -e "$STAGE/$1" ]; then
    echo "      缺失: $1" >&2
    missing=1
  fi
}

for entry in \
  VERSION \
  web/app.js web/package.json web/public/index.html \
  web/node_modules/koa/package.json \
  daemon/app.js daemon/package.json \
  daemon/node_modules/koa/package.json \
  prod-scripts/ci-panel-runner-svc \
  prod-scripts/install-runner-privileges.sh; do
  check "$entry"
done

if [ "$SKIP_LIB" -eq 0 ]; then
  for arch in x64 arm64; do
    check "daemon/lib/pty_linux_$arch"
    check "daemon/lib/7z_linux_$arch"
    check "daemon/lib/file_zip_linux_$arch"
  done
fi

# 版本号必须真的落到那三个字段上，否则节点"待更新"告警会常亮或永不亮
if ! node -e '
const fs = require("fs");
const [stage, want] = process.argv.slice(1);
const web = JSON.parse(fs.readFileSync(`${stage}/web/package.json`, "utf8"));
const daemon = JSON.parse(fs.readFileSync(`${stage}/daemon/package.json`, "utf8"));
const got = {
  "web.version": web.version,
  "web.daemonVersion": web.daemonVersion,
  "daemon.version": daemon.version
};
const bad = Object.entries(got).filter(([, value]) => value !== want);
if (bad.length) {
  console.error("      版本号未写入: " + bad.map(([k, v]) => `${k}=${v}`).join(", "));
  process.exit(1);
}
' "$STAGE" "$VERSION"; then
  missing=1
fi

if [ "$missing" -ne 0 ]; then
  echo "包内容不完整，已中止（stage 保留在 ${STAGE#"$ROOT"/} 便于排查）" >&2
  exit 1
fi

echo "[8/8] 打包与校验和…"
rm -f "$TARBALL" "$TARBALL.sha256"
tar -C "$OUT" --owner=0 --group=0 --numeric-owner -czf "$TARBALL" "ci-panel-$VERSION"
(cd "$OUT" && sha256sum "$(basename "$TARBALL")" >"$(basename "$TARBALL").sha256")

echo
echo "完成: ${TARBALL#"$ROOT"/}"
echo "      大小 $(du -h "$TARBALL" | cut -f1)   sha256 $(cut -d' ' -f1 "$TARBALL.sha256")"
echo "下一步: bash scripts/release/smoke-test.sh ${TARBALL#"$ROOT"/}"
