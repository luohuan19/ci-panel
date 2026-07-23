// CI Panel 扩展：以文件系统为真相源，扫描机器上真实存在的 GitHub Actions runner。
//
// 为什么需要它：runner 的归属和状态，权威记录都在磁盘上，而不在面板的数据库里。
//   <runner 目录>/.runner   —— GitHub 官方 runner 注册时写的，含 gitHubUrl（属于哪个仓库）和 agentName
//   <runner 目录>/.service  —— 单元安装时写的，内容是 systemd 单元名
//   <runner 目录>/.cipanel  —— 面板纳管标记（membership 的唯一真相源，见 runner_marker）
//
// 托管方式只认 systemd：面板实例一律只是「句柄」（不带启动命令、不跑 runner），
// 所以 managedBy 只会是 systemd 或 none。日常展示只列带 .cipanel 的（scanManagedRunners），
// 全盘发现（scanRunners）只给「导入」用。
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import fs from "fs-extra";
import path from "path";

// 异步版 execFile：扫描热路径(每 10s 一次)用它，避免同步调用卡住 daemon 单线程事件循环——
// systemctl 走 dbus、机器一忙偶发能卡几秒，同步跑就会丢 WebSocket 心跳→面板判定掉线→刷新卡。
const execFileAsync = promisify(execFile);
import InstanceSubsystem from "./system_instance";
import logger from "./log";
import {
  hasMarker,
  readMarker,
  removeMarker,
  writeMarker,
  type RunnerSource
} from "./runner_marker";
import {
  ensureHandleInstance,
  queryHelperPreflight,
  removeGithubRegistration,
  uninstallSystemdService
} from "./runner_provision";

const SYSTEMCTL = "/usr/bin/systemctl";

// ---- 扫描根 ----
// 唯一真相源是特权助手的 ALLOWED_ROOT：那是 root 侧真正的边界，daemon 这边声明得再宽也没用，
// 只会把失败推迟到「runner 已经注册到 GitHub」之后（provision 的第 4 步才调助手）。所以启动时
// 向助手要一次(initRunnerRoots)，拿不到才退回环境变量——开发机没装助手/没配免密属正常。
const FALLBACK_ROOTS = "/data/ci-runner";

function parseRoots(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => path.normalize(s.trim()))
    .filter(Boolean);
}

let runnerRoots: string[] = parseRoots(process.env.CIP_SCAN_ROOTS || FALLBACK_ROOTS);

// daemon 启动时调一次。同步执行：assertUnderRoots 是同步的、且会被 HTTP 请求调用，
// 必须在开始服务之前就定下来，不能让前几个请求用着回退值。
export function initRunnerRoots(): void {
  const pre = queryHelperPreflight();
  if (!pre) {
    logger.warn(
      `[runner-scan] 取不到特权助手的 ALLOWED_ROOT，暂用 ${runnerRoots.join(", ")}。` +
        `创建 runner 时若被助手拒绝，请跑 prod-scripts/install-runner-privileges.sh`
    );
    return;
  }
  const helperRoots = parseRoots(pre.allowedRoot);
  // 助手只有一个根，CIP_SCAN_ROOTS 却是列表。历史上多写的根从来就装不上服务(助手会拒)，
  // 所以这里以助手为准同时也修掉了那个不一致，但要说清楚是哪些根被丢掉了。
  const envRaw = process.env.CIP_SCAN_ROOTS;
  if (envRaw && parseRoots(envRaw).join(",") !== helperRoots.join(",")) {
    logger.warn(
      `[runner-scan] CIP_SCAN_ROOTS(${parseRoots(envRaw).join(", ")}) 与助手的 ` +
        `ALLOWED_ROOT(${helperRoots.join(", ")}) 不一致，以助手为准。` +
        `要改扫描根请跑 prod-scripts/install-runner-privileges.sh --root <路径>`
    );
  }
  runnerRoots = helperRoots;
  logger.info(`[runner-scan] 扫描根取自特权助手(v${pre.version}): ${runnerRoots.join(", ")}`);
}

// 布局是 <root>/<仓库目录>/<runner 目录>，两层足够；再深就是 runner 自己的 bin/_work 了
const MAX_DEPTH = 2;

export interface SystemdState {
  service: string; // 单元名，来自 .service 文件
  loaded: boolean; // systemd 认不认识它（false = 服务文件已被删）
  activeState: string; // active / inactive / failed
  subState: string; // running / dead / ...
  enabled: string; // enabled / disabled / static
  since: string; // 主进程启动时间
}

export interface ScannedRunner {
  dir: string;
  dirName: string;
  repo: string; // owner/repo，来自 .runner 的 gitHubUrl
  agentName: string; // runner 在 GitHub 上的名字，来自 .runner
  systemd: SystemdState | null; // null = 没装 systemd 服务
  instanceUuid: string; // 面板实例（按 cwd 匹配），空 = 面板没托管
  instanceStatus: number; // 面板实例状态，-1 = 无实例
  // systemd  : 由 systemd 托管（生产常态）
  // panel    : 由面板实例托管
  // both     : 两边都托管——危险，同一个 runner 目录可能跑起两个 Runner.Listener
  // none     : 已注册但没人托管，永远接不到任务
  managedBy: "systemd" | "panel" | "both" | "none";
  busy: boolean; // 正在跑 job（有 Runner.Worker 子进程）——停它会中断 CI 任务
  // 面板纳管标记（.cipanel）。managed=true 才算面板在纳管，日常展示只看这类。
  managed: boolean;
  markerId: string; // marker 里的管理标识，空 = 未纳管
  source: RunnerSource | ""; // provision / import，空 = 未纳管
  group: string; // marker 里的所属组
  exists: boolean; // 目录是否还在且含 .runner（按已知路径探测时用得上）
  broken?: string; // 目录有问题时的说明（.runner 解析失败等）
}

export interface ScanResult {
  roots: string[];
  runners: ScannedRunner[];
  errors: Array<{ dir: string; error: string }>;
}

function isRunnerDir(dir: string) {
  return fs.existsSync(path.join(dir, ".runner"));
}

// 收集所有含 .runner 的目录；命中即停，不再往里挖
function collectRunnerDirs(dir: string, depth: number, out: string[], errors: ScanResult["errors"]) {
  if (depth > MAX_DEPTH) return;
  try {
    if (!fs.statSync(dir).isDirectory()) return;
  } catch {
    return;
  }
  if (isRunnerDir(dir)) {
    out.push(dir);
    return;
  }
  if (depth === MAX_DEPTH) return;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (err: any) {
    errors.push({ dir, error: err.message });
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    collectRunnerDirs(path.join(dir, name), depth + 1, out, errors);
  }
}

// 一次 systemctl show 查完所有单元，省得 30 个 runner 调 30 次。异步执行，不阻塞事件循环。
async function querySystemd(services: string[]): Promise<Map<string, SystemdState>> {
  const result = new Map<string, SystemdState>();
  if (services.length === 0) return result;
  let out = "";
  try {
    const r = await execFileAsync(
      SYSTEMCTL,
      [
        "show",
        ...services,
        "--property=Id,LoadState,ActiveState,SubState,UnitFileState,ExecMainStartTimestamp"
      ],
      { encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024 }
    );
    out = String(r.stdout);
  } catch (err: any) {
    logger.error(`[runner-scan] systemctl show 失败: ${err.message}`);
    return result;
  }
  // 多个单元的输出以空行分隔
  for (const block of out.split(/\n\s*\n/)) {
    const kv: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
    }
    if (!kv.Id) continue;
    result.set(kv.Id, {
      service: kv.Id,
      loaded: kv.LoadState === "loaded",
      activeState: kv.ActiveState || "",
      subState: kv.SubState || "",
      enabled: kv.UnitFileState || "",
      since: kv.ExecMainStartTimestamp || ""
    });
  }
  return result;
}

// 找出正在跑 job 的 runner 目录。
// runner 空闲时只有 Runner.Listener 一个进程；接到 job 后会 fork 出 Runner.Worker 子进程。
// 停一个 busy 的 runner 会当场中断 CI 任务，所以必须在 UI 上标出来、拦一道。
// 关联方式：Worker 的父进程就是 Listener，而 Listener 的 cmdline 里带着 runner 目录的绝对路径。
// 异步 + 分批并发读 /proc：机器上可能有几千个进程，同步逐个读会卡住事件循环几十毫秒、
// 负载高时更久。分批(每批 256)既不阻塞、也不会一次打开几千个 fd。
async function busyRunnerDirs(): Promise<Set<string>> {
  const busy = new Set<string>();
  let pids: string[] = [];
  try {
    pids = (await fs.promises.readdir("/proc")).filter((n) => /^\d+$/.test(n));
  } catch {
    return busy;
  }
  const CHUNK = 256;
  for (let i = 0; i < pids.length; i += CHUNK) {
    await Promise.all(
      pids.slice(i, i + CHUNK).map(async (pid) => {
        try {
          const comm = await fs.promises.readFile(`/proc/${pid}/comm`, "utf8");
          if (comm.trim() !== "Runner.Worker") return;
          // /proc/<pid>/stat 的 comm 字段可能含空格和括号，从最后一个 ')' 之后再切字段
          const stat = await fs.promises.readFile(`/proc/${pid}/stat`, "utf8");
          const fields = stat
            .slice(stat.lastIndexOf(")") + 1)
            .trim()
            .split(/\s+/);
          const ppid = fields[1];
          const cmdline = (await fs.promises.readFile(`/proc/${ppid}/cmdline`, "utf8")).replace(
            /\0/g,
            " "
          );
          const m = cmdline.match(/^(\S+)\/bin\/Runner\.Listener/);
          if (m) busy.add(path.normalize(m[1]));
        } catch {
          /* 进程可能刚好退出了，跳过 */
        }
      })
    );
  }
  return busy;
}

// 从仓库地址提取 owner/repo。与 runner_provision.ts 的 repoSlug 同语义
function repoSlug(repoUrl: string): string {
  try {
    const u = new URL(repoUrl);
    const parts = u.pathname
      .replace(/\.git$/i, "")
      .split("/")
      .filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return parts.join("/") || u.hostname;
  } catch {
    return repoUrl;
  }
}

// 校验扫描根并收集其下所有 .runner 目录（全盘发现，不看纳管状态）
function collectFromRoots(roots?: string[]): {
  scanRoots: string[];
  dirs: string[];
  errors: ScanResult["errors"];
} {
  const scanRoots = (roots?.length ? roots : runnerRoots).map((r) => path.normalize(r.trim()));
  const errors: ScanResult["errors"] = [];
  const dirs: string[] = [];
  for (const root of scanRoots) {
    if (!path.isAbsolute(root) || root === "/") {
      errors.push({ dir: root, error: "扫描根必须是绝对路径且不能是 /" });
      continue;
    }
    // 调用方（最终是前端）可以指定更窄的根，但绝不能指定扫描根之外的——否则这个接口
    // 就成了「让 daemon 枚举任意目录下的 .runner 并回读其内容」的通道。只许收窄，不许放宽。
    try {
      assertUnderRoots(root);
    } catch (err: any) {
      errors.push({ dir: root, error: err?.message || String(err) });
      continue;
    }
    if (!fs.existsSync(root)) {
      errors.push({ dir: root, error: "目录不存在" });
      continue;
    }
    collectRunnerDirs(root, 0, dirs, errors);
  }
  return { scanRoots, dirs, errors };
}

// 从一组已知的 runner 目录构建结果：读 .runner / .service / .cipanel，统一查 systemd 与 busy。
// scanRunners（全盘发现）与 scanManagedRunners（只看已纳管）都复用它，区别只在传进来的 dirs。
async function buildRunners(dirs: string[]): Promise<ScannedRunner[]> {
  // 面板实例按工作目录索引，用来判断这个 runner 面板有没有在托管
  const instanceByCwd = new Map<string, { uuid: string; status: number }>();
  for (const inst of InstanceSubsystem.instances.values()) {
    const cwd = inst?.config?.cwd;
    if (cwd) {
      instanceByCwd.set(path.normalize(cwd), {
        uuid: inst.instanceUuid,
        status: inst.status()
      });
    }
  }

  // 先把每个目录的 .runner / .service / .cipanel 读出来，再统一查 systemd
  const drafts = dirs.map((dir) => {
    const marker = readMarker(dir);
    const draft = {
      dir,
      dirName: path.basename(dir),
      repo: marker?.repo || "", // 目录坏了读不到 .runner 时，靠 marker 里的 repo 兜底
      agentName: path.basename(dir),
      service: "",
      marker,
      exists: fs.existsSync(path.join(dir, ".runner")),
      broken: undefined as string | undefined
    };
    try {
      // .runner 带 BOM，直接 JSON.parse 会炸
      const raw = fs.readFileSync(path.join(dir, ".runner"), "utf8").replace(/^﻿/, "");
      const j = JSON.parse(raw);
      if (j.gitHubUrl) draft.repo = repoSlug(String(j.gitHubUrl));
      if (j.agentName) draft.agentName = String(j.agentName);
    } catch (err: any) {
      draft.broken = `.runner 解析失败: ${err.message}`;
    }
    // .service 是目录 → systemd 单元名的权威映射。目录名不可信：simpler-ci/npu-runner-1
    // 这个目录，runner 在 GitHub 上其实叫 runner-dev4-7，服务名也是按后者拼的。
    try {
      const p = path.join(dir, ".service");
      if (fs.existsSync(p)) draft.service = fs.readFileSync(p, "utf8").trim();
    } catch {
      /* 没有 .service 就是没装 systemd 服务 */
    }
    return draft;
  });

  // 两个外部调用并发跑，各自不阻塞事件循环
  const [systemdStates, busy] = await Promise.all([
    querySystemd(drafts.map((d) => d.service).filter(Boolean)),
    busyRunnerDirs()
  ]);

  const runners: ScannedRunner[] = drafts.map((d) => {
    const systemd = d.service ? systemdStates.get(d.service) || null : null;
    const instance = instanceByCwd.get(path.normalize(d.dir));

    // 托管方式只认 systemd：provision 和导入的 runner 现在都由 systemd 托管，面板实例一律只是
    // 文件管理/配置的「句柄」、不跑 run.sh，故不算托管。managedBy 因此只剩 systemd / none。
    // （panel / both 两种历史状态在"纯 systemd 托管"下不再产生，前端保留其展示分支但不会触发。）
    const bySystemd = Boolean(systemd?.loaded);
    const managedBy: ScannedRunner["managedBy"] = bySystemd ? "systemd" : "none";

    return {
      dir: d.dir,
      dirName: d.dirName,
      repo: d.repo,
      agentName: d.agentName,
      systemd,
      instanceUuid: instance?.uuid || "",
      instanceStatus: instance ? instance.status : -1,
      managedBy,
      busy: busy.has(path.normalize(d.dir)),
      managed: Boolean(d.marker),
      markerId: d.marker?.id || "",
      source: d.marker?.source || "",
      group: d.marker?.group || "",
      exists: d.exists,
      broken: d.broken
    };
  });

  runners.sort((a, b) => (a.repo + a.agentName >= b.repo + b.agentName ? 1 : -1));
  return runners;
}

// 全盘发现：返回 roots 下所有 .runner 目录（无论有没有纳管），每个带 managed 标记。
// 只给「导入」列表用——让用户看见机器上全部 runner，已纳管的置灰。
export async function scanRunners(roots?: string[]): Promise<ScanResult> {
  const { scanRoots, dirs, errors } = collectFromRoots(roots);
  const runners = await buildRunners(dirs);
  logger.info(`[runner-scan] 扫描 ${scanRoots.join(", ")}：发现 ${runners.length} 个 runner`);
  return { roots: scanRoots, runners, errors };
}

// 自愈：已纳管(有 marker)但缺句柄实例的 runner，补建一个。
// 覆盖历史数据——本次改动之前导入的 runner 只写了 marker、没建实例，文件管理/详情页会缺 instanceUuid；
// 靠这个在列表/详情读取时自动补上，用户无需重新导入(导入弹窗里它们已置灰、也没法再导)。
// ensureHandleInstance 幂等：已有实例直接返回，不重复建。
// 不能加 `!r.instanceUuid` 前置条件：ensureHandleInstance 本身幂等（已有就复用），
// 而且它还负责把早期句柄实例遗留的启动命令(bash run.sh)收掉——那些恰恰是「已有句柄」的，
// 加了前置条件就永远轮不到修。
function reconcileHandle(r: ScannedRunner) {
  if (r.managed && r.exists) {
    try {
      r.instanceUuid = ensureHandleInstance(r.dir, r.repo, r.agentName);
    } catch (err: any) {
      logger.warn(`[runner-scan] 补建/修复句柄实例失败 ${r.dir}: ${err?.message || err}`);
    }
  }
}

// 发现全部「被管理的 runner」目录：遍历面板的句柄实例——每个被管理 runner 纳管时都建了一个
// 句柄实例，其 cwd 就是 runner 目录（实例配置持久化、重启不丢）。所以直接从实例 cwd 拿到全部
// 被管理 runner，不再遍历 CIP_SCAN_ROOTS——runner 放在任意位置都能被列出，不受扫描根限制。
// 仍以 .cipanel 过滤，排除 global 等非 runner 实例（它们目录里没有 .cipanel）。
function managedRunnerDirs(): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const inst of InstanceSubsystem.instances.values()) {
    const cwd = inst?.config?.cwd;
    if (!cwd) continue;
    const norm = path.normalize(cwd);
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (hasMarker(norm)) dirs.push(norm);
  }
  return dirs;
}

// 列出已纳管的 runner，供日常展示用。
export async function scanManagedRunners(): Promise<ScanResult> {
  const runners = await buildRunners(managedRunnerDirs());
  runners.forEach(reconcileHandle); // 幂等：顺手修早期句柄实例遗留的启动命令
  logger.info(`[runner-scan] 已纳管（经句柄实例发现）：${runners.length} 个`);
  return { roots: [], runners, errors: [] };
}

// 已纳管 runner 的运行计数，供 info/overview 上报「实例状态」。
//
// systemd 是唯一启动路径，句柄实例从不启动，所以按「面板启动了几个实例」统计恒为 0、毫无意义；
// 这里改成按 systemd 的真实状态统计，节点页看到的才是 runner 的实际运行情况。
//
// info/overview 会被面板高频轮询，故加 TTL 缓存，避免每次都走目录遍历 + systemctl。
// 刻意不做 reconcile（不像 scanManagedRunners 那样补建句柄实例）——这是只读的热路径，不该有副作用。
export interface ManagedRunnerCounts {
  total: number;
  running: number;
  busy: number;
}

const COUNTS_TTL_MS = 5000;
let countsCache: { at: number; value: ManagedRunnerCounts } | null = null;

export async function getManagedRunnerCounts(): Promise<ManagedRunnerCounts> {
  const now = Date.now();
  if (countsCache && now - countsCache.at < COUNTS_TTL_MS) return countsCache.value;

  const runners = await buildRunners(managedRunnerDirs());
  const value: ManagedRunnerCounts = { total: 0, running: 0, busy: 0 };
  for (const r of runners) {
    value.total++;
    if (r.systemd?.loaded && r.systemd.activeState === "active") value.running++;
    if (r.busy) value.busy++;
  }
  countsCache = { at: now, value };
  return value;
}

// 探单个 runner 目录的实时状态（详情页拿基本信息 + 定时刷新用）。免全盘遍历。
export async function scanOneRunner(dirRaw: string): Promise<ScannedRunner | null> {
  const dir = path.normalize(String(dirRaw || ""));
  if (!path.isAbsolute(dir) || dir === "/") throw new Error("目录必须是绝对路径且不能是 /");
  const runner = (await buildRunners([dir]))[0] || null;
  if (runner) reconcileHandle(runner); // 详情页直接进来时也补齐，保证文件管理可用
  return runner;
}

// ---- 纳管 / 取消纳管：写、删 .cipanel 标记 ----

export interface RegisterItem {
  dir: string;
  repo?: string;
  group?: string;
}
export interface RegisterResult {
  dir: string;
  ok: boolean;
  markerId?: string;
  instanceUuid?: string; // 句柄实例 uuid（文件管理/配置/详情页要用）
  error?: string;
}

// 纳管：给指定目录写 .cipanel（默认来源 import——手动导入既有 runner），并确保有个「句柄实例」，
// 让文件管理/配置/详情页能复用 MCSManager 的实例能力。句柄实例不改变实际托管方式：
// systemd runner 仍由 systemd 跑，前端不暴露句柄实例的启停，both 判定也按 source 排除 import。
export function registerRunners(
  items: RegisterItem[],
  source: RunnerSource = "import"
): RegisterResult[] {
  if (!Array.isArray(items) || items.length === 0) throw new Error("没有要纳管的 runner");
  return items.map((it) => {
    const dir = path.normalize(String(it?.dir || ""));
    try {
      if (!path.isAbsolute(dir) || dir === "/") throw new Error("目录必须是绝对路径且不能是 /");
      if (!fs.existsSync(path.join(dir, ".runner")))
        throw new Error("不是 runner 目录（缺 .runner）");
      const marker = writeMarker(dir, { source, repo: it.repo, group: it.group });
      // 从 .runner 读 agentName / repo，作句柄实例的昵称与分组标签
      let agentName = path.basename(dir);
      let repo = it.repo || marker.repo || "";
      try {
        const raw = fs.readFileSync(path.join(dir, ".runner"), "utf8").replace(/^﻿/, "");
        const j = JSON.parse(raw);
        if (j.agentName) agentName = String(j.agentName);
        if (!repo && j.gitHubUrl) repo = repoSlug(String(j.gitHubUrl));
      } catch {
        /* .runner 解析失败也不挡纳管，用目录名兜底 */
      }
      const instanceUuid = ensureHandleInstance(dir, repo, agentName);
      logger.info(
        `[runner-register] 纳管 ${dir} (id=${marker.id}, source=${marker.source}, 实例=${instanceUuid})`
      );
      return { dir, ok: true, markerId: marker.id, instanceUuid };
    } catch (err: any) {
      return { dir, ok: false, error: err?.message || String(err) };
    }
  });
}

export interface UnregisterResult {
  dir: string;
  ok: boolean;
  hadInstance: boolean; // 该目录是否有面板实例
  removedInstance: boolean; // 是否回收了句柄实例
}

// 取消纳管：删 .cipanel（不动 runner 本身的文件）。
// 若是 import 来源的「句柄实例」，一并回收（deleteFile=false，只删实例记录、保留 runner 文件）；
// provision 的托管实例不动——那是真在跑 run.sh 的运行单元，不该被"取消纳管"顺手删掉。
export function unregisterRunner(dirRaw: string): UnregisterResult {
  const dir = path.normalize(String(dirRaw || ""));
  if (!path.isAbsolute(dir) || dir === "/") throw new Error("目录必须是绝对路径且不能是 /");
  const marker = readMarker(dir);
  let instanceUuid = "";
  for (const inst of InstanceSubsystem.instances.values()) {
    if (inst?.config?.cwd && path.normalize(inst.config.cwd) === dir) {
      instanceUuid = inst.instanceUuid;
      break;
    }
  }
  removeMarker(dir);
  let removedInstance = false;
  if (instanceUuid && marker?.source === "import") {
    InstanceSubsystem.removeInstance(instanceUuid, false); // deleteFile=false：保留 runner 目录
    removedInstance = true;
  }
  logger.info(`[runner-register] 取消纳管 ${dir}（回收句柄实例: ${removedInstance}）`);
  return { dir, ok: true, hadInstance: Boolean(instanceUuid), removedInstance };
}

// ---- 基目录选择器：浏览 / 新建目录（供前端创建 runner 时挑基目录）----
// 严格限制在扫描根之下，绝不让前端浏览/创建到整个文件系统。扫描根见文件顶部的 runnerRoots：
// 正常部署下它等于助手的 ALLOWED_ROOT，所以这里放行的目录助手一定也放行。

const scanRoots = () => [...runnerRoots];

export function assertUnderRoots(target: string) {
  if (!path.isAbsolute(target)) throw new Error("路径必须是绝对路径");
  const roots = scanRoots();
  if (!roots.some((r) => target === r || target.startsWith(r + path.sep)))
    throw new Error(`只允许在扫描根下操作：${roots.join(", ")}`);
}

export interface DirListing {
  path: string;
  parent: string; // 空 = 已在扫描根，不能再往上
  roots: string[];
  dirs: string[]; // 子目录名（不含隐藏目录）
}

export function listDirs(pathRaw?: string): DirListing {
  const roots = scanRoots();
  const target = pathRaw ? path.normalize(String(pathRaw)) : roots[0] || "/";
  assertUnderRoots(target);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory())
    throw new Error(`目录不存在: ${target}`);
  const dirs: string[] = [];
  for (const name of fs.readdirSync(target)) {
    if (name.startsWith(".")) continue; // 隐藏目录不列
    try {
      if (fs.statSync(path.join(target, name)).isDirectory()) dirs.push(name);
    } catch {
      /* 权限/竞态，跳过 */
    }
  }
  dirs.sort((a, b) => a.localeCompare(b));
  const parent = roots.some((r) => target === r) ? "" : path.dirname(target);
  return { path: target, parent, roots, dirs };
}

export function makeDir(pathRaw: string, name: string): { path: string } {
  const base = path.normalize(String(pathRaw || ""));
  const folder = String(name || "").trim();
  if (!folder || /[/\\]/.test(folder) || folder === "." || folder === "..")
    throw new Error("目录名不能为空、且不能含 / \\ 或 . ..");
  assertUnderRoots(base);
  if (!fs.existsSync(base)) throw new Error(`父目录不存在: ${base}`);
  const full = path.join(base, folder);
  fs.ensureDirSync(full);
  logger.info(`[runner] 新建目录 ${full}`);
  return { path: full };
}

// ---- 彻底删除一个 runner：停+卸 systemd、从 GitHub 注销、清面板侧、删目录 ----

export type DeleteStepStatus = "ok" | "failed" | "skipped";
export interface DeleteStep {
  key: "systemd" | "github" | "panel" | "dir";
  label: string;
  status: DeleteStepStatus;
  detail?: string; // 失败 / 跳过的原因
  hint?: string; // 失败时可手动执行的命令 / 做法，供用户接着做
}
export interface DeleteResult {
  dir: string;
  ok: boolean; // 目录是否删掉（核心结果）
  steps: DeleteStep[]; // 每一步的执行结果，供前端展示"卡在哪一步"
  warnings: string[]; // 由非 ok 步骤派生，兼容旧用法
}

// 删除是不可逆的破坏性操作。分步 best-effort：单步失败记 warning 但继续，尽量把 runner 清干净。
export async function deleteRunner(
  dirRaw: string,
  opts: { removeToken?: string; proxy?: string; force?: boolean } = {}
): Promise<DeleteResult> {
  const dir = path.normalize(String(dirRaw || ""));
  // 严格校验：绝对路径、非根、必须在扫描根下、且看起来确实是 runner 目录——绝不误删别处
  if (!path.isAbsolute(dir) || dir === "/") throw new Error("目录必须是绝对路径且不能是 /");
  // 走共享的 assertUnderRoots，别再从环境变量重推一份：扫描根的真相源是助手的 ALLOWED_ROOT，
  // 各自推各自的会让这条删除路径和其余路径的边界不一致。
  try {
    assertUnderRoots(dir);
  } catch (err: any) {
    throw new Error(`拒绝删除扫描根之外的目录: ${dir}（${err?.message || String(err)}）`);
  }
  if (!fs.existsSync(path.join(dir, ".runner")) && !fs.existsSync(path.join(dir, ".cipanel")))
    throw new Error("不是 runner 目录（无 .runner / .cipanel），拒绝删除");

  const steps: DeleteStep[] = [];

  // busy 拦截：正在跑 job 的删除会当场中断 CI，必须显式 force
  const busy = await busyRunnerDirs();
  if (busy.has(dir) && !opts.force)
    throw new Error("该 runner 正在跑 job，删除会中断 CI；确认后加 force 重试");

  // 1) 停 + 卸 systemd
  const uninstall = uninstallSystemdService(dir);
  steps.push(
    uninstall.ok
      ? { key: "systemd", label: "停止并卸载 systemd 服务", status: "ok" }
      : {
          key: "systemd",
          label: "停止并卸载 systemd 服务",
          status: "failed",
          detail: uninstall.error,
          hint: `sudo /usr/local/sbin/ci-panel-runner-svc uninstall ${dir}`
        }
  );

  // 2) 从 GitHub 注销（需删除 token；停服务后才做）
  if (opts.removeToken) {
    const r = await removeGithubRegistration(dir, opts.removeToken, opts.proxy);
    steps.push(
      r.ok
        ? { key: "github", label: "从 GitHub 注销", status: "ok" }
        : {
            key: "github",
            label: "从 GitHub 注销",
            status: "failed",
            detail: r.error,
            hint: `在 runner 目录执行：cd ${dir} && ./config.sh remove --token <删除token>；或到 GitHub 仓库 Settings → Actions → Runners 手动移除`
          }
    );
  } else {
    steps.push({
      key: "github",
      label: "从 GitHub 注销",
      status: "skipped",
      detail: "未取得删除 token（该仓库可能没配 PAT）",
      hint: "到 GitHub 仓库 Settings → Actions → Runners 手动移除该 runner"
    });
  }

  // 3) 清面板侧：句柄实例 + marker（本地操作，基本不会失败）
  let instanceRemoved = false;
  try {
    for (const inst of InstanceSubsystem.instances.values()) {
      if (inst?.config?.cwd && path.normalize(inst.config.cwd) === dir) {
        InstanceSubsystem.removeInstance(inst.instanceUuid, false); // 目录我们自己删，这里不删文件
        instanceRemoved = true;
        break;
      }
    }
    removeMarker(dir);
    steps.push({ key: "panel", label: "清理面板句柄实例与纳管标记", status: "ok" });
  } catch (err: any) {
    steps.push({
      key: "panel",
      label: "清理面板句柄实例与纳管标记",
      status: "failed",
      detail: err?.message || String(err)
    });
  }

  // 4) 删目录
  let dirRemoved = false;
  try {
    await fs.remove(dir);
    dirRemoved = true;
    steps.push({ key: "dir", label: "删除 runner 目录", status: "ok" });
  } catch (err: any) {
    steps.push({
      key: "dir",
      label: "删除 runner 目录",
      status: "failed",
      detail: err?.message || String(err),
      hint: `rm -rf ${dir}`
    });
  }

  const warnings = steps
    .filter((s) => s.status !== "ok")
    .map((s) => `${s.label}：${s.detail || s.status}`);
  logger.info(
    `[runner-delete] ${dir}（systemd=${uninstall.ok} 实例=${instanceRemoved} 目录=${dirRemoved}）`
  );
  return { dir, ok: dirRemoved, steps, warnings };
}

// ---- systemd 控制。需要 sudoers 免密白名单（仅 actions.runner.*.service 的 start/stop/restart）----

const ALLOWED_ACTIONS = ["start", "stop", "restart"] as const;
export type SystemdAction = (typeof ALLOWED_ACTIONS)[number];

export async function controlService(service: string, action: SystemdAction) {
  if (!ALLOWED_ACTIONS.includes(action)) throw new Error(`不支持的操作: ${action}`);
  // 白名单前缀必须和 sudoers 规则一致，否则 sudo 会要密码然后挂住
  if (!/^actions\.runner\.[A-Za-z0-9._@-]+\.service$/.test(service))
    throw new Error(`非法的服务名: ${service}`);
  try {
    execFileSync("sudo", ["-n", SYSTEMCTL, action, service], {
      encoding: "utf8",
      timeout: 60000
    });
  } catch (err: any) {
    const stderr = String(err.stderr || "");
    if (stderr.includes("password") || stderr.includes("sudo:"))
      throw new Error(`sudo 免密未配置，无法 ${action} ${service}。请配置 /etc/sudoers.d/ci-panel-runner`);
    throw new Error(`${action} ${service} 失败: ${stderr || err.message}`);
  }
  logger.info(`[runner-scan] systemctl ${action} ${service} 成功`);
  return (await querySystemd([service])).get(service) || null;
}
