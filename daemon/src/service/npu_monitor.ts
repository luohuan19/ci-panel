// CI Panel 扩展：昇腾 NPU(Ascend)占用率采集，数据来自 npu-smi。
//
// 为什么要后台采样 + 缓存，而不是每次请求现跑：
//   `npu-smi info` 一次要 ~1.7s（逐颗 `-t usages` 更慢，0.64s × 16 颗 ≈ 10s），
//   而面板 3 秒一轮询，同步跑必然把请求拖死。所以这里定时采样、请求只读缓存。
// 且「有人看才采」：首次请求才启动采样，超过 IDLE_STOP_MS 没人问就自动停，
//   免得没人看时还每 5 秒 fork 一个进程。
//
// npu-smi 不需要 sudo。机器上没有它（非 NPU 节点）时 available=false，不会反复重试。
import { execFile } from "child_process";
import logger from "./log";

const NPU_SMI = process.env.CIP_NPU_SMI || "npu-smi";
const SAMPLE_MS = Number(process.env.CIP_NPU_SAMPLE_MS) || 5000;
const IDLE_STOP_MS = 60_000; // 超过这么久没人请求就停采样
const CHART_LEN = 30; // 平均利用率历史点数
const EXEC_TIMEOUT = 15_000;

export interface NpuChip {
  npuId: number; // 卡号
  chipId: number; // 卡内芯片号
  phyId: number; // 物理 ID（npu-smi 的 Phy-ID）
  name: string; // Ascend910
  health: string; // OK / ...
  power: number; // W；同卡第二颗芯片 npu-smi 给 "-"，此时为 0
  temp: number; // ℃
  util: number; // AICore(%)：算力占用，就是「NPU 占用率」
  hbmUsed: number; // MB
  hbmTotal: number; // MB
}

export interface NpuStatus {
  available: boolean; // 这台机器有没有 npu-smi / 能不能取到
  chips: NpuChip[];
  avgUtil: number; // 所有芯片平均占用率
  busyChips: number; // 占用率 >= BUSY_THRESHOLD 的芯片数
  hbmUsed: number; // 合计 MB
  hbmTotal: number; // 合计 MB
  chart: number[]; // 平均占用率历史（给走势图）
  sampledAt: number;
  error?: string;
}

const BUSY_THRESHOLD = 50;

let cache: NpuStatus = {
  available: false,
  chips: [],
  avgUtil: 0,
  busyChips: 0,
  hbmUsed: 0,
  hbmTotal: 0,
  chart: [],
  sampledAt: 0
};
let timer: NodeJS.Timeout | undefined;
let sampling = false; // 防重入：上一次还没跑完就别再 fork
let lastRequestAt = 0;
let unsupported = false; // npu-smi 不存在，别再重试

function runNpuSmi(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(NPU_SMI, args, { timeout: EXEC_TIMEOUT, encoding: "utf8" }, (err, stdout) => {
      if (err) return reject(err);
      resolve(String(stdout));
    });
  });
}

// 解析 `npu-smi info` 的表格。每颗芯片占两行：
//   | 0     Ascend910           | OK            | 166.3                36        0    / 0        |
//   | 0     0                   | 0000:9D:00.0  | 100                  0    / 0  3985 / 65536    |
// 第一行给 卡号/名称/健康/功率/温度，第二行给 芯片号/Phy-ID/Bus-Id/AICore%/Memory/HBM。
// 注意 -m 里还有 Mcu 行（管理控制器，不是真 NPU），本表不含它，无需额外过滤。
export function parseNpuSmiInfo(text: string): NpuChip[] {
  const chips: NpuChip[] = [];
  const lines = String(text).split("\n");
  // 卡行：| <npuId> <Name> | <Health> | <Power> <Temp> <Hugepages a / b> |
  // Name 必须以字母开头（Ascend910）——否则这个模式会把芯片行也吃掉：芯片行第二列是
  // 纯数字的 Phy-ID，用 \S+ 同样能匹配，会导致芯片行永远轮不到 chipRe（解析结果为空）。
  const npuRe = /^\|\s*(\d+)\s+([A-Za-z]\S*)\s*\|\s*(\S+)\s*\|\s*([\d.]+|-)\s+([\d.]+|-)\s+/;
  // 芯片行：| <chipId> <phyId> | <BusId> | <AICore%> <mem a / b> <hbm a / b> |
  const chipRe =
    /^\|\s*(\d+)\s+(\d+)\s*\|\s*([0-9a-fA-F]{4}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.\d)\s*\|\s*(\d+|-)\s+(\d+)\s*\/\s*(\d+)\s+(\d+)\s*\/\s*(\d+)/;

  let pending: { npuId: number; name: string; health: string; power: number; temp: number } | null =
    null;

  for (const line of lines) {
    // 先试更特征化的芯片行（有 Bus-Id 形态），避免和卡行互相误吃
    const m2 = chipRe.exec(line);
    if (m2 && pending) {
      chips.push({
        npuId: pending.npuId,
        chipId: Number(m2[1]),
        phyId: Number(m2[2]),
        name: pending.name,
        health: pending.health,
        power: pending.power,
        temp: pending.temp,
        util: m2[4] === "-" ? 0 : Number(m2[4]),
        hbmUsed: Number(m2[7]),
        hbmTotal: Number(m2[8])
      });
      pending = null;
      continue;
    }
    const m1 = npuRe.exec(line);
    if (m1) {
      pending = {
        npuId: Number(m1[1]),
        name: m1[2],
        health: m1[3],
        power: m1[4] === "-" ? 0 : Number(m1[4]),
        temp: m1[5] === "-" ? 0 : Number(m1[5])
      };
    }
  }
  return chips;
}

async function sampleOnce() {
  if (sampling) return;
  sampling = true;
  try {
    const out = await runNpuSmi(["info"]);
    const chips = parseNpuSmiInfo(out);
    const avg = chips.length
      ? Math.round(chips.reduce((s, c) => s + c.util, 0) / chips.length)
      : 0;
    const chart = [...cache.chart, avg].slice(-CHART_LEN);
    cache = {
      available: chips.length > 0,
      chips,
      avgUtil: avg,
      busyChips: chips.filter((c) => c.util >= BUSY_THRESHOLD).length,
      hbmUsed: chips.reduce((s, c) => s + c.hbmUsed, 0),
      hbmTotal: chips.reduce((s, c) => s + c.hbmTotal, 0),
      chart,
      sampledAt: Date.now()
    };
  } catch (err: any) {
    // 命令不存在 → 这台机器没 NPU，别再重试，省得每 5 秒 fork 一次
    if (err?.code === "ENOENT") {
      unsupported = true;
      stopSampler();
      cache = { ...cache, available: false, error: "该节点没有 npu-smi（非 NPU 机器）" };
      logger.info("[npu] 未找到 npu-smi，关闭 NPU 采集");
    } else {
      cache = { ...cache, available: false, error: err?.message || String(err) };
      logger.warn(`[npu] 采样失败: ${err?.message || err}`);
    }
  } finally {
    sampling = false;
  }
}

function stopSampler() {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

function ensureSampler() {
  if (unsupported || timer) return;
  logger.info(`[npu] 启动 NPU 采集（每 ${SAMPLE_MS}ms）`);
  sampleOnce();
  timer = setInterval(() => {
    // 没人看就自动停，下次有人请求会重新拉起
    if (Date.now() - lastRequestAt > IDLE_STOP_MS) {
      logger.info("[npu] 无人查看，暂停 NPU 采集");
      stopSampler();
      return;
    }
    sampleOnce();
  }, SAMPLE_MS);
}

// 读当前快照（只读缓存，不阻塞）。首次调用会拉起后台采样。
export function getNpuStatus(): NpuStatus {
  lastRequestAt = Date.now();
  ensureSampler();
  return cache;
}
