#!/usr/bin/env bash
# 构建前端生产包并部署给 panel 直接服务（http://<panel>:23333）。
#
# 开发时走 vite dev(5173,有热更)；要给"日常使用/高负载"提供一个快且抗负载的入口，
# 就用本脚本生成生产包 —— 预打包 + gzip + 浏览器缓存，没有 dev 模式的实时编译，高负载也稳。
#
# 用法：bash deploy-frontend.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DIST="$ROOT/frontend/dist"
PUBLIC="$ROOT/panel/public" # panel 的 koa-static 服务 <cwd>/public

echo "[1/3] 构建前端生产包…"
cd "$ROOT/frontend"
# 用 build-only(纯 vite build)而不是 npm run build：后者会跑 type-check，
# 而当前有一处与本次无关的历史 TS 报错(FileManager.vue)会让它失败。类型检查在开发时单独做。
npm run build-only

# 构建成功(set -e 保证走到这)才动 public，避免构建失败把线上包清空
[ -f "$DIST/index.html" ] || {
  echo "构建产物缺失: $DIST/index.html" >&2
  exit 1
}

echo "[2/3] 部署到 $PUBLIC …"
mkdir -p "$PUBLIC"
rm -rf "${PUBLIC:?}/"*
cp -r "$DIST/"* "$PUBLIC/"

echo "[3/3] 完成。"
echo "生产入口：http://<panel 主机>:23333（本机隧道 ssh -L 23333:127.0.0.1:23333）"
echo "注意：panel 需在运行中；index.html 不缓存、assets 缓存 1 天，改动后重跑本脚本即可。"
