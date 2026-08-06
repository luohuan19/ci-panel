// CI Panel 扩展：管理 runner 的环境变量。两个目标、两套语义（这批机器 runsvc.sh 不 source .env）：
//
//   override —— systemd drop-in /etc/systemd/system/<svc>.d/override.conf 的 Environment=。
//               进「监听进程」，代理这类要让 Runner.Listener 连上 GitHub 的变量必须放这里。
//               需 root：set 走特权助手 ci-panel-runner-svc(sudo -n)；读免 sudo(0644)。
//   dotenv  —— runner 目录下的 .env。runsvc 不 source 它，故不进监听进程，只被 runner 程序
//               读取、注入到每个 job/step 的执行环境（设备号、库路径这类）。文件属主即 daemon
//               运行用户(ci-runner)，故读写都直接走 fs，无需 sudo、无需 daemon-reload。
//
// 两个目标都是「面板整表托管」：读回显 → 用户编辑 → 覆盖写回。变量名白名单、值禁换行，防注入。
import fs from "fs-extra";
import path from "path";
import logger from "./log";
import { assertUnderRoots, readServiceName as readUnitFile } from "./runner_scan";
import { setServiceEnv } from "./runner_provision";
import { dirKey, serviceKey, withRunnerLock } from "./runner_lock";
import {
  dotenvPath,
  sanitizeEnvVars,
  writeDotEnvFile,
  type RunnerEnvVar
} from "./runner_env_vars";

// 单元名正则，与 daemon controlService / 助手脚本保持一致，防路径穿越。
// 三处各写一份是刻意的边界冗余，一致性由 daemon/test/security/service_name_boundary.spec.ts 盯住。
const SERVICE_RE = /^actions\.runner\.[A-Za-z0-9._@-]+\.service$/;

// 写入目标：systemd drop-in 或 runner 目录的 .env
export type EnvTarget = "override" | "dotenv";

export type { RunnerEnvVar };

// 单个目标文件的一节：是否存在 + 其中的变量
export interface RunnerEnvSection {
  present: boolean; // 目标文件是否已存在
  vars: RunnerEnvVar[];
  // 读取失败的原因（权限、EIO 等）。有值时 vars 不可信：merge 写入必须中止，
  // 否则会把读不到的既有变量当成「本来就没有」而整份覆盖掉。
  error?: string;
}

export interface RunnerEnvResult {
  dir: string;
  service: string; // systemd 单元名，空 = 未装服务
  hasSystemd: boolean; // 是否装了 systemd 服务（未装则不能写 override）
  override: RunnerEnvSection; // systemd drop-in override.conf（进监听进程）
  dotenv: RunnerEnvSection; // runner 目录 .env（只进 job/step）
}

// set 的补丁：replace=true 时整表覆盖(upsert 即完整清单)；否则合并(upsert 增改、remove 删)。
export interface RunnerEnvPatch {
  upsert?: RunnerEnvVar[];
  remove?: string[];
  replace?: boolean;
}

// 校验并规范化 runner 目录：绝对路径、在扫描根内、含 .runner
function normalizeRunnerDir(dirRaw: string): string {
  const dir = path.normalize(String(dirRaw || ""));
  assertUnderRoots(dir);
  if (!fs.existsSync(path.join(dir, ".runner")))
    throw new Error(`不是 runner 目录(缺 .runner): ${dir}`);
  return dir;
}

// 读 <dir>/.service 拿单元名；未装服务(读不到)返回空串，但内容非法必须抛——
// 校验放在读取之外，避免用错误信息子串来决定是否 rethrow（改一个字就会静默降级）。
function readServiceName(dir: string): string {
  const svc = readUnitFile(dir);
  if (svc && !SERVICE_RE.test(svc)) throw new Error(`非法的服务名: ${svc}`);
  return svc;
}

function overrideConfPath(service: string): string {
  return path.join("/etc/systemd/system", `${service}.d`, "override.conf");
}

// 解析一行 Environment= 后半段：支持 "K=V" 双引号(含 \" \\ 转义)与裸 token，空白分隔多条。
function parseEnvironmentLine(rest: string): RunnerEnvVar[] {
  const out: RunnerEnvVar[] = [];
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && /\s/.test(rest[i])) i++;
    if (i >= rest.length) break;
    let token = "";
    if (rest[i] === '"') {
      i++;
      while (i < rest.length && rest[i] !== '"') {
        if (rest[i] === "\\" && i + 1 < rest.length) {
          token += rest[i + 1];
          i += 2;
        } else {
          token += rest[i];
          i++;
        }
      }
      i++; // 跳过收尾引号
    } else {
      while (i < rest.length && !/\s/.test(rest[i])) {
        token += rest[i];
        i++;
      }
    }
    const eq = token.indexOf("=");
    // systemd 说明符还原：写入时字面 % 被转义成 %%（见助手脚本 set-env），读回时还原，
    // 否则「读→回显→保存」每过一轮就把 % 翻一倍。
    if (eq > 0)
      out.push({ key: token.slice(0, eq), value: token.slice(eq + 1).replace(/%%/g, "%") });
  }
  return out;
}

// 解析 override.conf 里的 Environment= 行。空 Environment=(重置标记)跳过。
function parseOverrideConf(text: string): RunnerEnvVar[] {
  const vars: RunnerEnvVar[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("Environment=")) continue;
    const rest = line.slice("Environment=".length).trim();
    if (!rest) continue; // 空 Environment= 是重置标记，无值
    vars.push(...parseEnvironmentLine(rest));
  }
  return vars;
}

// 解析 .env：每行 KEY=VALUE，按首个 = 切分，值原样（不去引号）。跳过空行与 # 注释。
function parseDotEnv(text: string): RunnerEnvVar[] {
  const vars: RunnerEnvVar[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    vars.push({ key: line.slice(0, eq).trim(), value: line.slice(eq + 1) });
  }
  return vars;
}

// 读某目标文件并解析为一节。文件不存在 = present:false（正常空态）；
// 读失败 = 带 error（与「空」区分开，写入路径据此中止，避免误删）。
function readSection(file: string, parse: (t: string) => RunnerEnvVar[]): RunnerEnvSection {
  try {
    if (!fs.existsSync(file)) return { present: false, vars: [] };
    return { present: true, vars: parse(fs.readFileSync(file, "utf8")) };
  } catch (err: any) {
    const msg = err?.message || String(err);
    logger.warn(`[runner-env] 读 ${file} 失败: ${msg}`);
    return { present: true, vars: [], error: msg };
  }
}

// 读某 runner 两个目标当前托管的环境变量（面板回显用，均只读、免 sudo）
export function readRunnerEnv(dirRaw: string): RunnerEnvResult {
  const dir = normalizeRunnerDir(dirRaw);
  const service = readServiceName(dir);
  return {
    dir,
    service,
    hasSystemd: Boolean(service),
    override: service
      ? readSection(overrideConfPath(service), parseOverrideConf)
      : { present: false, vars: [] },
    dotenv: readSection(dotenvPath(dir), parseDotEnv)
  };
}

// 计算「目标全量」：replace 直接用 upsert；merge 用 current 打底、应用 upsert/remove。
// merge 保留各 runner 自己已有的变量（如每台不同的 DEVICE_ID），只增改指定项、删除 remove。
function resolveDesired(current: RunnerEnvVar[], patch: RunnerEnvPatch): RunnerEnvVar[] {
  const upsert = sanitizeEnvVars(Array.isArray(patch.upsert) ? patch.upsert : []);
  if (patch.replace) return upsert;
  const removeSet = new Set((Array.isArray(patch.remove) ? patch.remove : []).map(String));
  const map = new Map<string, string>();
  for (const v of current) map.set(v.key, v.value); // 当前值打底
  for (const v of upsert) map.set(v.key, v.value); // upsert 覆盖
  for (const k of removeSet) map.delete(k); // remove 删除
  return sanitizeEnvVars(Array.from(map, ([key, value]) => ({ key, value })));
}

// 写 override.conf：算出目标全量 → 特权助手写 drop-in + daemon-reload（不重启）。
// 助手调用本身在 runner_provision（置备时写初始变量走的是同一条路），这里只加一道
// 「没装服务就别写」的前置判断。
async function writeOverride(
  dir: string,
  service: string,
  desired: RunnerEnvVar[]
): Promise<void> {
  if (!service) throw new Error("该 runner 未装 systemd 服务，无法设置 systemd 环境变量");
  await setServiceEnv(dir, desired);
}

// 设置某 runner 某目标的环境变量。override 需 systemd；dotenv 直接写文件。
// 均不重启：生效由面板另走已白名单的 restart（带 busy 拦截）。
export async function writeRunnerEnv(
  dirRaw: string,
  target: EnvTarget,
  patch: RunnerEnvPatch
): Promise<RunnerEnvResult> {
  const dir = normalizeRunnerDir(dirRaw);
  // 同样与删除互斥：override 是往 /etc/systemd/system/<svc>.d/ 写 drop-in，删除窗口里放行
  // 它，就会给一个正被卸掉的单元留下 drop-in 目录（助手的 uninstall 不清它）。
  // 只有 override 占单元名这个 key：dotenv 只写 <dir>/.env，与单元无关，占了反而会和一次
  // 慢重启(助手 60 秒超时)互相挡——而「存 .env → 另点重启生效」正是页面上的常规操作顺序。
  const service = readServiceName(dir);
  const keys = [dirKey(dir)];
  if (service && target === "override") keys.push(serviceKey(service));
  return withRunnerLock(keys, "env", async () => {
    const current = readRunnerEnv(dir);
    const section = target === "override" ? current.override : current.dotenv;
    // merge 以当前值打底，读不出来就不能写：否则会把既有变量当成「没有」而整份抹掉。
    // replace 是整表覆盖、不依赖当前值，读失败不影响。
    if (section.error && !patch?.replace)
      throw new Error(`读取现有环境变量失败，已中止写入以免误删：${section.error}`);
    const desired = resolveDesired(section.vars, patch || {});
    if (target === "override") await writeOverride(dir, current.service, desired);
    else writeDotEnvFile(dir, desired);
    return readRunnerEnv(dir);
  });
}
