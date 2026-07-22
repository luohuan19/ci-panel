// CI Panel 扩展：一键 provision GitHub Actions runner。转发到指定 daemon 执行。
import Router from "@koa/router";
import axios from "axios";
import { ROLE } from "../entity/user";
import permission from "../middleware/permission";
import validator from "../middleware/validator";
import RemoteRequest from "../service/remote_command";
import RemoteServiceSubsystem from "../service/remote_service";
import RepoService from "../service/repo_service";
import { parseRepoSlug } from "../entity/repo";
import { logger } from "../service/log";

// 创建 runner 时自动把其仓库纳管进注册表（若还没有）。不带 PAT——回退全局 token，用户之后可补填。
// 用面板给某仓库建 runner，显然是要管它，仓库就该自动登记，免得列表里显示误导性的"未纳管"。
function ensureRepoRegistered(repoUrl: string) {
  try {
    const slug = parseRepoSlug(String(repoUrl || ""));
    if (slug && !RepoService.has(slug)) {
      RepoService.add(slug, "", "创建 runner 时自动纳管");
      logger.info(`创建 runner 时自动纳管仓库：${slug}`);
    }
  } catch (err: any) {
    // 自动纳管失败不该阻断建 runner
    logger.warn(`自动纳管仓库失败：${err?.message || err}`);
  }
}

const router = new Router({ prefix: "/runner" });

// 有界并发：对 items 并行跑 worker，最多 limit 个同时在飞，保序返回结果。
// 批量删除/启停时用，避免一次性对 daemon 和 GitHub 打满请求。
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// 把前端传来的并发数收敛到 [1, 10]，非法值回落到默认 5。
function clampConcurrency(v: unknown, def = 5): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 10) : def;
}

// [Top-level Permission]
// 开始下载最新/指定版本的 runner 安装包
router.post(
  "/download_start",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/download_start",
        ctx.request.body,
        30000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 查询下载进度
router.post(
  "/download_progress",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/download_progress",
        ctx.request.body,
        15000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 检查安装包：direct 查版本/更新；import 查路径是否存在
router.post(
  "/check",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const config = ctx.request.body;
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request("runner/check", config, 20000);
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 在指定节点上准备并注册一个 runner，然后创建对应实例（不自动启动）
router.post(
  "/provision",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const config = ctx.request.body;
      ensureRepoRegistered((config as any)?.repoUrl);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      // config.sh 注册可能耗时数十秒，给足超时
      const result = await new RemoteRequest(remoteService).request("runner/provision", config, 180000);
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 批量：多组标签，每组 <基础名>-1..-N，逐个注册并建实例
router.post(
  "/provision_batch",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const config = ctx.request.body;
      ensureRepoRegistered((config as any)?.repoUrl);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      // 批量可能几分钟，给足超时（10 分钟）
      const result = await new RemoteRequest(remoteService).request(
        "runner/provision_batch",
        config,
        600000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 批量（异步）：启动后台任务，立刻返回 batchId
router.post(
  "/batch_start",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      ensureRepoRegistered((ctx.request.body as any)?.repoUrl);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/batch_start",
        ctx.request.body,
        30000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 查询批量进度
router.post(
  "/batch_progress",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/batch_progress",
        ctx.request.body,
        15000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 重试某批的失败项
router.post(
  "/batch_retry",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/batch_retry",
        ctx.request.body,
        30000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 收集：扫描基目录纳入未看护的已注册 runner
router.post(
  "/collect",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/collect",
        ctx.request.body,
        60000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 只读：列出某仓库在基目录下已有的 label 组（供前端复用标签、锁定命名）
router.post(
  "/repo_groups",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/repo_groups",
        ctx.request.body,
        30000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 扫描节点磁盘上真实存在的 runner（只读，不建实例）
router.post(
  "/scan",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/scan",
        ctx.request.body,
        30000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 纳管：给选中的 runner 目录写 .cipanel（只标记，不建实例）
router.post(
  "/register",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/register",
        ctx.request.body,
        30000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 取消纳管：删 .cipanel（不动 runner 本身）
router.post(
  "/unregister",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/unregister",
        ctx.request.body,
        30000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// 取仓库的 GitHub「删除 token」：手输优先，留空则用仓库 PAT 自动取；都没有返回空串
// （空串时 daemon 会跳过 GitHub 注销并回报警告，不阻断本地删除）。删除 token 仓库级、
// 一小时内可复用，所以批量删除整批共用一个。
async function resolveRemoveToken(repo: string, manual?: string): Promise<string> {
  const token = String(manual || "").trim();
  if (token) return token;
  if (!repo) return "";
  const pat = RepoService.tokenOf(repo);
  if (!pat) return "";
  try {
    const { data } = await axios.post(
      `https://api.github.com/repos/${repo}/actions/runners/remove-token`,
      {},
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${pat}`,
          "User-Agent": "ci-panel"
        },
        proxy: false,
        timeout: 15000
      }
    );
    return data?.token || "";
  } catch {
    return "";
  }
}

// [Top-level Permission]
// 彻底删除一个 runner。先取 GitHub「删除 token」交给 daemon 走 config.sh remove 注销；
// 取不到 token 不阻断，daemon 会跳过 GitHub 注销并回报警告。
router.post(
  "/delete",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const body = (ctx.request.body || {}) as {
        dir?: string;
        repo?: string;
        force?: boolean;
        removeToken?: string;
      };
      const removeToken = await resolveRemoveToken(String(body.repo || ""), body.removeToken);

      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/delete",
        { dir: body.dir, removeToken, force: Boolean(body.force) },
        60000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 批量删除一个仓库（在某节点上）的全部 runner。整批共用一个删除 token；逐个删，互不影响，
// 汇总每个的结果（含正在跑 job 而被拦下的）。
router.post(
  "/delete_batch",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const body = (ctx.request.body || {}) as {
        repo?: string;
        dirs?: string[];
        force?: boolean;
        removeToken?: string;
        concurrency?: number;
      };
      const dirs = Array.isArray(body.dirs) ? body.dirs.map((d) => String(d)) : [];
      if (dirs.length === 0) {
        ctx.body = { results: [] };
        return;
      }
      const removeToken = await resolveRemoveToken(String(body.repo || ""), body.removeToken);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);

      // 每个删除互不影响，有界并发跑；removeToken 已在池外解析一次共用，并行安全。
      const results = await mapWithConcurrency(
        dirs,
        clampConcurrency(body.concurrency),
        async (dir) => {
          try {
            const r = await new RemoteRequest(remoteService).request(
              "runner/delete",
              { dir, removeToken, force: Boolean(body.force) },
              60000
            );
            return { dir, ...r };
          } catch (err: any) {
            return { dir, ok: false, error: err?.message || String(err) };
          }
        }
      );
      ctx.body = { results };
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 基目录选择器：列目录 / 新建目录（daemon 侧限扫描根内）
for (const op of ["list_dirs", "mkdir"] as const) {
  router.post(
    `/${op}`,
    permission({ level: ROLE.ADMIN }),
    validator({ query: { daemonId: String } }),
    async (ctx) => {
      try {
        const daemonId = String(ctx.query.daemonId);
        const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
        ctx.body = await new RemoteRequest(remoteService).request(
          `runner/${op}`,
          ctx.request.body,
          15000
        );
      } catch (err) {
        ctx.body = err;
      }
    }
  );
}

// [Top-level Permission]
// 探单个 runner 的实时状态（详情页用）
router.post(
  "/state",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/state",
        ctx.request.body,
        30000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 读 runner 的 _diag 运行日志（看控制台，只读）
router.post(
  "/diag_logs",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/diag_logs",
        ctx.request.body,
        30000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 启停 systemd 托管的 runner
router.post(
  "/service_control",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request(
        "runner/service_control",
        ctx.request.body,
        90000
      );
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 批量启停/重启 systemd 托管的 runner。每个独立、无共享锁，panel 侧有界并发扇出到单个
// service_control；无 service 的项直接跳过。逐个 catch 汇总结果，互不影响。
router.post(
  "/service_control_batch",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { daemonId: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const body = (ctx.request.body || {}) as {
        items?: Array<{ dir?: string; service?: string }>;
        action?: string;
        concurrency?: number;
      };
      const action = String(body.action || "");
      if (!["start", "stop", "restart"].includes(action)) {
        ctx.body = { results: [], error: "invalid action" };
        return;
      }
      const items = (Array.isArray(body.items) ? body.items : []).filter(
        (it) => it && it.service
      ); // 无 service 的不发（面板管不了它的启停）
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);

      const results = await mapWithConcurrency(
        items,
        clampConcurrency(body.concurrency),
        async (it) => {
          try {
            const r = await new RemoteRequest(remoteService).request(
              "runner/service_control",
              { service: it.service, action },
              90000
            );
            return { dir: it.dir, service: it.service, ok: true, ...r };
          } catch (err: any) {
            return {
              dir: it.dir,
              service: it.service,
              ok: false,
              error: err?.message || String(err)
            };
          }
        }
      );
      ctx.body = { results };
    } catch (err: unknown) {
      // 保持批量接口的 { results } 契约：前端读 results，不能静默返回空对象而误报成功
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(msg);
      ctx.body = { results: [], error: msg };
    }
  }
);

export default router;
