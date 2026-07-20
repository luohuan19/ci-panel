// CI Panel 扩展路由：一键 provision GitHub Actions runner。
import logger from "../service/log";
import * as protocol from "../service/protocol";
import { routerApp } from "../service/router";
import {
  checkRunnerPackage,
  collectRunners,
  getRunnerBatchProgress,
  getRunnerDownloadProgress,
  provisionRunner,
  provisionRunnerBatch,
  retryFailedBatch,
  startRunnerBatch,
  startRunnerDownload
} from "../service/runner_provision";
import {
  controlService,
  registerRunners,
  scanManagedRunners,
  scanOneRunner,
  scanRunners,
  unregisterRunner,
  type SystemdAction
} from "../service/runner_scan";
import { readRunnerDiag } from "../service/runner_logs";
import { getNpuStatus } from "../service/npu_monitor";

// 扫描磁盘上真实存在的 runner：读 .runner 拿仓库归属，读 .service 查 systemd 状态。
// 只读，不建实例——跟 runner/collect 的区别就在这里。
routerApp.on("runner/scan", (ctx, data) => {
  try {
    const roots = Array.isArray(data?.roots) ? data.roots.map((v: any) => String(v)) : undefined;
    protocol.msg(ctx, "runner/scan", scanRunners(roots));
  } catch (err: any) {
    protocol.error(ctx, "runner/scan", { err: err?.message || String(err) });
  }
});

// 只列出已纳管（有 .cipanel）的 runner，供日常展示。membership 以 marker 为准，
// 不像 runner/scan 那样把磁盘上所有 .runner 都算进来。
routerApp.on("runner/managed_list", (ctx, data) => {
  try {
    const roots = Array.isArray(data?.roots) ? data.roots.map((v: any) => String(v)) : undefined;
    protocol.msg(ctx, "runner/managed_list", scanManagedRunners(roots));
  } catch (err: any) {
    protocol.error(ctx, "runner/managed_list", { err: err?.message || String(err) });
  }
});

// 纳管：给选中的目录写 .cipanel（只标记，不建实例）。source 缺省为 import
routerApp.on("runner/register", (ctx, data) => {
  try {
    const items = Array.isArray(data?.items) ? data.items : [];
    const source = data?.source === "provision" ? "provision" : "import";
    protocol.msg(ctx, "runner/register", { results: registerRunners(items, source) });
  } catch (err: any) {
    protocol.error(ctx, "runner/register", { err: err?.message || String(err) });
  }
});

// 取消纳管：删 .cipanel（不动 runner 本身）
routerApp.on("runner/unregister", (ctx, data) => {
  try {
    protocol.msg(ctx, "runner/unregister", unregisterRunner(String(data?.dir || "")));
  } catch (err: any) {
    protocol.error(ctx, "runner/unregister", { err: err?.message || String(err) });
  }
});

// 读 runner 的 _diag 运行日志（只读，免 sudo）——给 systemd runner 也能在网页看控制台。
// 支持增量跟随：带 offset 回来只回读新增段。
routerApp.on("runner/diag_logs", (ctx, data) => {
  try {
    const result = readRunnerDiag(String(data?.dir || ""), {
      file: data?.file,
      lines: data?.lines,
      offset: data?.offset
    });
    protocol.msg(ctx, "runner/diag_logs", result);
  } catch (err: any) {
    protocol.error(ctx, "runner/diag_logs", { err: err?.message || String(err) });
  }
});

// 本节点的 NPU(昇腾)占用率。只读后台采样的缓存，不会阻塞请求；
// 首次请求会拉起采样，没人看时自动停（详见 npu_monitor）。
routerApp.on("npu/status", (ctx) => {
  try {
    protocol.msg(ctx, "npu/status", getNpuStatus());
  } catch (err: any) {
    protocol.error(ctx, "npu/status", { err: err?.message || String(err) });
  }
});

// 探单个 runner 的实时状态（详情页基本信息 + 定时刷新用）
routerApp.on("runner/state", (ctx, data) => {
  try {
    protocol.msg(ctx, "runner/state", { runner: scanOneRunner(String(data?.dir || "")) });
  } catch (err: any) {
    protocol.error(ctx, "runner/state", { err: err?.message || String(err) });
  }
});

// 启停 systemd 托管的 runner。需要 sudoers 免密白名单
routerApp.on("runner/service_control", (ctx, data) => {
  try {
    const service = String(data?.service || "");
    const action = String(data?.action || "") as SystemdAction;
    protocol.msg(ctx, "runner/service_control", controlService(service, action));
  } catch (err: any) {
    protocol.error(ctx, "runner/service_control", { err: err?.message || String(err) });
  }
});

// 开始下载最新/指定版本的 runner 安装包，返回 downloadId
routerApp.on("runner/download_start", async (ctx, data) => {
  try {
    const result = await startRunnerDownload({
      version: data?.version,
      proxy: data?.proxy,
      force: data?.force
    });
    protocol.msg(ctx, "runner/download_start", result);
  } catch (err: any) {
    protocol.error(ctx, "runner/download_start", { err: err?.message || String(err) });
  }
});

// 查询下载进度 + 速度
routerApp.on("runner/download_progress", (ctx, data) => {
  try {
    const result = getRunnerDownloadProgress(data?.downloadId);
    protocol.msg(ctx, "runner/download_progress", result);
  } catch (err: any) {
    protocol.error(ctx, "runner/download_progress", { err: err?.message || String(err) });
  }
});

// 检查：direct 查内置包版本/更新；import 查压缩包路径是否存在
routerApp.on("runner/check", async (ctx, data) => {
  try {
    const result = await checkRunnerPackage({
      mode: data?.mode,
      packagePath: data?.packagePath,
      proxy: data?.proxy
    });
    protocol.msg(ctx, "runner/check", result);
  } catch (err: any) {
    protocol.error(ctx, "runner/check", { err: err?.message || String(err) });
  }
});

routerApp.on("runner/provision", async (ctx, data) => {
  try {
    const result = await provisionRunner({
      repoUrl: data?.repoUrl,
      token: data?.token,
      name: data?.name,
      labels: data?.labels,
      targetDir: data?.targetDir,
      proxy: data?.proxy
    });
    protocol.msg(ctx, "runner/provision", result);
  } catch (err: any) {
    logger.error(`[runner-provision] 失败: ${err?.message}`);
    protocol.error(ctx, "runner/provision", { err: err?.message || String(err) });
  }
});

// 批量：多组标签，每组 <基础名>-1..-N（同步，一次性返回全部结果）
routerApp.on("runner/provision_batch", async (ctx, data) => {
  try {
    const result = await provisionRunnerBatch({
      repoUrl: data?.repoUrl,
      token: data?.token,
      proxy: data?.proxy,
      baseDir: data?.baseDir,
      groups: data?.groups,
      packagePath: data?.packagePath
    });
    protocol.msg(ctx, "runner/provision_batch", result);
  } catch (err: any) {
    logger.error(`[runner-provision] 批量失败: ${err?.message}`);
    protocol.error(ctx, "runner/provision_batch", { err: err?.message || String(err) });
  }
});

// 批量（异步）：启动后台任务，立刻返回 batchId + 初始清单
routerApp.on("runner/batch_start", (ctx, data) => {
  try {
    const result = startRunnerBatch({
      repoUrl: data?.repoUrl,
      token: data?.token,
      proxy: data?.proxy,
      baseDir: data?.baseDir,
      groups: data?.groups,
      packagePath: data?.packagePath
    });
    protocol.msg(ctx, "runner/batch_start", result);
  } catch (err: any) {
    logger.error(`[runner-provision] 批量启动失败: ${err?.message}`);
    protocol.error(ctx, "runner/batch_start", { err: err?.message || String(err) });
  }
});

// 查询批量进度（每个 runner 的状态 + 当前步骤）
routerApp.on("runner/batch_progress", (ctx, data) => {
  try {
    const result = getRunnerBatchProgress(data?.batchId);
    protocol.msg(ctx, "runner/batch_progress", result);
  } catch (err: any) {
    protocol.error(ctx, "runner/batch_progress", { err: err?.message || String(err) });
  }
});

// 重试某批的失败项（用新 token 重跑，复用同一 batchId 的进度轮询）
routerApp.on("runner/batch_retry", (ctx, data) => {
  try {
    const result = retryFailedBatch(data?.batchId, data?.token, data?.proxy);
    protocol.msg(ctx, "runner/batch_retry", result);
  } catch (err: any) {
    protocol.error(ctx, "runner/batch_retry", { err: err?.message || String(err) });
  }
});

// 收集：扫描基目录，把已注册但未建实例的 runner 纳入看护
routerApp.on("runner/collect", (ctx, data) => {
  try {
    const result = collectRunners(data?.baseDir);
    protocol.msg(ctx, "runner/collect", result);
  } catch (err: any) {
    protocol.error(ctx, "runner/collect", { err: err?.message || String(err) });
  }
});
