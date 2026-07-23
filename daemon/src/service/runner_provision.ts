// CI Panel 扩展：一键 provision 一个 GitHub Actions self-hosted runner。
// 流程：解压安装包 → config.sh 注册到 GitHub → 装 systemd 服务并启动 → 建「句柄实例」。
//
// 托管方式只有 systemd 一条路：开机自启、崩溃自拉起、不随 daemon 重启掉线。
// 面板这边的实例只是「句柄」——给文件管理/配置/详情页当抓手（那些接口都按 instanceUuid
// 授权、根在实例 cwd），它不带启动命令、永远不跑 runner，以免和 systemd 双跑抢同一个
// GitHub 身份。（早期版本是 daemon 把 run.sh 当子进程托管，已废弃。）
import fs from "fs-extra";
import path from "path";
import { spawn, execFileSync } from "child_process";
import axios from "axios";
import InstanceSubsystem from "./system_instance";
import logger from "./log";
import { writeMarker, readMarker } from "./runner_marker";

// 实例类型常量，等于 Instance.TYPE_UNIVERSAL。刻意用字面量而不 import Instance 类：
// instance.ts 处在 instance↔java_manager↔system_instance 的循环里，本模块被 runner_scan 提前引入后，
// 访问 Instance 的静态成员会踩到初始化顺序(TDZ)——「Cannot access 'TYPE_UNIVERSAL' before initialization」。
// createInstance 的 type 只需这个字符串，不必依赖那个类。
const INSTANCE_TYPE_UNIVERSAL = "universal";

// runner 安装包路径（可用环境变量 CIP_RUNNER_PKG 覆盖）
const RUNNER_PKG =
  process.env.CIP_RUNNER_PKG ||
  path.join(process.cwd(), "data/runner-pkg/actions-runner-linux-arm64-2.331.0.tar.gz");

// 下载目录（放新拉取的安装包）
const RUNNER_PKG_DIR = path.dirname(RUNNER_PKG);

// 代理兜底：前端没传就用 daemon 环境变量 CIP_RUNNER_PROXY
function resolveProxy(proxy?: string): string {
  return (proxy || "").trim() || (process.env.CIP_RUNNER_PROXY || "").trim();
}

// 把 http://host:port 代理写进 axios 配置
function applyProxy(cfg: any, proxy?: string) {
  const pxy = resolveProxy(proxy);
  if (!pxy) return;
  const m = pxy.match(/^https?:\/\/([^:/]+):(\d+)/);
  if (m) cfg.proxy = { host: m[1], port: Number(m[2]), protocol: "http" };
}

// runner 架构：arm64 / x64
function runnerArch(): string {
  return process.arch === "arm64" ? "arm64" : "x64";
}

// 从仓库地址提取 owner/repo，作为实例标签（按仓库分组用）
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

// 在 runner-pkg 目录里挑版本最高的安装包（拉取新版后自动生效）；找不到就用内置默认路径
function resolveLocalPackage(): { path: string; version: string } {
  const arch = runnerArch();
  let best = { path: RUNNER_PKG, version: parseRunnerVersion(RUNNER_PKG) };
  try {
    const re = new RegExp(`^actions-runner-linux-${arch}-\\d+\\.\\d+\\.\\d+\\.tar\\.gz$`);
    for (const f of fs.readdirSync(RUNNER_PKG_DIR)) {
      if (!re.test(f)) continue;
      const v = parseRunnerVersion(f);
      if (v && (!best.version || cmpVersion(v, best.version) > 0)) {
        best = { path: path.join(RUNNER_PKG_DIR, f), version: v };
      }
    }
  } catch {
    // 目录不存在等，忽略
  }
  return best;
}

export interface ProvisionRunnerParams {
  repoUrl: string; // https://github.com/owner/repo
  token: string; // GitHub runner registration token
  name: string; // runner 名称
  labels?: string; // 逗号分隔标签
  targetDir: string; // 绝对路径，runner 安装目录
  proxy?: string; // 可选 http://host:port
  packagePath?: string; // 可选，指定 tar.gz 安装包（导入模式）；不填用内置包
  group?: string; // 可选，所属组（批量时为基础名），写进 .cipanel marker
  onStep?: (step: string) => void; // 可选，进度回调：每进入一个阶段回报一次
}

// 带完整日志的错误：message 用于展示（截断），fullLog 保留全量输出供前端复制/下载
export class ProvisionError extends Error {
  fullLog: string;
  constructor(message: string, fullLog: string) {
    super(message);
    this.name = "ProvisionError";
    this.fullLog = fullLog;
  }
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, shell: false });
    p.stdout.on("data", (d) => (output += d.toString()));
    p.stderr.on("data", (d) => (output += d.toString()));
    p.on("error", (e) => resolve({ code: -1, output: `${output}\n${e.message}` }));
    p.on("close", (code) => resolve({ code: code ?? -1, output }));
  });
}

export async function provisionRunner(params: ProvisionRunnerParams) {
  const { repoUrl, token, name } = params;
  const labels = (params.labels || "").trim();
  const proxy = resolveProxy(params.proxy);
  const targetDir = path.normalize(params.targetDir || "");

  // ---- 校验 ----
  if (!repoUrl || !/^https?:\/\/.+/.test(repoUrl)) throw new Error("仓库地址无效（需 http/https URL）");
  if (!token) throw new Error("注册 token 不能为空");
  if (!name) throw new Error("runner 名称不能为空");
  if (!path.isAbsolute(targetDir) || targetDir === "/")
    throw new Error("目标目录必须是绝对路径且不能为根目录 /");
  assertBaseDirRepo(path.dirname(targetDir), repoUrl); // 一个基目录只归一个仓库

  const step = params.onStep || (() => {});

  // 安装包：导入模式用指定 tar.gz，否则用内置包
  const pkg = (params.packagePath || "").trim() || resolveLocalPackage().path;
  if (!fs.existsSync(pkg)) throw new Error(`runner 安装包不存在: ${pkg}`);
  if (!/\.tar\.gz$|\.tgz$/i.test(pkg)) throw new Error(`安装包需为 tar.gz 文件: ${pkg}`);

  // ---- 1) 解压安装包 ----
  await fs.ensureDir(targetDir);
  if (!fs.existsSync(path.join(targetDir, "config.sh"))) {
    step("解压安装包");
    logger.info(`[runner-provision] 解压安装包 ${pkg} 到 ${targetDir}`);
    const r = await run("tar", ["xzf", pkg, "-C", targetDir], {});
    if (r.code !== 0)
      throw new ProvisionError(`解压失败: ${r.output.slice(-500)}`, r.output);
  } else {
    step("安装包已就绪");
  }

  // ---- 2) 代理写入 <dir>/.env（actions-runner 运行时读取；供 run.sh 上线用）----
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (proxy) {
    const envContent =
      [`HTTP_PROXY=${proxy}`, `HTTPS_PROXY=${proxy}`, `ALL_PROXY=${proxy}`, `NO_PROXY=localhost,127.0.0.1,::1`].join(
        "\n"
      ) + "\n";
    await fs.writeFile(path.join(targetDir, ".env"), envContent);
    childEnv.HTTP_PROXY = childEnv.HTTPS_PROXY = childEnv.ALL_PROXY = proxy;
    childEnv.NO_PROXY = "localhost,127.0.0.1,::1";
  }

  // ---- 3) config.sh 注册（已注册则跳过；必须以非 root 运行，daemon 本身即 ci-runner）----
  const alreadyConfigured = fs.existsSync(path.join(targetDir, ".runner"));
  if (!alreadyConfigured) {
    step("注册到 GitHub");
    logger.info(`[runner-provision] 注册 runner ${name} → ${repoUrl}`);
    const args = ["--url", repoUrl, "--token", token, "--name", name, "--work", "_work", "--unattended", "--replace"];
    if (labels) args.push("--labels", labels);

    // 代理连 GitHub CDN 常被中途重置（response ended / reset / TLS 等）。这类是暂时性错误，
    // 而 --replace 让注册幂等（重试会替换掉上次可能残留在 GitHub 的半成品 agent），故多次重试自愈。
    const MAX_ATTEMPTS = 5;
    let r = { code: -1, output: "" };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      r = await run(path.join(targetDir, "config.sh"), args, { cwd: targetDir, env: childEnv });
      if (r.code === 0) break;
      const transient =
        /ended prematurely|ResponseEnded|reset by peer|ECONNRESET|EPIPE|timed?\s*out|timeout|EOF|SSL|TLS handshake|connection|502|503|504|Bad Gateway|Gateway Time-?out/i.test(
          r.output
        );
      if (attempt < MAX_ATTEMPTS && transient) {
        logger.warn(
          `[runner-provision] ${name} 注册第 ${attempt}/${MAX_ATTEMPTS} 次疑似网络中断，重试…（${r.output.slice(-160)}）`
        );
        step(`注册重试 ${attempt}/${MAX_ATTEMPTS - 1}`);
        // 重试前清掉上次半成品，避免 config.sh 因残留文件报"已配置"之类
        for (const leftover of [".credentials", ".credentials_rsaparams", ".runner"]) {
          await fs.remove(path.join(targetDir, leftover)).catch(() => {});
        }
        await sleep(1500 * attempt); // 递增退避 1.5s / 3s / 4.5s / 6s
        continue;
      }
      break;
    }
    if (r.code !== 0) {
      // 最终仍失败：清掉半成品本地文件，便于之后重跑（GitHub 侧若已建 agent，重跑 --replace 会覆盖）
      for (const leftover of [".credentials", ".credentials_rsaparams", ".runner"]) {
        await fs.remove(path.join(targetDir, leftover)).catch(() => {});
      }
      // 脱敏：日志里不暴露注册 token
      const safeArgs = args.map((a, i) => (args[i - 1] === "--token" ? "***" : a));
      throw new ProvisionError(
        `config.sh 注册失败 (code=${r.code}): ${r.output.slice(-800)}`,
        `$ config.sh ${safeArgs.join(" ")}\n(cwd: ${targetDir})\nexit code: ${r.code}\n\n${r.output}`
      );
    }
  } else {
    step("已注册（跳过）");
  }

  // ---- 4) 装 systemd 服务并启动（生产托管方式：开机自启、崩溃自拉起、不随 daemon 重启掉线）----
  // 取代旧的「面板当子进程跑 run.sh」。面板这边只留一个句柄实例，给文件管理/配置/详情页用，不托管。
  step("安装 systemd 服务");
  installSystemdService(targetDir);

  // 写 .cipanel 标记：面板创建的 runner，来源 provision，纳入日常展示
  const marker = writeMarker(targetDir, {
    source: "provision",
    repo: repoSlug(repoUrl),
    group: (params.group || "").trim(),
    labels: (params.labels || "").trim()
  });

  // 句柄实例：只作文件管理/配置的抓手，不跑 run.sh（systemd 在跑）
  step("创建句柄实例");
  const instanceUuid = ensureHandleInstance(targetDir, repoSlug(repoUrl), name);

  logger.info(`[runner-provision] 完成: systemd 服务 + 句柄实例 ${instanceUuid} (${name})`);
  return {
    instanceUuid,
    nickname: name,
    alreadyConfigured,
    markerId: marker.id
  };
}

// 特权小助手路径（root 所有、ci-runner 不可写；见 prod-scripts/ci-panel-runner-svc）。可用环境变量覆盖。
export const RUNNER_SVC_HELPER =
  process.env.CIP_RUNNER_SVC_HELPER || "/usr/local/sbin/ci-panel-runner-svc";

// catch 到的值类型是 unknown，取「可读文本」这件事在本模块和 runner_scan 里重复出现，
// 统一收在这里narrow一次，避免各处退回 err: any。
export function errText(err: unknown): string {
  if (err instanceof Error) {
    // execFileSync 的错误对象上挂着 stderr，比 message 更有信息量
    const stderr = (err as Error & { stderr?: unknown }).stderr;
    const detail = typeof stderr === "string" ? stderr.trim() : "";
    return detail || err.message;
  }
  return String(err);
}

export interface HelperPreflight {
  version: string;
  allowedRoot: string; // 助手允许操作的根目录 —— root 侧真正的边界
}

// 向特权助手要一次自检信息。preflight 无副作用（不碰 systemd、不碰任何 runner 目录），
// 所以可以在 daemon 启动时安全地调。拿不到就返回 null：开发机没装助手、没配免密都属正常，
// 此时调用方退回环境变量即可。
export function queryHelperPreflight(): HelperPreflight | null {
  let out = "";
  try {
    out = String(
      execFileSync("sudo", ["-n", RUNNER_SVC_HELPER, "preflight"], {
        encoding: "utf8",
        timeout: 10000
      })
    );
  } catch (err: unknown) {
    // 免密未配、助手没装、助手是不认识 preflight 的旧版 —— 都归到「拿不到」
    logger.warn(`[runner-provision] 助手 preflight 失败: ${errText(err)}`);
    return null;
  }
  if (!/^ok$/m.test(out)) return null;
  const allowedRoot = out.match(/^allowed_root=(.+)$/m)?.[1]?.trim() ?? "";
  const version = out.match(/^version=(.+)$/m)?.[1]?.trim() ?? "";
  return allowedRoot ? { version, allowedRoot } : null;
}

// 把 runner 装成 systemd 服务并 enable+start。daemon 非 root，走 sudo -n 调用只放行了 helper 的白名单。
// 失败(尤其是未配免密 sudo)时抛 ProvisionError，带清晰指引。
export function installSystemdService(dir: string): void {
  try {
    const out = execFileSync("sudo", ["-n", RUNNER_SVC_HELPER, "install", dir], {
      encoding: "utf8",
      timeout: 60000
    });
    logger.info(`[runner-provision] systemd 安装: ${String(out).trim()}`);
  } catch (err: any) {
    const stderr = String(err?.stderr || err?.message || err || "");
    if (/password is required|sudo:|not allowed|a password/i.test(stderr)) {
      throw new ProvisionError(
        "装 systemd 服务需要免密 sudo，但未配置。请先安装特权助手与 sudoers 规则" +
          "（见 prod-scripts/ci-panel-runner-svc 与 ci-panel-runner-install.sudoers）。",
        stderr
      );
    }
    throw new ProvisionError(`装 systemd 服务失败: ${stderr}`, stderr);
  }
}

// 卸载 runner 的 systemd 服务（停 + 删单元）。走特权助手；幂等——没装服务也不报错。
export function uninstallSystemdService(dir: string): { ok: boolean; error?: string } {
  try {
    const out = execFileSync("sudo", ["-n", RUNNER_SVC_HELPER, "uninstall", dir], {
      encoding: "utf8",
      timeout: 60000
    });
    logger.info(`[runner] systemd 卸载: ${String(out).trim()}`);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: String(err?.stderr || err?.message || err) };
  }
}

// 从 GitHub 注销 runner：config.sh remove --token <删除token>。以 ci-runner 身份跑，走代理。
// 需要先停掉 runner（否则 GitHub 会拒绝移除在线 runner）——由调用方保证卸载 systemd 在前。
export async function removeGithubRegistration(
  dir: string,
  token: string,
  proxy?: string
): Promise<{ ok: boolean; error?: string }> {
  const configSh = path.join(dir, "config.sh");
  if (!fs.existsSync(configSh)) return { ok: false, error: "config.sh 不存在，无法注销" };
  const pxy = resolveProxy(proxy);
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (pxy) {
    childEnv.HTTP_PROXY = childEnv.HTTPS_PROXY = childEnv.ALL_PROXY = pxy;
    childEnv.NO_PROXY = "localhost,127.0.0.1,::1";
  }
  const r = await run(configSh, ["remove", "--token", token], { cwd: dir, env: childEnv });
  if (r.code !== 0) return { ok: false, error: r.output.slice(-300) };
  return { ok: true };
}

// 确保某 runner 目录有一个面板实例作为「管理句柄」：文件管理/配置/详情页要复用 MCSManager
// 的实例能力（那些接口都按 instanceUuid 授权、根在实例 cwd 上），所以纳管的 runner 也得有个实例。
// 已有就返回其 uuid，不重复建。句柄实例本身能跑 run.sh，但对 systemd 托管的 runner 前端不暴露它的
// 启停（启停走 systemctl），且 managedBy 的 both 判定按 marker.source 排除 import，故不会误判/双跑。
export function ensureHandleInstance(dir: string, repo: string, agentName: string): string {
  const norm = path.normalize(dir);
  for (const inst of InstanceSubsystem.instances.values()) {
    if (inst?.config?.cwd && path.normalize(inst.config.cwd) === norm) {
      // 自愈：早期句柄实例是按「面板托管」建的，启动命令还留着 bash run.sh。
      // systemd 已是唯一启动路径，这条命令就是个雷——谁从原生实例页点"启动"，
      // 就会和 systemd 同时拉起两个 Runner.Listener 抢同一个 GitHub 身份。收掉它。
      if (inst.config.startCommand) {
        try {
          inst.parameters({ startCommand: "", stopCommand: "" }, true);
          logger.info(`[runner] 收掉句柄实例的启动命令 ${inst.instanceUuid} (${dir})`);
        } catch (err: any) {
          logger.warn(`[runner] 收启动命令失败 ${dir}: ${err?.message || err}`);
        }
      }
      return inst.instanceUuid;
    }
  }
  const instance = InstanceSubsystem.createInstance({
    nickname: agentName || path.basename(dir),
    // 刻意不给启动命令：句柄实例只是文件管理/配置的抓手，runner 由 systemd 跑。
    // 留空后即使误点"启动"也起不来，从根上堵死双跑。
    startCommand: "",
    stopCommand: "",
    cwd: dir,
    type: INSTANCE_TYPE_UNIVERSAL,
    tag: repo ? [repo] : []
  });
  logger.info(`[runner] 建句柄实例 ${instance.instanceUuid} → ${dir}`);
  return instance.instanceUuid;
}

// ---- 批量：多组标签，每组 <基础名>-1..-N ----
export interface RunnerGroup {
  baseName: string; // 基础名，实际名会拼上 -1 -2 ...
  labels?: string; // 该组标签（逗号分隔）
  count: number; // 数量
}

export interface ProvisionBatchParams {
  repoUrl: string;
  token: string;
  proxy?: string;
  baseDir: string; // 基目录，每个 runner 目录 = baseDir/<name>
  groups: RunnerGroup[];
  packagePath?: string; // 可选，指定 tar.gz 安装包（导入模式）
  concurrency?: number; // 同时创建几个（1..10，默认 3）；代理脆时别调太高
}

// 并发度：限制在 1..10。默认 3——既加速又不至于把代理/磁盘打爆（并行注册挤同一个脆代理易触发重试风暴）
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 10;
function clampConcurrency(n?: number): number {
  const v = Math.floor(Number(n) || 0);
  if (v < 1) return DEFAULT_CONCURRENCY;
  return Math.min(v, MAX_CONCURRENCY);
}

export interface BatchItemResult {
  name: string;
  ok: boolean;
  instanceUuid?: string;
  error?: string;
}

interface BatchSpec {
  name: string;
  labels: string;
  targetDir: string;
  group: string; // 基础名，作为 .cipanel marker 的组
}

// 转义正则特殊字符，供按 baseName 前缀匹配用
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 收集「已占用的 runner 名字」，用于采番与防覆盖。两个来源、两种范围：
//   1. 基目录下的既有子目录名 —— 防目录物理覆盖，按 baseDir 天然隔离，照收。
//   2. 已看护句柄实例的昵称 —— 让同一 repo 换基目录也不撞名（GitHub runner 名按 repo 唯一）。
//      关键：只计入 tag 命中「同一 repo」的实例，否则别的 repo 的同名 runner 会污染本 repo
//      的采番，把编号顶高（例：repo A 有 npu-10，会害 repo B 从 npu-11 起）。
// 未传 repoUrl 时退化为收集全部昵称（保持无 repo 上下文的调用兼容）。
// 纯只读；基目录尚不存在时视为无已存在 runner。
function collectUsedNames(baseDir: string, repoUrl?: string): Set<string> {
  const used = new Set<string>();
  try {
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (entry.isDirectory()) used.add(entry.name);
    }
  } catch {
    // 基目录首次创建时不存在：忽略
  }
  const wanted = repoUrl ? repoSlug(repoUrl) : "";
  for (const inst of InstanceSubsystem.instances.values()) {
    const nickname = inst?.config?.nickname;
    if (!nickname) continue;
    if (wanted) {
      const tags = inst.config.tag;
      if (!Array.isArray(tags) || !tags.includes(wanted)) continue;
    }
    used.add(String(nickname));
  }
  return used;
}

// 在已占用名字里找形如 `${base}-<N>` 的最大 N（无则 0）
function maxIndexFor(base: string, used: Set<string>): number {
  const re = new RegExp(`^${escapeRegExp(base)}-(\\d+)$`);
  let max = 0;
  for (const n of used) {
    const m = re.exec(n);
    if (m) {
      const v = Number(m[1]);
      if (Number.isInteger(v) && v > max) max = v;
    }
  }
  return max;
}

// 标签集合归一化：拆分、去空、小写、去重、排序 → 规范 key。
// "gpu, A100" 与 "a100,GPU" 都 → "a100,gpu"，作为一个 label 组的唯一身份（与顺序/大小写/重复无关）。
export function labelKey(labels: string): string {
  return (labels || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort()
    .join(",");
}

// 一个仓库下、按 label 组聚合的既有 runner 概况。前端据此展示可复用的标签组。
export interface RepoLabelGroup {
  key: string; // labelKey，组身份
  labels: string; // 展示用原始标签（取组内首个 marker 的原样值）
  prefix: string; // 命名前缀（marker.group），「往后累加」的锚点
  count: number; // 现有数量
  maxIndex: number; // 现有 `${prefix}-N` 的最大 N
}

// 按 repo 聚合出该仓库已有的 label 组（只读）。数据源是「所有 tag 命中该 repo 的句柄实例」，
// 读各自 cwd 下的 .cipanel —— 因此跨基目录也能发现同一 repo 的既有组，与「采番按 repo」同范围。
// 无 labels 的 marker（v1 老 runner / import 导入）不计入——它们标签未知，不作为可复用组。
// baseDir 仍用于 collectUsedNames（把当前基目录的现存目录名纳入采番锚点、防覆盖）。
export function listRepoGroups(baseDir: string, repoUrl: string): RepoLabelGroup[] {
  const base = path.normalize((baseDir || "").trim());
  if (!path.isAbsolute(base) || base === "/")
    throw new Error("基目录必须是绝对路径且不能为根目录 /");
  const wanted = repoSlug(repoUrl);
  const used = collectUsedNames(base, repoUrl);
  const byKey = new Map<string, RepoLabelGroup>();
  const seenDirs = new Set<string>();
  for (const inst of InstanceSubsystem.instances.values()) {
    const cwd = inst?.config?.cwd;
    const tags = inst?.config?.tag;
    if (!cwd || !Array.isArray(tags) || !tags.includes(wanted)) continue;
    const dir = path.normalize(cwd);
    if (seenDirs.has(dir)) continue; // 每个目录只算一次
    seenDirs.add(dir);
    const m = readMarker(dir);
    if (!m || m.repo !== wanted || !m.labels) continue;
    const key = labelKey(m.labels);
    if (!key) continue;
    const prefix = m.group || path.basename(dir).replace(/-\d+$/, "");
    const g =
      byKey.get(key) ?? { key, labels: m.labels, prefix, count: 0, maxIndex: maxIndexFor(prefix, used) };
    g.count += 1;
    byKey.set(key, g);
  }
  return [...byKey.values()];
}

// 护栏：一个基目录只归一个仓库。扫描 baseDir 下的 .cipanel，若发现属于「其他仓库」的
// runner 就拒绝创建。混放会让采番陷入死结——避让所有磁盘目录则本仓库编号被对方顶高（飙号），
// 只避让本仓库目录则会物理覆盖对方目录。从源头禁止混放，让「目录 = 仓库」的前提恒成立。
function assertBaseDirRepo(baseDir: string, repoUrl: string): void {
  const wanted = repoSlug(repoUrl);
  let names: string[] = [];
  try {
    names = fs.readdirSync(baseDir);
  } catch {
    return; // 目录尚不存在：无冲突
  }
  const conflicts = new Set<string>();
  for (const name of names) {
    const m = readMarker(path.join(baseDir, name));
    if (m && m.repo && m.repo !== wanted) conflicts.add(m.repo);
  }
  if (conflicts.size)
    throw new Error(
      `基目录 ${baseDir} 已被仓库 [${[...conflicts].join(", ")}] 使用，` +
        `请为 ${wanted} 换一个独立的基目录（一个目录只归一个仓库）`
    );
}

// 校验参数并把多组展开成完整 runner 列表（含名字去重与总数上限）。
// 若某组标签命中该 repo 已有 label 组，强制对齐到既有命名前缀并从其 maxIndex 之后累加；
// aligned 汇总被对齐的组，供上层提示「已并入既有组」。
function expandBatchSpecs(p: ProvisionBatchParams): {
  repoUrl: string;
  token: string;
  proxy: string;
  specs: BatchSpec[];
  aligned: { baseName: string; labels: string; prefix: string }[];
} {
  const repoUrl = p.repoUrl;
  const token = p.token;
  const proxy = (p.proxy || "").trim();
  const baseDir = path.normalize(p.baseDir || "");

  if (!repoUrl || !/^https?:\/\/.+/.test(repoUrl)) throw new Error("仓库地址无效（需 http/https URL）");
  if (!token) throw new Error("注册 token 不能为空");
  if (!path.isAbsolute(baseDir) || baseDir === "/")
    throw new Error("基目录必须是绝对路径且不能为根目录 /");
  if (!Array.isArray(p.groups) || p.groups.length === 0) throw new Error("至少需要一组 runner");
  assertBaseDirRepo(baseDir, repoUrl); // 一个基目录只归一个仓库

  const specs: BatchSpec[] = [];
  const aligned: { baseName: string; labels: string; prefix: string }[] = [];
  // 已占用名字：磁盘上的既有目录 + 同 repo 已看护实例名 + 本批已分配。采番在此基础上往后连续排。
  const used = collectUsedNames(baseDir, repoUrl);
  // 该 repo 下已有的 label 组，用于把相同标签的新组对齐到既有命名前缀。
  const repoGroups = listRepoGroups(baseDir, repoUrl);
  for (const g of p.groups) {
    const base = (g.baseName || "").trim();
    const labels = (g.labels || "").trim();
    const count = Number(g.count) || 0;
    if (!base) throw new Error("runner 基础名不能为空");
    if (count < 1 || count > 99) throw new Error(`每组数量需在 1..99，收到 ${g.count}`);
    // 标签命中既有组（集合完全相等）→ 强制沿用既有前缀；否则新组用用户填的 base。
    const existing = labels ? repoGroups.find((rg) => rg.key === labelKey(labels)) : undefined;
    const prefix = existing ? existing.prefix : base;
    if (existing && existing.prefix !== base) aligned.push({ baseName: base, labels, prefix });
    // 接在已占用的最大同名编号之后，保证跨批/跨组/跨基目录连续、不覆盖既有 runner
    let i = maxIndexFor(prefix, used);
    for (let k = 0; k < count; k++) {
      i += 1;
      const name = `${prefix}-${i}`;
      const targetDir = path.join(baseDir, name);
      // used 已含现存目录名，正常采番不会撞；此处兜底并发/归一化差异下的竞态，宁可报错也不覆盖
      if (used.has(name) || fs.existsSync(targetDir))
        throw new Error(`runner 目录或名字已存在，拒绝覆盖: ${name}`);
      used.add(name);
      specs.push({ name, labels, targetDir, group: prefix });
    }
  }
  if (specs.length > 99) throw new Error(`单批最多 99 个 runner，当前 ${specs.length} 个`);
  return { repoUrl, token, proxy, specs, aligned };
}

// 同步批量（保留：一次性阻塞返回全部结果）
export async function provisionRunnerBatch(
  p: ProvisionBatchParams
): Promise<{ results: BatchItemResult[]; aligned: { baseName: string; labels: string; prefix: string }[] }> {
  const { repoUrl, token, proxy, specs, aligned } = expandBatchSpecs(p);
  logger.info(`[runner-provision] 批量: 共 ${specs.length} 个 runner`);
  const results: BatchItemResult[] = [];
  for (const s of specs) {
    try {
      const r = await provisionRunner({
        repoUrl,
        token,
        name: s.name,
        labels: s.labels,
        targetDir: s.targetDir,
        proxy,
        packagePath: p.packagePath,
        group: s.group
      });
      results.push({ name: s.name, ok: true, instanceUuid: r.instanceUuid });
    } catch (err: any) {
      // 单个失败不中断整批
      logger.error(`[runner-provision] ${s.name} 失败: ${err?.message}`);
      results.push({ name: s.name, ok: false, error: err?.message || String(err) });
    }
  }
  return { results, aligned };
}

// ---- 异步批量：后台逐个跑，前端轮询进度（每个 runner 有 状态 + 当前步骤）----
type BatchItemStatus = "pending" | "running" | "done" | "failed";
interface BatchItemState {
  name: string;
  status: BatchItemStatus;
  step: string;
  instanceUuid?: string;
  error?: string; // 简短错误（展示用）
  log?: string; // 完整错误日志（复制/下载用）
}
interface BatchState {
  items: BatchItemState[];
  specs: BatchSpec[]; // 与 items 同序，供"重试失败项"重跑
  repoUrl: string;
  proxy: string;
  packagePath?: string;
  concurrency: number; // 同时创建几个
  done: boolean;
  startedAt: number;
}
const batches = new Map<string, BatchState>();
let batchSeq = 0;

// 跑指定下标的项（初次跑全部；重试只跑失败项）。token 每次现传，不落存。
async function runBatchItems(id: string, token: string, indices: number[]) {
  const st = batches.get(id)!;
  st.done = false;

  // 限并发工作池：起 K 个 worker，各自从共享游标领任务，领空即退出。
  // 每个 item 独立更新自己的 status/step，进度上报不受并发影响。
  const conc = Math.min(clampConcurrency(st.concurrency), indices.length || 1);

  async function runOne(i: number) {
    const s = st.specs[i];
    const item = st.items[i];
    item.status = "running";
    item.step = "开始";
    item.error = undefined;
    item.log = undefined;
    try {
      const r = await provisionRunner({
        repoUrl: st.repoUrl,
        token,
        name: s.name,
        labels: s.labels,
        targetDir: s.targetDir,
        proxy: st.proxy,
        packagePath: st.packagePath,
        group: s.group,
        onStep: (step) => {
          item.step = step;
        }
      });
      item.status = "done";
      item.step = r.alreadyConfigured ? "完成（已注册，跳过）" : "完成";
      item.instanceUuid = r.instanceUuid;
    } catch (err: any) {
      logger.error(`[runner-provision] ${s.name} 失败: ${err?.message}`);
      item.status = "failed";
      item.step = "失败";
      item.error = err?.message || String(err);
      item.log = err?.fullLog || err?.message || String(err);
    }
  }

  let cursor = 0;
  async function worker() {
    while (true) {
      const at = cursor++;
      if (at >= indices.length) return;
      await runOne(indices[at]);
    }
  }
  await Promise.all(Array.from({ length: conc }, () => worker()));

  st.done = true;
  logger.info(`[runner-provision] 批量任务 ${id} 本轮结束（并发 ${conc}）`);
}

// 启动后台批量，立刻返回 batchId + 初始清单
export function startRunnerBatch(
  p: ProvisionBatchParams
): { batchId: string; items: { name: string }[]; aligned: { baseName: string; labels: string; prefix: string }[] } {
  const { repoUrl, token, proxy, specs, aligned } = expandBatchSpecs(p);
  const id = `b${++batchSeq}`;
  const items: BatchItemState[] = specs.map((s) => ({
    name: s.name,
    status: "pending",
    step: ""
  }));
  const concurrency = clampConcurrency(p.concurrency);
  batches.set(id, {
    items,
    specs,
    repoUrl,
    proxy,
    packagePath: p.packagePath,
    concurrency,
    done: false,
    startedAt: Date.now()
  });
  logger.info(
    `[runner-provision] 批量任务 ${id} 启动，共 ${specs.length} 个 runner（并发 ${concurrency}）`
  );
  // 后台跑，不阻塞
  runBatchItems(
    id,
    token,
    specs.map((_, i) => i)
  );
  return { batchId: id, items: items.map((i) => ({ name: i.name })), aligned };
}

// 重试某批的失败项：用新传入的 token（旧的可能已过期），可选覆盖代理。--replace 幂等，会收编 GitHub 孤儿。
export function retryFailedBatch(
  batchId: string,
  token: string,
  proxy?: string
): { batchId: string; retrying: number } {
  const st = batches.get(batchId);
  if (!st) throw new Error("批量任务不存在（可能已过期），请重新创建");
  if (!token || !String(token).trim()) throw new Error("重试需要提供注册 token");
  if (proxy !== undefined) st.proxy = resolveProxy(proxy);
  const failedIdx = st.items.map((it, i) => (it.status === "failed" ? i : -1)).filter((i) => i >= 0);
  if (!failedIdx.length) throw new Error("没有失败项可重试");
  // 先把失败项置回 pending，前端轮询能立刻看到"排队中"
  for (const i of failedIdx) {
    st.items[i].status = "pending";
    st.items[i].step = "等待重试";
  }
  logger.info(`[runner-provision] 批量任务 ${batchId} 重试 ${failedIdx.length} 个失败项`);
  runBatchItems(batchId, String(token).trim(), failedIdx);
  return { batchId, retrying: failedIdx.length };
}

// 查询批量进度
export function getRunnerBatchProgress(id: string) {
  const st = batches.get(id);
  if (!st) throw new Error("批量任务不存在（可能已过期）");
  const total = st.items.length;
  const doneCount = st.items.filter((i) => i.status === "done").length;
  const failCount = st.items.filter((i) => i.status === "failed").length;
  return {
    done: st.done,
    total,
    doneCount,
    failCount,
    items: st.items.map((i) => ({
      name: i.name,
      status: i.status,
      step: i.step,
      instanceUuid: i.instanceUuid,
      error: i.error,
      log: i.log
    }))
  };
}

// ---- 收集：扫描基目录，把"已注册(有 .runner)但面板还没建实例"的 runner 纳入看护 ----
export interface CollectResult {
  baseDir: string;
  collected: { name: string; instanceUuid: string; repo: string }[];
  skipped: { name: string; reason: string }[];
}

export function collectRunners(baseDir: string): CollectResult {
  const base = path.normalize((baseDir || "").trim());
  if (!path.isAbsolute(base) || base === "/")
    throw new Error("基目录必须是绝对路径且不能为根目录 /");
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory())
    throw new Error(`基目录不存在或不是目录: ${base}`);

  // 已看护的 cwd 集合（判重）
  const managed = new Set<string>();
  for (const inst of InstanceSubsystem.instances.values()) {
    const cwd = inst?.config?.cwd;
    if (cwd) managed.add(path.normalize(cwd));
  }

  const collected: CollectResult["collected"] = [];
  const skipped: CollectResult["skipped"] = [];

  for (const name of fs.readdirSync(base)) {
    const dir = path.join(base, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const hasRunner = fs.existsSync(path.join(dir, ".runner"));
    const hasRun = fs.existsSync(path.join(dir, "run.sh"));
    if (!hasRunner) {
      skipped.push({ name, reason: "未注册（无 .runner）" });
      continue;
    }
    if (!hasRun) {
      skipped.push({ name, reason: "缺 run.sh（安装包不完整）" });
      continue;
    }
    if (managed.has(path.normalize(dir))) {
      skipped.push({ name, reason: "已在看护" });
      continue;
    }
    // 从 .runner 读仓库地址与 agent 名（文件带 BOM，需去掉）
    let repo = "";
    let nickname = name;
    try {
      const raw = fs.readFileSync(path.join(dir, ".runner"), "utf8").replace(/^\uFEFF/, "");
      const j = JSON.parse(raw);
      if (j.gitHubUrl) repo = repoSlug(String(j.gitHubUrl));
      if (j.agentName) nickname = String(j.agentName);
    } catch {
      // .runner 解析失败：仍收集，只是没仓库标签
    }
    try {
      // 统一走 ensureHandleInstance：句柄实例只作抓手、不带启动命令（systemd 才跑 runner）
      const instanceUuid = ensureHandleInstance(dir, repo, nickname);
      // 纳入看护的同时写 .cipanel，让它进入日常展示；来源记为 import（既有 runner 被收编）
      writeMarker(dir, { source: "import", repo });
      managed.add(path.normalize(dir));
      collected.push({ name, instanceUuid, repo });
      logger.info(`[runner-collect] 纳入 ${name} → 实例 ${instanceUuid} (repo=${repo})`);
    } catch (err: any) {
      skipped.push({ name, reason: "建实例失败: " + (err?.message || String(err)) });
    }
  }
  logger.info(
    `[runner-collect] 扫描 ${base} 完成：纳入 ${collected.length}，跳过 ${skipped.length}`
  );
  return { baseDir: base, collected, skipped };
}

// ---- 检查：直接创建查版本/更新；导入压缩包查路径 ----
function parseRunnerVersion(p: string): string {
  const m = p.match(/(\d+\.\d+\.\d+)\.(?:tar\.gz|tgz)$/i);
  return m ? m[1] : "";
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function fetchLatestRunnerVersion(proxy?: string): Promise<string> {
  const cfg: any = { timeout: 10000, headers: { "User-Agent": "ci-panel" } };
  applyProxy(cfg, proxy);
  const res = await axios.get(
    "https://api.github.com/repos/actions/runner/releases/latest",
    cfg
  );
  const tag = res.data?.tag_name || ""; // 形如 v2.335.1
  return tag.replace(/^v/, "");
}

export interface CheckParams {
  mode: "direct" | "import";
  packagePath?: string;
  proxy?: string;
}

export async function checkRunnerPackage(params: CheckParams) {
  if (params.mode === "import") {
    const p = (params.packagePath || "").trim();
    if (!p) throw new Error("请先填写压缩包路径");
    const exists = fs.existsSync(p) && fs.statSync(p).isFile();
    const isTarGz = /\.tar\.gz$|\.tgz$/i.test(p);
    return {
      mode: "import",
      path: p,
      exists,
      isTarGz,
      sizeMB: exists ? Math.round((fs.statSync(p).size / 1e6) * 10) / 10 : 0,
      version: exists ? parseRunnerVersion(p) : ""
    };
  }

  // direct：取本地最高版本的包 + 尝试查 GitHub 最新版
  const local = resolveLocalPackage();
  const exists = fs.existsSync(local.path);
  const localVersion = local.version;
  let latestVersion = "";
  let updateAvailable = false;
  let checkError = "";
  try {
    latestVersion = await fetchLatestRunnerVersion(params.proxy);
    if (latestVersion && localVersion) {
      updateAvailable = cmpVersion(localVersion, latestVersion) < 0;
    }
  } catch (err: any) {
    checkError = err?.message || String(err);
  }
  return {
    mode: "direct",
    path: local.path,
    exists,
    localVersion,
    latestVersion,
    updateAvailable,
    checkError
  };
}

// ---- 下载：用 curl 从 GitHub 拉取（走代理 + 跟随重定向最稳；进度用轮询临时文件大小）----
interface DownloadState {
  total: number;
  received: number;
  done: boolean;
  error?: string;
  path: string;
  tmp: string;
  version: string;
  lastAt: number;
  lastReceived: number;
}
const downloads = new Map<string, DownloadState>();
let downloadSeq = 0;

// 通过 curl -sIL 拿最终 content-length（best-effort）
async function headContentLength(url: string, proxy: string): Promise<number> {
  // --http1.1 避开代理对 HTTP/2 的 framing 错误（curl code 92）
  const args = ["-sIL", "--http1.1", "--max-time", "25"];
  if (proxy) args.push("-x", proxy);
  args.push("-A", "ci-panel", url);
  const r = await run("curl", args, {});
  const matches = [...r.output.matchAll(/content-length:\s*(\d+)/gi)];
  return matches.length ? Number(matches[matches.length - 1][1]) : 0;
}

// 跑一次 curl（断点续传），返回退出码
function runCurlResume(url: string, tmp: string, proxy: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    // --http1.1 避开代理 HTTP/2 framing 错误(code 92)；-C - 断点续传；-L 跟随重定向
    const args = ["-sL", "--http1.1", "-C", "-", "--max-time", "0", "-A", "ci-panel", "-o", tmp];
    if (proxy) args.push("-x", proxy);
    args.push(url);
    const proc = spawn("curl", args, { shell: false });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (e) => resolve({ code: -1, stderr: e.message }));
    proc.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function doDownload(id: string, url: string, dest: string, proxy: string) {
  const st = downloads.get(id)!;
  const tmp = st.tmp;
  try {
    await fs.ensureDir(path.dirname(dest));
    if (fs.existsSync(tmp)) await fs.remove(tmp); // 清掉旧的部分文件
    st.total = await headContentLength(url, proxy).catch(() => 0);

    // 代理不稳会中途断连，用断点续传 + 重试直到下完
    const MAX_ATTEMPTS = 40;
    let ok = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { code, stderr } = await runCurlResume(url, tmp, proxy);
      const size = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
      // 完成判据：curl 成功 或 已下到总大小
      if ((code === 0 || (st.total && size >= st.total)) && size > 0) {
        if (!st.total || size >= st.total) {
          ok = true;
          break;
        }
      }
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`下载多次中断未完成 (最后 code=${code}) ${stderr.slice(-160)}`);
      }
      logger.info(
        `[runner-download] 第 ${attempt} 次中断(code=${code})，已下 ${Math.round(size / 1e6)}MB，续传中…`
      );
      await sleep(1500);
    }

    await fs.move(tmp, dest, { overwrite: true });
    if (st.total) st.received = st.total;
    st.done = true;
    logger.info(`[runner-download] 完成: ${dest}`);
  } catch (err: any) {
    st.error = err?.message || String(err);
    st.done = true;
    try {
      if (fs.existsSync(tmp)) await fs.remove(tmp);
    } catch {
      // ignore
    }
    logger.error(`[runner-download] 失败: ${st.error}`);
  }
}

export async function startRunnerDownload(params: {
  version?: string;
  proxy?: string;
  force?: boolean; // 本地已有同版本包时是否强制重下（覆盖）；默认 false → 跳过
}): Promise<{ downloadId: string; version: string; url: string; skipped: boolean }> {
  const proxy = resolveProxy(params.proxy);
  logger.info(`[runner-download] 代理: ${proxy || "(直连)"}`);
  const version = (params.version || "").trim() || (await fetchLatestRunnerVersion(proxy));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`无法确定要下载的版本: ${version}`);
  const arch = runnerArch();
  const file = `actions-runner-linux-${arch}-${version}.tar.gz`;
  const url = `https://github.com/actions/runner/releases/download/v${version}/${file}`;
  const dest = path.join(RUNNER_PKG_DIR, file);
  const id = `dl${++downloadSeq}`;

  // 本地已有同版本包：默认直接跳过下载，造一个"已完成"任务让前端进度轮询立刻拿到 done+path。
  // 需要覆盖重下时前端传 force:true。
  if (!params.force) {
    let existingSize = 0;
    try {
      if (fs.existsSync(dest)) existingSize = fs.statSync(dest).size;
    } catch {
      // ignore
    }
    if (existingSize > 0) {
      downloads.set(id, {
        total: existingSize,
        received: existingSize,
        done: true,
        path: dest,
        tmp: `${dest}.downloading`,
        version,
        lastAt: Date.now(),
        lastReceived: existingSize
      });
      logger.info(`[runner-download] 本地已有同版本，跳过下载: ${dest}`);
      return { downloadId: id, version, url, skipped: true };
    }
  }

  downloads.set(id, {
    total: 0,
    received: 0,
    done: false,
    path: dest,
    tmp: `${dest}.downloading`,
    version,
    lastAt: Date.now(),
    lastReceived: 0
  });
  logger.info(`[runner-download] 开始 ${version} (${arch}) → ${dest}`);
  // 后台下载，不阻塞
  doDownload(id, url, dest, proxy);
  return { downloadId: id, version, url, skipped: false };
}

export function getRunnerDownloadProgress(id: string) {
  const st = downloads.get(id);
  if (!st) throw new Error("下载任务不存在（可能已过期）");
  // curl 边下边写临时文件，进度 = 临时文件当前大小（完成后临时文件已 move 走，用 total）
  if (!st.done) {
    try {
      st.received = fs.existsSync(st.tmp) ? fs.statSync(st.tmp).size : 0;
    } catch {
      // ignore
    }
  }
  const now = Date.now();
  const dt = (now - st.lastAt) / 1000;
  const speed = dt > 0 ? Math.max(0, Math.round((st.received - st.lastReceived) / dt)) : 0;
  st.lastAt = now;
  st.lastReceived = st.received;
  return {
    total: st.total,
    received: st.received,
    percent: st.total ? Math.round((st.received / st.total) * 100) : 0,
    speed, // bytes/s
    done: st.done,
    error: st.error,
    version: st.version,
    // 只有成功完成才返回路径（供创建时用）
    path: st.done && !st.error ? st.path : ""
  };
}
