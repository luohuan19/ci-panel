<script setup lang="ts">
// 「添加 Runner」对话框（批量 + 多组）：
// 共享 仓库/token/代理/基目录；每组 {基础名, 标签, 数量} → 生成 <基础名>-1..-N，
// 每个 runner 目录 = 基目录/<name>。无自带按钮，外部通过 ref 调 open() 触发。
import { ref, reactive, computed } from "vue";
import { message } from "ant-design-vue";
import { PlusOutlined, DeleteOutlined, FolderOpenOutlined } from "@ant-design/icons-vue";
import { onUnmounted } from "vue";
import { openNodeSelectDialog } from "@/components/fc/index";
import SelectDirDialog from "./SelectDirDialog.vue";
import {
  checkRunnerPackage,
  startRunnerDownload,
  runnerDownloadProgress,
  startRunnerBatch,
  runnerBatchProgress,
  retryRunnerBatch,
  collectRunners,
  runnerRepoGroups,
  listRunnerDirs,
  type RunnerBatchProgressItem,
  type RepoLabelGroup
} from "@/services/apis/runner";

const emit = defineEmits<{ (e: "created"): void }>();

const open = ref(false);
const submitting = ref(false);
const daemonId = ref("");
// direct = 用内置 GitHub runner 包；import = 用指定的 tar.gz 安装包
const mode = ref<"direct" | "import">("direct");

const shared = reactive({
  repoUrl: "",
  token: "",
  baseDir: "",
  // 默认预填可用代理：直连 GitHub CDN 常被重置，拉取/注册都需要走代理
  proxy: "http://127.0.0.1:7892",
  packagePath: "",
  // 同时创建几个（1..10）。代理脆时别调太高，并行注册挤同一代理易触发重试风暴。
  // 存字符串是为了绑 a-input（与其它字段同款控件，高度一致），发送时再 Number()
  concurrency: "3"
});

// 从 GitHub 给的 `./config.sh --url <仓库> --token <token>` 命令里解析并回填仓库地址与 token，
// 省得手动分别复制两个字段。粘贴即解析。
const cmdPaste = ref("");
function parseCmd() {
  const s = cmdPaste.value || "";
  const url = s.match(/--url\s+(\S+)/);
  const token = s.match(/--token\s+(\S+)/);
  if (url) shared.repoUrl = url[1];
  if (token) shared.token = token[1];
}

// number 输入用的是 a-input（原生 max 不拦输入），失焦时把值钳制到范围内；空/非法回落到 min
function clampStr(v: string, min: number, max: number): string {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return String(min);
  return String(Math.min(max, Math.max(min, n)));
}

// 基目录选择器：打开服务器端目录浏览/新建弹窗，选定后回填 baseDir
const dirDialog = ref<InstanceType<typeof SelectDirDialog>>();
function openDirPicker() {
  if (!daemonId.value) return message.error("请先选择节点");
  dirDialog.value?.openDialog(daemonId.value, shared.baseDir.trim() || undefined);
}

interface Group {
  baseName: string;
  labels: string;
  count: string; // 绑 a-input（同款控件保证高度一致）；用到时 Number(g.count)
}
const groups = ref<Group[]>([{ baseName: "", labels: "linux,arm64", count: "1" }]);

const addGroup = () => groups.value.push({ baseName: "", labels: "linux,arm64", count: "1" });
const removeGroup = (i: number) => groups.value.length > 1 && groups.value.splice(i, 1);

// 标签集合归一化，与 daemon 端 labelKey 保持一致：拆分、去空、小写、去重、排序。
// 用于判断某组标签是否命中该仓库已有的 label 组（顺序/大小写/重复无关）。
function labelKey(labels: string): string {
  return (labels || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort()
    .join(",");
}

// 该仓库在当前基目录下已有的 label 组（来自后端扫描 .cipanel）。用于复用标签与锁定命名。
const repoGroups = ref<RepoLabelGroup[]>([]);
const loadingGroups = ref(false);

// 拉取已有 label 组：需已选节点且填了仓库地址与基目录。任一缺失或出错则清空（不打扰用户）。
async function fetchRepoGroups() {
  const repoUrl = shared.repoUrl.trim();
  const baseDir = shared.baseDir.trim();
  if (!daemonId.value || !/^https?:\/\/.+/.test(repoUrl) || !baseDir) {
    repoGroups.value = [];
    return;
  }
  loadingGroups.value = true;
  try {
    const { execute, state } = runnerRepoGroups();
    await execute({ params: { daemonId: daemonId.value }, data: { baseDir, repoUrl } });
    repoGroups.value = state.value?.groups || [];
  } catch {
    repoGroups.value = []; // 基目录尚不存在/节点不可达等：视为无已有组
  } finally {
    loadingGroups.value = false;
  }
}

// 基目录是否已存在：null=未知/未查，true=存在，false=不存在（提交时会自动新建，只做轻提示）。
const baseDirExists = ref<boolean | null>(null);

// 查基目录是否存在。listDirs 对不存在的路径会报错，据此判定；节点/路径缺失时置 null（不打扰）。
async function checkBaseDir() {
  const baseDir = shared.baseDir.trim();
  if (!daemonId.value || !baseDir) {
    baseDirExists.value = null;
    return;
  }
  try {
    const { execute } = listRunnerDirs();
    await execute({ params: { daemonId: daemonId.value }, data: { path: baseDir } });
    baseDirExists.value = true;
  } catch {
    baseDirExists.value = false; // 目录不存在（或不可达）：提示将自动新建
  }
}

// baseDir 变更：同时刷新已有标签组与目录存在性提示。
function onBaseDirChange() {
  fetchRepoGroups();
  checkBaseDir();
}

// 某组标签命中的既有 label 组（完全相等才算），否则 null → 走新组逻辑。
function matchOf(g: Group): RepoLabelGroup | null {
  const key = labelKey(g.labels);
  if (!key) return null;
  return repoGroups.value.find((rg) => rg.key === key) || null;
}

// 点击已有标签组 chip：新增一组、预填其标签，命名交给后端对齐（基础名留空）。
function reuseGroup(rg: RepoLabelGroup) {
  groups.value.push({ baseName: rg.prefix, labels: rg.labels, count: "1" });
}

// 预览：将创建的全部 runner 名。命中既有 label 组的，沿用其前缀并从 maxIndex+1 起累加，
// 与后端对齐逻辑一致；同前缀在本批内也连续排号，避免预览自相矛盾。
const allNames = computed(() => {
  const names: string[] = [];
  const nextIndex = new Map<string, number>(); // prefix → 下一个可用编号
  for (const g of groups.value) {
    const matched = matchOf(g);
    const prefix = matched ? matched.prefix : g.baseName.trim();
    const n = Number(g.count) || 0;
    if (!prefix || n < 1) continue;
    let i = nextIndex.get(prefix) ?? (matched ? matched.maxIndex : 0);
    for (let k = 0; k < n; k++) names.push(`${prefix}-${++i}`);
    nextIndex.set(prefix, i);
  }
  return names;
});
const previewText = computed(() => {
  const names = allNames.value;
  if (!names.length) return "（填写基础名与数量后预览）";
  const head = names.slice(0, 12).join(", ");
  return names.length > 12 ? `${head} … 等 ${names.length} 个` : head;
});

// 检查结果
const checking = ref(false);
const checkText = ref("");
const checkOk = ref<boolean | null>(null);

// 下载（拉取最新版）状态
const downloading = ref(false);
const dlPercent = ref(0);
const dlSpeed = ref(0); // bytes/s
const dlVersion = ref("");
const downloadedPath = ref(""); // 下载完成后的包路径，用于创建
let dlTimer: ReturnType<typeof setTimeout> | null = null;

const stopPolling = () => {
  if (dlTimer) {
    clearTimeout(dlTimer);
    dlTimer = null;
  }
};

// 批量创建进度（后台跑 + 轮询）
const batchItems = ref<RunnerBatchProgressItem[]>([]);
const batchRunning = ref(false); // 后台任务是否仍在跑
const batchDone = ref(false); // 是否已全部结束
const batchStat = reactive({ total: 0, doneCount: 0, failCount: 0 });
const currentBatchId = ref(""); // 当前批次 id，用于重试失败项
const retryToken = ref(""); // 重试时重新填的注册 token
const retrying = ref(false);
const collecting = ref(false);
let batchTimer: ReturnType<typeof setTimeout> | null = null;

const stopBatchPolling = () => {
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
};

const resetBatch = () => {
  stopBatchPolling();
  batchItems.value = [];
  batchRunning.value = false;
  batchDone.value = false;
  batchStat.total = 0;
  batchStat.doneCount = 0;
  batchStat.failCount = 0;
  currentBatchId.value = "";
  retryToken.value = "";
  retrying.value = false;
};

// 轮询某批进度，刷新每个 runner 的状态 + 当前步骤（submit / 重试共用）
const pollBatch = (batchId: string) => {
  const poll = async () => {
    try {
      const { execute, state } = runnerBatchProgress();
      await execute({ params: { daemonId: daemonId.value }, data: { batchId } });
      const p: any = state.value || {};
      if (Array.isArray(p.items)) batchItems.value = p.items;
      batchStat.total = p.total ?? batchStat.total;
      batchStat.doneCount = p.doneCount ?? 0;
      batchStat.failCount = p.failCount ?? 0;
      if (p.done) {
        batchRunning.value = false;
        batchDone.value = true;
        if (p.doneCount > 0) {
          shared.token = "";
          emit("created");
        }
        if (p.failCount > 0) {
          message.warning(`本轮结束：成功 ${p.doneCount}，失败 ${p.failCount}（可重试失败项）`);
        } else {
          message.success(`已成功注册并创建 ${p.doneCount} 个 runner 实例，去列表启动`);
        }
        return;
      }
      batchTimer = setTimeout(poll, 800);
    } catch (err: any) {
      batchRunning.value = false;
      message.error("进度查询失败：" + (err?.message || err));
    }
  };
  poll();
};

// 重试失败项：用重新填的 token 对本批失败的 runner 重跑注册（--replace 幂等，会收编 GitHub 孤儿）
const retryFailed = async () => {
  if (!currentBatchId.value) return message.error("没有可重试的批次");
  if (!retryToken.value.trim()) return message.error("请重新填写注册 token（旧的多半已过期）");
  retrying.value = true;
  try {
    const { execute, state } = retryRunnerBatch();
    await execute({
      params: { daemonId: daemonId.value },
      data: {
        batchId: currentBatchId.value,
        token: retryToken.value.trim(),
        proxy: shared.proxy.trim()
      }
    });
    const r: any = state.value || {};
    if (!r.batchId) throw new Error("重试启动失败");
    batchDone.value = false;
    batchRunning.value = true;
    retryToken.value = "";
    pollBatch(currentBatchId.value);
  } catch (err: any) {
    message.error("重试失败：" + (err?.message || err));
  } finally {
    retrying.value = false;
  }
};

// 扫描并收集：把基目录下"已注册(有 .runner)但面板没建实例"的 runner 纳入看护
const collect = async () => {
  const base = shared.baseDir.trim();
  if (!base) return message.error("请先填写基目录");
  collecting.value = true;
  try {
    const { execute, state } = collectRunners();
    await execute({ params: { daemonId: daemonId.value }, data: { baseDir: base } });
    const r: any = state.value || {};
    const got = r.collected?.length || 0;
    const skip = r.skipped?.length || 0;
    if (got > 0) {
      emit("created");
      message.success(`已收集 ${got} 个 runner 纳入看护${skip ? `，跳过 ${skip}` : ""}`);
    } else {
      message.info(`没有可收集的 runner（跳过 ${skip} 个：均已看护或未注册）`);
    }
  } catch (err: any) {
    message.error("收集失败：" + (err?.message || err));
  } finally {
    collecting.value = false;
  }
};

onUnmounted(() => {
  stopPolling();
  stopBatchPolling();
});

const fmtSpeed = (bps: number) => {
  if (bps >= 1e6) return (bps / 1e6).toFixed(1) + " MB/s";
  if (bps >= 1e3) return (bps / 1e3).toFixed(0) + " KB/s";
  return bps + " B/s";
};

const openDialog = async (m: "direct" | "import" = "direct") => {
  try {
    const node = await openNodeSelectDialog();
    if (!node) return;
    daemonId.value = node.uuid;
    mode.value = m;
    checkText.value = "";
    checkOk.value = null;
    stopPolling();
    downloading.value = false;
    dlPercent.value = 0;
    dlSpeed.value = 0;
    dlVersion.value = "";
    downloadedPath.value = "";
    repoGroups.value = []; // 清掉上次会话的已有组，换节点/仓库后重新拉取
    baseDirExists.value = null;
    resetBatch();
    open.value = true;
    // 若已预填仓库地址与基目录，进来即拉一次已有 label 组 + 目录存在性
    fetchRepoGroups();
    checkBaseDir();
  } catch {
    // 用户取消
  }
};

defineExpose({ open: openDialog });

// 直接创建 → 检查更新；导入压缩包 → 检查路径存在
const doCheck = async () => {
  if (mode.value === "import" && !shared.packagePath.trim()) {
    return message.error("请先填写压缩包路径");
  }
  checking.value = true;
  checkText.value = "";
  checkOk.value = null;
  try {
    const { execute, state } = checkRunnerPackage();
    await execute({
      params: { daemonId: daemonId.value },
      data: {
        mode: mode.value,
        packagePath: shared.packagePath.trim(),
        proxy: shared.proxy.trim()
      }
    });
    const r: any = state.value || {};
    if (mode.value === "import") {
      checkOk.value = !!r.exists && !!r.isTarGz;
      if (!r.exists) checkText.value = "✗ 路径不存在";
      else
        checkText.value =
          `✓ 存在（${r.sizeMB} MB${r.version ? "，版本 " + r.version : ""}）` +
          (r.isTarGz ? "" : "，但不是 tar.gz 文件");
    } else {
      checkOk.value = !!r.exists && (!r.latestVersion || !r.updateAvailable);
      let s = r.exists ? `内置包版本 ${r.localVersion || "未知"}` : "✗ 内置包不存在";
      if (r.latestVersion)
        s += `；GitHub 最新 ${r.latestVersion}` + (r.updateAvailable ? '（有更新，可点"拉取最新版"下载）' : "（已是最新）");
      else if (r.checkError) s += `；未能查询最新版本（${r.checkError}）`;
      checkText.value = s;
    }
  } catch (err: any) {
    checkOk.value = false;
    checkText.value = "检查失败：" + (err?.message || err);
  } finally {
    checking.value = false;
  }
};

// 拉取最新版：从 GitHub 下载，轮询进度 + 速度
// force=false（默认）：本地已有同版本包时后端直接跳过；force=true 强制覆盖重下
const pullLatest = async (force = false) => {
  downloading.value = true;
  dlPercent.value = 0;
  dlSpeed.value = 0;
  downloadedPath.value = "";
  stopPolling();
  try {
    const { execute, state } = startRunnerDownload();
    await execute({
      params: { daemonId: daemonId.value },
      data: { proxy: shared.proxy.trim(), force } // 不传 version → 拉最新
    });
    const started: any = state.value || {};
    const downloadId = started.downloadId;
    const skipped = !!started.skipped;
    dlVersion.value = started.version || "";
    if (!downloadId) throw new Error("启动下载失败");

    const poll = async () => {
      try {
        const { execute: exeP, state: stP } = runnerDownloadProgress();
        await exeP({ params: { daemonId: daemonId.value }, data: { downloadId } });
        const p: any = stP.value || {};
        dlPercent.value = p.percent || 0;
        dlSpeed.value = p.speed || 0;
        if (p.done) {
          downloading.value = false;
          if (p.error) {
            const hint = !shared.proxy.trim()
              ? "（直连 GitHub CDN 常被重置，请在代理字段填写可用代理，如 http://127.0.0.1:7892）"
              : "（若走代理仍失败，确认代理可访问 GitHub CDN）";
            message.error("下载失败：" + p.error + " " + hint);
          } else {
            downloadedPath.value = p.path || "";
            dlPercent.value = 100;
            if (skipped)
              message.info(
                `本地已有 runner ${p.version}，已跳过下载，创建时将使用现有包（如需覆盖请点"强制重新下载"）`
              );
            else message.success(`已下载 runner ${p.version}，创建时将使用此新包`);
          }
          return;
        }
        dlTimer = setTimeout(poll, 500);
      } catch (err: any) {
        downloading.value = false;
        message.error("进度查询失败：" + (err?.message || err));
      }
    };
    poll();
  } catch (err: any) {
    downloading.value = false;
    message.error("启动下载失败：" + (err?.message || err));
  }
};

const submit = async () => {
  if (!shared.repoUrl || !shared.token || !shared.baseDir) {
    return message.error("请填写：仓库地址 / 注册 token / 基目录");
  }
  if (mode.value === "import" && !shared.packagePath.trim()) {
    return message.error("导入模式需填写压缩包路径（服务器上的 tar.gz）");
  }
  if (!allNames.value.length) {
    return message.error("请至少配置一组有效的 runner（基础名 + 数量）");
  }
  if (allNames.value.length > 99) {
    return message.error(`单批最多 99 个 runner，当前 ${allNames.value.length} 个，请减少数量`);
  }
  submitting.value = true;
  resetBatch();
  try {
    // 1) 启动后台批量任务，立刻拿到 batchId + 初始清单
    const { execute, state } = startRunnerBatch();
    await execute({
      params: { daemonId: daemonId.value },
      data: {
        repoUrl: shared.repoUrl.trim(),
        token: shared.token.trim(),
        proxy: shared.proxy.trim(),
        baseDir: shared.baseDir.trim(),
        packagePath: mode.value === "import" ? shared.packagePath.trim() : downloadedPath.value,
        // 命中既有组时用其前缀作基础名，既通过后端非空校验，也让命名对齐既有组
        groups: groups.value.map((g) => ({
          baseName: (matchOf(g)?.prefix || g.baseName).trim(),
          labels: g.labels.trim(),
          count: Number(g.count) || 0
        })),
        concurrency: Number(shared.concurrency) || 3
      }
    });
    const started: any = state.value || {};
    const batchId = started.batchId;
    if (!batchId) throw new Error("启动批量任务失败");
    currentBatchId.value = batchId;

    // 有组因标签命中既有组被对齐到既有前缀：告知用户实际命名，不静默改名
    const aligned: { baseName: string; labels: string; prefix: string }[] = started.aligned || [];
    if (aligned.length) {
      const desc = aligned.map((a) => `${a.labels} → 并入 ${a.prefix}`).join("；");
      message.info(`部分组标签已存在，命名已对齐既有组：${desc}`);
    }

    // 初始清单：全部 pending
    batchItems.value = (started.items || []).map((i: { name: string }) => ({
      name: i.name,
      status: "pending",
      step: ""
    }));
    batchStat.total = batchItems.value.length;
    batchRunning.value = true;
    batchDone.value = false;
    pollBatch(batchId);
  } catch (err: any) {
    batchRunning.value = false;
    message.error("批量添加失败：" + (err?.message || err));
  } finally {
    submitting.value = false;
  }
};

// 失败项：完整日志文本
const fullLogOf = (it: RunnerBatchProgressItem) =>
  `# runner: ${it.name}\n# 错误: ${it.error || ""}\n\n${it.log || it.error || "（无日志）"}\n`;

const copyText = async (text: string) => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    message.success("已复制到剪贴板");
  } catch {
    message.error("复制失败，请手动选择文本");
  }
};

const downloadText = (filename: string, text: string) => {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

const copyLog = (it: RunnerBatchProgressItem) => copyText(fullLogOf(it));
const downloadLog = (it: RunnerBatchProgressItem) =>
  downloadText(`runner-${it.name}-error.log`, fullLogOf(it));

// 汇总所有失败项日志（复制/下载全部）
const failedItems = computed(() => batchItems.value.filter((i) => i.status === "failed"));
const allFailedLog = () =>
  failedItems.value
    .map((it) => `==================== ${it.name} ====================\n${fullLogOf(it)}`)
    .join("\n");
const copyAllFailed = () => copyText(allFailedLog());
const downloadAllFailed = () => downloadText(`runner-batch-errors.log`, allFailedLog());

// 单个 runner 状态 → 图标/颜色
const statusIcon = (s: string) =>
  s === "done" ? "✓" : s === "failed" ? "✗" : s === "running" ? "…" : "○";
const statusColor = (s: string) =>
  s === "done"
    ? "#17b890"
    : s === "failed"
      ? "#ef5350"
      : s === "running"
        ? "#1890ff"
        : "var(--color-gray-7)";
</script>

<template>
  <a-modal
    v-model:open="open"
    :title="mode === 'import' ? '批量添加 Runner（导入压缩包）' : '批量添加 Runner（直接创建）'"
    :width="720"
    :confirm-loading="submitting"
    :mask-closable="!downloading && !submitting && !batchRunning"
    :closable="!downloading && !submitting && !batchRunning"
    :keyboard="!downloading && !submitting && !batchRunning"
  >
    <!-- 底部按钮：编辑态 → 提交/取消；跑批或已完成 → 只留关闭 -->
    <template #footer>
      <template v-if="!batchItems.length">
        <a-button :disabled="submitting || downloading" @click="open = false">取消</a-button>
        <a-button type="primary" :loading="submitting" @click="submit">
          批量注册并创建实例
        </a-button>
      </template>
      <template v-else>
        <a-button v-if="batchDone" @click="resetBatch">再建一批</a-button>
        <a-button type="primary" :disabled="batchRunning" @click="open = false">
          {{ batchRunning ? "创建中…" : "关闭" }}
        </a-button>
      </template>
    </template>

    <!-- 批量创建进度：勾选清单 -->
    <div v-if="batchItems.length" class="batch-progress">
      <div class="batch-summary">
        <span>共 {{ batchStat.total }} 个</span>
        <span class="ok">✓ 成功 {{ batchStat.doneCount }}</span>
        <span v-if="batchStat.failCount" class="fail">✗ 失败 {{ batchStat.failCount }}</span>
        <template v-if="failedItems.length">
          <a-button type="link" size="small" style="padding: 0" @click="copyAllFailed">
            复制全部失败日志
          </a-button>
          <a-button type="link" size="small" style="padding: 0" @click="downloadAllFailed">
            下载
          </a-button>
        </template>
        <a-spin v-if="batchRunning" size="small" style="margin-left: auto" />
        <span v-else class="ok" style="margin-left: auto">全部结束</span>
      </div>
      <div class="batch-list">
        <div v-for="it in batchItems" :key="it.name" class="batch-row">
          <span class="icon" :style="{ color: statusColor(it.status) }">
            <a-spin v-if="it.status === 'running'" size="small" />
            <template v-else>{{ statusIcon(it.status) }}</template>
          </span>
          <span class="name">{{ it.name }}</span>
          <span
            class="step"
            :style="{ color: it.status === 'failed' ? '#ef5350' : 'var(--cip-text-sub, #8a91a3)' }"
          >
            {{
              it.status === "failed"
                ? it.error || "失败"
                : it.status === "done"
                  ? it.step || "完成"
                  : it.status === "running"
                    ? it.step || "进行中…"
                    : "等待中"
            }}
          </span>
          <span v-if="it.status === 'failed'" class="row-actions">
            <a-button type="link" size="small" @click="copyLog(it)">复制日志</a-button>
            <a-button type="link" size="small" @click="downloadLog(it)">下载</a-button>
          </span>
        </div>
      </div>

      <!-- 失败项重试：注册 token 一次性且约 1h 过期，重试需重新填 -->
      <div v-if="batchDone && batchStat.failCount > 0" class="batch-retry">
        <a-input-password
          v-model:value="retryToken"
          placeholder="重新填注册 token 后重试失败项"
          style="flex: 1"
          @press-enter="retryFailed"
        />
        <a-button type="primary" :loading="retrying" @click="retryFailed">
          重试失败项（{{ batchStat.failCount }}）
        </a-button>
        <a-button :loading="collecting" @click="collect">扫描并收集</a-button>
      </div>
    </div>

    <a-form v-else layout="vertical" style="margin-top: 8px">
      <a-row :gutter="16">
        <a-col :span="24">
          <a-form-item label="从 config.sh 命令解析（可选，粘贴即自动填仓库和 token）">
            <a-input
              v-model:value="cmdPaste"
              placeholder="./config.sh --url https://github.com/owner/repo --token AXXXX..."
              allow-clear
              @input="parseCmd"
              @change="parseCmd"
            />
          </a-form-item>
        </a-col>
        <a-col :span="24">
          <a-form-item label="仓库地址" required>
            <a-input
              v-model:value="shared.repoUrl"
              placeholder="https://github.com/owner/repo"
              @blur="fetchRepoGroups"
            />
          </a-form-item>
        </a-col>
        <a-col :span="24">
          <a-form-item label="注册 token（registration token）" required>
            <a-input
              v-model:value="shared.token"
              placeholder="仓库 Settings → Actions → Runners → New self-hosted runner 里获取"
            />
          </a-form-item>
        </a-col>
        <a-col :span="24">
          <a-form-item label="基目录（每个 runner = 基目录/<name>）" required>
            <a-input-group compact>
              <a-input
                v-model:value="shared.baseDir"
                style="width: calc(100% - 80px)"
                placeholder="/data/ci-runner/ci-runners"
                @blur="onBaseDirChange"
              />
              <a-button style="width: 80px" @click="openDirPicker">
                <FolderOpenOutlined /> 浏览
              </a-button>
            </a-input-group>
            <div
              v-if="baseDirExists === false && shared.baseDir.trim()"
              style="font-size: 12px; color: #d48806; margin-top: 4px"
            >
              该目录不存在，创建时会自动新建。
            </div>
          </a-form-item>
        </a-col>
        <a-col :span="18">
          <a-form-item label="代理（可选，连 GitHub 用）">
            <a-input v-model:value="shared.proxy" placeholder="http://127.0.0.1:7890" />
          </a-form-item>
        </a-col>
        <a-col :span="6">
          <a-form-item label="并发数（同时创建几个）">
            <a-input
              v-model:value="shared.concurrency"
              type="number"
              min="1"
              max="10"
              @blur="shared.concurrency = clampStr(shared.concurrency, 1, 10)"
            />
          </a-form-item>
        </a-col>
        <a-col v-if="mode === 'import'" :span="24">
          <a-form-item label="压缩包路径（服务器上的 tar.gz 绝对路径）" required>
            <a-input
              v-model:value="shared.packagePath"
              placeholder="/data/ci-runner/actions-runner-linux-arm64-2.331.0.tar.gz"
            />
          </a-form-item>
        </a-col>
      </a-row>

      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 4px">
        <a-button :loading="checking" @click="doCheck">
          {{ mode === "import" ? "检查路径" : "检查更新" }}
        </a-button>
        <a-button v-if="mode === 'direct'" :loading="downloading" @click="pullLatest(false)">
          拉取最新版
        </a-button>
        <a-button
          v-if="mode === 'direct'"
          type="link"
          size="small"
          :disabled="downloading"
          @click="pullLatest(true)"
        >
          强制重新下载
        </a-button>
        <span
          v-if="checkText"
          :style="{ fontSize: '13px', color: checkOk ? '#17b890' : '#ef5350' }"
        >
          {{ checkText }}
        </span>
        <a-tooltip
          title="扫描基目录，把已注册(有 .runner)但面板还没建实例的 runner 纳入看护"
          style="margin-left: auto"
        >
          <a-button size="small" :loading="collecting" @click="collect">扫描并收集</a-button>
        </a-tooltip>
      </div>

      <!-- 下载进度 + 速度 -->
      <div v-if="mode === 'direct' && (downloading || downloadedPath)" style="margin-bottom: 6px">
        <a-progress
          :percent="dlPercent"
          :status="downloading ? 'active' : 'success'"
          :stroke-color="'#17b890'"
        />
        <div style="font-size: 12px; color: var(--cip-text-sub, #8a91a3)">
          <template v-if="downloading">
            正在下载 runner {{ dlVersion }} … {{ fmtSpeed(dlSpeed) }}
          </template>
          <template v-else> ✓ 已下载 runner {{ dlVersion }}，创建时将使用此新包 </template>
        </div>
      </div>

      <a-divider style="margin: 10px 0 14px">标签组（可多组，每组按数量生成 名-1 名-2 …）</a-divider>

      <!-- 该仓库已有的 label 组：点击即复用标签、并入既有命名 -->
      <div v-if="repoGroups.length" style="margin-bottom: 12px">
        <div style="font-size: 12px; color: var(--cip-text-sub, #8a91a3); margin-bottom: 6px">
          该仓库已有标签组（点击复用，命名将并入既有前缀）：
        </div>
        <a-space wrap>
          <a-tag
            v-for="rg in repoGroups"
            :key="rg.key"
            color="blue"
            style="cursor: pointer"
            @click="reuseGroup(rg)"
          >
            {{ rg.labels }}（{{ rg.prefix }}，已有 {{ rg.count }}）
          </a-tag>
        </a-space>
      </div>

      <div v-for="(g, i) in groups" :key="i" style="margin-bottom: 10px">
        <div style="display: flex; gap: 10px; align-items: flex-end">
          <a-form-item label="基础名" style="flex: 1; margin: 0">
            <a-input
              v-model:value="g.baseName"
              :disabled="!!matchOf(g)"
              :placeholder="matchOf(g) ? '按既有组自动命名' : '如 cpu / npu'"
            />
          </a-form-item>
          <a-form-item label="标签（逗号分隔）" style="flex: 2; margin: 0">
            <a-input v-model:value="g.labels" placeholder="linux,arm64,npu" />
          </a-form-item>
          <a-form-item label="数量" style="width: 90px; margin: 0">
            <a-input
              v-model:value="g.count"
              type="number"
              min="1"
              max="99"
              @blur="g.count = clampStr(g.count, 1, 99)"
            />
          </a-form-item>
          <a-button
            danger
            type="text"
            :disabled="groups.length <= 1"
            style="margin-bottom: 2px"
            @click="removeGroup(i)"
          >
            <template #icon><DeleteOutlined /></template>
          </a-button>
        </div>
        <div
          v-if="matchOf(g)"
          style="font-size: 12px; color: #17b890; margin-top: 4px"
        >
          该标签组已存在，将并入
          <b>{{ matchOf(g)!.prefix }}</b>
          组，命名从 <b>{{ matchOf(g)!.prefix }}-{{ matchOf(g)!.maxIndex + 1 }}</b> 起
        </div>
      </div>

      <a-button type="dashed" block style="margin-bottom: 12px" @click="addGroup">
        <template #icon><PlusOutlined /></template>
        添加一组标签
      </a-button>

      <a-alert :type="allNames.length > 99 ? 'error' : 'info'" show-icon>
        <template #message>
          将创建 <b>{{ allNames.length }}</b> 个 runner（单批上限 99）：{{ previewText }}
        </template>
      </a-alert>
    </a-form>
    <a-alert
      v-if="!batchItems.length"
      type="warning"
      show-icon
      style="margin-top: 12px"
      message="注册 token 一次性有效（约 1 小时），整批共用一个。数量多时耗时较长，请耐心等待；创建后会装成 systemd 服务并自动启动。"
    />

    <!-- 基目录选择器 -->
    <SelectDirDialog
      ref="dirDialog"
      @select="(p: string) => { shared.baseDir = p; onBaseDirChange(); }"
    />
  </a-modal>
</template>

<style lang="scss" scoped>
// 隐藏原生 number 输入的上下箭头：它不跟随暗色主题（暗色下是白的、也丑）。
// 去掉后就是个干净的数字文本框，和旁边 a-input 同高，直接敲数字即可。
:deep(input[type="number"]) {
  -moz-appearance: textfield;
  appearance: textfield;
}
:deep(input[type="number"]::-webkit-outer-spin-button),
:deep(input[type="number"]::-webkit-inner-spin-button) {
  -webkit-appearance: none;
  margin: 0;
}

.batch-progress {
  margin-top: 8px;

  .batch-summary {
    display: flex;
    align-items: center;
    gap: 14px;
    padding-bottom: 10px;
    margin-bottom: 8px;
    font-size: 13px;
    border-bottom: 1px solid var(--color-gray-4);

    .ok {
      color: #17b890;
    }
    .fail {
      color: #ef5350;
    }
  }

  .batch-list {
    max-height: 340px;
    overflow-y: auto;
  }

  .batch-retry {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--color-gray-4);
  }

  .batch-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 4px;
    border-bottom: 1px solid var(--color-gray-3);

    &:last-child {
      border-bottom: none;
    }

    .icon {
      flex: 0 0 20px;
      text-align: center;
      font-weight: 700;
    }
    .name {
      flex: 0 0 auto;
      min-width: 140px;
      font-family: var(--font-code, monospace);
      font-size: 13px;
    }
    .step {
      flex: 1;
      min-width: 0;
      font-size: 12px;
      text-align: right;
      word-break: break-all;
    }
    .row-actions {
      flex: 0 0 auto;
      white-space: nowrap;

      :deep(.ant-btn) {
        padding: 0 4px;
      }
    }
  }
}
</style>
