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
import { execFileSync } from "child_process";
import fs from "fs-extra";
import path from "path";
import InstanceSubsystem from "./system_instance";
import logger from "./log";
import {
  hasMarker,
  readMarker,
  removeMarker,
  writeMarker,
  type RunnerSource
} from "./runner_marker";
import { ensureHandleInstance } from "./runner_provision";

const SYSTEMCTL = "/usr/bin/systemctl";

// 默认扫描根（可用环境变量 CIP_SCAN_ROOTS 覆盖，逗号分隔）
const DEFAULT_ROOTS = (process.env.CIP_SCAN_ROOTS || "/data/ci-runner")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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

// 一次 systemctl show 查完所有单元，省得 30 个 runner 调 30 次
function querySystemd(services: string[]): Map<string, SystemdState> {
  const result = new Map<string, SystemdState>();
  if (services.length === 0) return result;
  let out = "";
  try {
    out = execFileSync(
      SYSTEMCTL,
      [
        "show",
        ...services,
        "--property=Id,LoadState,ActiveState,SubState,UnitFileState,ExecMainStartTimestamp"
      ],
      { encoding: "utf8", timeout: 15000 }
    );
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
function busyRunnerDirs(): Set<string> {
  const busy = new Set<string>();
  let pids: string[] = [];
  try {
    pids = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return busy;
  }
  for (const pid of pids) {
    try {
      if (fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() !== "Runner.Worker") continue;
      // /proc/<pid>/stat 的 comm 字段可能含空格和括号，从最后一个 ')' 之后再切字段
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/);
      const ppid = fields[1];
      const cmdline = fs.readFileSync(`/proc/${ppid}/cmdline`, "utf8").replace(/\0/g, " ");
      const m = cmdline.match(/^(\S+)\/bin\/Runner\.Listener/);
      if (m) busy.add(path.normalize(m[1]));
    } catch {
      /* 进程可能刚好退出了，跳过 */
    }
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
  const scanRoots = (roots?.length ? roots : DEFAULT_ROOTS).map((r) => path.normalize(r.trim()));
  const errors: ScanResult["errors"] = [];
  const dirs: string[] = [];
  for (const root of scanRoots) {
    if (!path.isAbsolute(root) || root === "/") {
      errors.push({ dir: root, error: "扫描根必须是绝对路径且不能是 /" });
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
function buildRunners(dirs: string[]): ScannedRunner[] {
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

  const systemdStates = querySystemd(drafts.map((d) => d.service).filter(Boolean));
  const busy = busyRunnerDirs();

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
export function scanRunners(roots?: string[]): ScanResult {
  const { scanRoots, dirs, errors } = collectFromRoots(roots);
  const runners = buildRunners(dirs);
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

// 只返回带 .cipanel 的目录——面板纳管的那些，供日常展示用。
// membership 以 marker 为准，不再把「磁盘上存在 .runner」当成纳管。
export function scanManagedRunners(roots?: string[]): ScanResult {
  const { scanRoots, dirs, errors } = collectFromRoots(roots);
  const managedDirs = dirs.filter((d) => hasMarker(d));
  const runners = buildRunners(managedDirs);
  runners.forEach(reconcileHandle); // 顺手补齐缺失的句柄实例
  logger.info(
    `[runner-scan] 已纳管扫描 ${scanRoots.join(", ")}：${runners.length}/${dirs.length} 个已纳管`
  );
  return { roots: scanRoots, runners, errors };
}

// 探单个 runner 目录的实时状态（详情页拿基本信息 + 定时刷新用）。免全盘遍历。
export function scanOneRunner(dirRaw: string): ScannedRunner | null {
  const dir = path.normalize(String(dirRaw || ""));
  if (!path.isAbsolute(dir) || dir === "/") throw new Error("目录必须是绝对路径且不能是 /");
  const runner = buildRunners([dir])[0] || null;
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

// ---- systemd 控制。需要 sudoers 免密白名单（仅 actions.runner.*.service 的 start/stop/restart）----

const ALLOWED_ACTIONS = ["start", "stop", "restart"] as const;
export type SystemdAction = (typeof ALLOWED_ACTIONS)[number];

export function controlService(service: string, action: SystemdAction) {
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
  return querySystemd([service]).get(service) || null;
}
