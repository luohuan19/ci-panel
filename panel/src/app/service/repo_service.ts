// 仓库注册表（自研补充，非 MCSManager 原生）。
//
// 落盘在 panel/data/RepoConfig/<owner@repo>.json，回答「当前有哪些仓库被纳入管理」。
//
// 「每个仓库有哪些 runner」刻意不在这里存第二份，而是每次去各节点扫磁盘（runner/scan）：
// runner 的归属写在它自己目录下的 .runner 文件里（GitHub 官方 runner 注册时写的），
// 托管方式写在 .service 里。这才是全集——机器上大多数 runner 由 systemd 托管，
// 面板的实例表里压根没有它们，只查实例会漏掉一大半。
// 注册表只管仓库本身（URL、PAT、备注），两份数据各管一头，不会打架。
import StorageSubsystem from "../common/system_storage";
import {
  fileIdToSlug,
  isValidSlug,
  parseRepoSlug,
  RepoConfig,
  repoUrlOf,
  slugToFileId
} from "../entity/repo";
import { logger } from "./log";
import RemoteRequest from "./remote_command";
import RemoteServiceSubsystem from "./remote_service";
import { $t } from "../i18n";
import { errMessage } from "../utils/error";

const CATEGORY = "RepoConfig";

// 对齐 daemon 侧 Instance.STATUS_RUNNING
const INSTANCE_STATUS_RUNNING = 3;

export interface RepoRunnerRef {
  daemonId: string;
  nodeName: string;
  dir: string;
  dirName: string;
  agentName: string; // runner 在 GitHub 上的名字（未必等于目录名）
  managedBy: "systemd" | "panel" | "both" | "none";
  service: string; // systemd 单元名，空 = 没装服务
  instanceUuid: string; // 面板实例，空 = 面板没托管
  running: boolean;
  busy: boolean; // 正在跑 job——停它会中断 CI 任务
  statusText: string; // 给 UI 直接显示的状态
  since: string; // systemd 主进程启动时间
  source: "provision" | "import" | ""; // .cipanel 里的纳管来源
  group: string; // .cipanel 里的所属组
  markerId: string; // .cipanel 里的管理标识
  broken?: string;
}

export interface RunnerIndex {
  // slug -> 该仓库在所有节点上的 runner
  bySlug: Map<string, RepoRunnerRef[]>;
  // .runner 解析不出仓库的（目录坏了），无法归属
  untagged: RepoRunnerRef[];
  // 掉线/扫描失败的节点，让前端知道这次聚合是不完整的
  failedNodes: Array<{ daemonId: string; nodeName: string; error: string }>;
}

// 把 daemon 扫描结果转成面板视角的 runner 引用
function toRunnerRef(daemonId: string, nodeName: string, r: any): RepoRunnerRef {
  const systemd = r.systemd || null;
  const managedBy = r.managedBy as RepoRunnerRef["managedBy"];

  let running = false;
  let statusText = "";
  if (systemd?.loaded) {
    running = systemd.activeState === "active";
    statusText = `${systemd.activeState}/${systemd.subState}`;
  } else if (r.instanceUuid) {
    running = r.instanceStatus === INSTANCE_STATUS_RUNNING;
    statusText = running ? "运行中（面板实例）" : "已停止（面板实例）";
  } else {
    statusText = "无人托管";
  }

  return {
    daemonId,
    nodeName,
    dir: r.dir || "",
    dirName: r.dirName || "",
    agentName: r.agentName || "",
    managedBy,
    service: systemd?.service || "",
    instanceUuid: r.instanceUuid || "",
    running,
    busy: Boolean(r.busy),
    statusText,
    since: systemd?.since || "",
    source: r.source || "",
    group: r.group || "",
    markerId: r.markerId || "",
    broken: r.broken
  };
}

class RepoService {
  private repos = new Map<string, RepoConfig>(); // key: slug

  constructor() {
    this.loadAll();
  }

  private loadAll() {
    for (const fileId of StorageSubsystem.list(CATEGORY)) {
      const slug = fileIdToSlug(fileId);
      try {
        const config = StorageSubsystem.load(CATEGORY, RepoConfig, fileId) as RepoConfig | null;
        if (config?.slug) this.repos.set(config.slug, config);
      } catch (err: any) {
        logger.error(`仓库注册表加载失败 (${slug}): ${err.message}`);
      }
    }
  }

  public list(): RepoConfig[] {
    return Array.from(this.repos.values()).sort((a, b) => (a.slug > b.slug ? 1 : -1));
  }

  public get(slug: string): RepoConfig | undefined {
    return this.repos.get(slug);
  }

  public has(slug: string) {
    return this.repos.has(slug);
  }

  // 该仓库调 GitHub API 用的 PAT：优先用仓库自己的，回退到全局环境变量
  public tokenOf(slug: string): string {
    return this.repos.get(slug)?.token || process.env.CIP_GITHUB_TOKEN || "";
  }

  // 纳管一个仓库。repoUrl 可以是完整 URL 也可以是 owner/repo
  public add(repoUrl: string, token = "", remark = ""): RepoConfig {
    const slug = parseRepoSlug(repoUrl);
    if (!slug) throw new Error(`无法解析仓库地址：${repoUrl}`);
    if (this.repos.has(slug)) throw new Error(`仓库 ${slug} 已纳管`);

    const config = new RepoConfig();
    config.slug = slug;
    config.url = repoUrlOf(slug);
    config.token = token;
    config.remark = remark;
    config.createdAt = Date.now();

    StorageSubsystem.store(CATEGORY, slugToFileId(slug), config);
    this.repos.set(slug, config);
    logger.info(`仓库纳管：${slug}`);
    return config;
  }

  // token 传 undefined 表示不改；传空串表示清空（回退全局 token）
  public update(slug: string, patch: { token?: string; remark?: string }): RepoConfig {
    const config = this.repos.get(slug);
    if (!config) throw new Error(`仓库 ${slug} 未纳管`);
    if (patch.token !== undefined) config.token = patch.token;
    if (patch.remark !== undefined) config.remark = patch.remark;
    StorageSubsystem.store(CATEGORY, slugToFileId(slug), config);
    return config;
  }

  // 只摘掉纳管关系，不动任何 runner 实例——删仓库不该悄悄删机器上的东西。
  //
  // 名下还有已纳管 runner 时直接拒绝：backfillRegistry 确立的不变量是「有已纳管 runner
  // 的仓库必然在注册表里」，此时删掉的话，下一次 /api/repo/list 会立刻把它补回来 ——
  // 删除看似成功、刷新一下又回来了，比明确报错难排查得多。要真的摘掉，先取消这些 runner
  // 的纳管（删 .cipanel），仓库自然就没有归属它的 runner 了。
  public async remove(slug: string) {
    if (!isValidSlug(slug)) throw new Error(`非法的仓库标识：${slug}`);
    if (!this.repos.has(slug)) throw new Error(`仓库 ${slug} 未纳管`);
    const index = await this.collectRunners();
    // 有节点扫不到就不能判断——它上面可能正有该仓库的 runner。这时删掉，等节点恢复后
    // backfillRegistry 又会把仓库补回来，就成了"删完过一会自己回来了"。
    if (index.failedNodes.length > 0) {
      throw new Error(
        $t("TXT_CODE_REPO_REMOVE_NODE_UNREACHABLE", {
          slug,
          nodes: index.failedNodes.map((n) => n.nodeName).join("、")
        })
      );
    }
    const runners = index.bySlug.get(slug) || [];
    if (runners.length > 0) {
      throw new Error(
        $t("TXT_CODE_REPO_REMOVE_HAS_RUNNERS", { slug, count: runners.length })
      );
    }
    StorageSubsystem.delete(CATEGORY, slugToFileId(slug));
    this.repos.delete(slug);
    logger.info(`仓库取消纳管：${slug}`);
  }

  // 跨所有节点收集「已纳管」的 runner（带 .cipanel 的），按仓库地址归堆。
  // 用 runner/managed_list 而不是 runner/scan：membership 以 marker 为准，日常展示只看面板
  // 纳管过的那些；机器上没纳管的 runner（含 systemd 手装的）不在这里冒出来，要显式导入。
  public async collectRunners(): Promise<RunnerIndex> {
    const bySlug = new Map<string, RepoRunnerRef[]>();
    const untagged: RepoRunnerRef[] = [];
    const failedNodes: RunnerIndex["failedNodes"] = [];

    await Promise.all(
      Array.from(RemoteServiceSubsystem.services.values()).map(async (node) => {
        const nodeName = node.config.remarks || `${node.config.ip}:${node.config.port}`;
        try {
          // 不传 roots，用 daemon 侧的默认扫描根（CIP_SCAN_ROOTS）
          const result = await new RemoteRequest(node).request("runner/managed_list", {}, 30000);
          for (const scanned of result?.runners || []) {
            const ref = toRunnerRef(node.uuid, nodeName, scanned);
            const slug = String(scanned.repo || "");
            if (!slug) {
              untagged.push(ref);
              continue;
            }
            if (!bySlug.has(slug)) bySlug.set(slug, []);
            bySlug.get(slug)?.push(ref);
          }
        } catch (err: any) {
          failedNodes.push({ daemonId: node.uuid, nodeName, error: err.message });
        }
      })
    );

    return { bySlug, untagged, failedNodes };
  }

  // 自愈：有已纳管 runner 的仓库必然是被管理的仓库，补登记历史遗漏的那些。
  //
  // 导入 / provision 现在都会在纳管 runner 时顺手登记仓库（见 runner_router 的
  // ensureRepoRegistered），但更早导入的 runner 只写了 .cipanel、没碰注册表，
  // 仓库列表里会一直挂着误导性的"未纳管"，而 UI 上又没有补登记的入口。
  // 幂等：has() 挡住重复写盘，每个仓库只落一次。
  // 非法 slug（.runner 坏了解析出怪字符串）跳过，仍会留在 unregistered 里，别写进文件名。
  private backfillRegistry(slugs: Iterable<string>) {
    for (const slug of slugs) {
      if (!isValidSlug(slug) || this.repos.has(slug)) continue;
      try {
        this.add(slug, "", $t("TXT_CODE_REPO_AUTO_REGISTER_BACKFILL"));
      } catch (err: unknown) {
        // 补登记失败不该让仓库列表整个挂掉
        logger.warn(`仓库自动补登记失败 (${slug}): ${errMessage(err)}`);
      }
    }
  }

  // 注册表 + 实时 runner 分布。token 在这里就脱敏，绝不出 service。
  public async listWithRunners() {
    const index = await this.collectRunners();
    this.backfillRegistry(index.bySlug.keys());

    const summarize = (runners: RepoRunnerRef[]) => ({
      runners,
      total: runners.length,
      running: runners.filter((r) => r.running).length,
      busy: runners.filter((r) => r.busy).length,
      // 已注册但没人托管的 runner：既没 systemd 服务、面板也没托管，永远接不到任务
      orphaned: runners.filter((r) => r.managedBy === "none").length,
      // systemd 和面板同时托管同一个目录：会跑起两个 Runner.Listener 抢同一个身份
      conflicted: runners.filter((r) => r.managedBy === "both").length
    });

    const repos = this.list().map((config) => ({
      slug: config.slug,
      url: config.url,
      remark: config.remark,
      createdAt: config.createdAt,
      hasToken: Boolean(config.token),
      ...summarize(index.bySlug.get(config.slug) || [])
    }));

    // 磁盘上有 runner、但注册表里没有的仓库。backfillRegistry 之后这里通常是空的，
    // 只会剩下 slug 非法（.runner 坏了）而无法落盘的那些。
    const unregistered = Array.from(index.bySlug.entries())
      .filter(([slug]) => !this.repos.has(slug))
      .map(([slug, runners]) => ({
        slug,
        url: isValidSlug(slug) ? repoUrlOf(slug) : "",
        ...summarize(runners)
      }));

    return {
      repos,
      unregistered,
      untaggedRunners: index.untagged,
      failedNodes: index.failedNodes
    };
  }

  // 首次启动时把 CIP_GITHUB_REPOS 里的仓库导进来，让老配置不至于凭空消失。
  // 注册表非空就不再碰环境变量——注册表一旦启用就是唯一真相源。
  public migrateFromEnv() {
    if (this.repos.size > 0) return;
    const raw = process.env.CIP_GITHUB_REPOS || "";
    for (const item of raw.split(",")) {
      const slug = parseRepoSlug(item);
      if (!slug) continue;
      try {
        this.add(slug, "", "自 CIP_GITHUB_REPOS 迁移");
      } catch (err: any) {
        logger.error(`迁移仓库失败 (${item}): ${err.message}`);
      }
    }
  }
}

const repoService = new RepoService();
repoService.migrateFromEnv();

export default repoService;
