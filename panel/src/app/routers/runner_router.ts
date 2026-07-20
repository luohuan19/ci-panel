// CI Panel 扩展：一键 provision GitHub Actions runner。转发到指定 daemon 执行。
import Router from "@koa/router";
import { ROLE } from "../entity/user";
import permission from "../middleware/permission";
import validator from "../middleware/validator";
import RemoteRequest from "../service/remote_command";
import RemoteServiceSubsystem from "../service/remote_service";

const router = new Router({ prefix: "/runner" });

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

// [Top-level Permission]
// 所有节点的 NPU 占用率，聚合成 { daemonId: NpuStatus } —— 节点卡片一次拿全，
// 免得前端按节点逐个请求。单个节点取不到（掉线/没 npu-smi）只标记它自己，不拖累整体。
router.post("/npu_status", permission({ level: ROLE.ADMIN }), async (ctx) => {
  const result: Record<string, any> = {};
  await Promise.all(
    Array.from(RemoteServiceSubsystem.services.values()).map(async (node) => {
      try {
        result[node.uuid] = await new RemoteRequest(node).request("npu/status", {}, 10000);
      } catch (err: any) {
        result[node.uuid] = { available: false, error: err?.message || String(err) };
      }
    })
  );
  ctx.body = result;
});

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

export default router;
