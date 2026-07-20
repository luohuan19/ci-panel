<script setup lang="ts">
// Runner 实例（自研补充）：节点 → 仓库 → runner 三级下钻，作为 /instances 页面的卡片。
//
// 数据全部来自 /api/repo/list，它会去每个节点扫磁盘：runner 目录下的 .runner 决定它属于哪个仓库，
// .service 决定由哪个 systemd 单元托管，systemctl 给出真实状态。所以这里看到的是机器上的
// 既成事实，而不是面板自己的记账——面板托管的实例只是其中一种托管方式，systemd 才是生产常态。
//
// 层级用 query 参数（?node=&repo=）而不是 path 参数：这个组件是卡片，寄居在 /instances 页面下，
// 没有自己的路由段。用 query 仍然保住了刷新、后退和分享链接的能力。
import { computed, h, onMounted, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { message, Modal } from "ant-design-vue";
import {
  CloudServerOutlined,
  DatabaseOutlined,
  ExclamationCircleOutlined,
  ReloadOutlined,
  RightOutlined,
  WarningOutlined
} from "@ant-design/icons-vue";
import BetweenMenus from "@/components/BetweenMenus.vue";
import NodeSimpleChart from "@/components/NodeSimpleChart.vue";
import CreateInstanceOptions from "./CreateInstanceOptions.vue";
import ImportRunnerDialog from "./ImportRunnerDialog.vue";
import { useOverviewInfo } from "@/hooks/useOverviewInfo";
import type { LayoutCard } from "@/types/index";
import { repoList, type RepoRunner, type RepoSummary } from "@/services/apis/repo";
import { controlRunnerService, npuStatusAll } from "@/services/apis/runner";
import { remoteNodeList } from "@/services/apis";

defineProps<{
  card: LayoutCard;
}>();

const route = useRoute();
const router = useRouter();

const { execute: fetchRepos, state: repoData, isLoading } = repoList();
const { execute: fetchNodes, state: nodes } = remoteNodeList();
const { execute: control } = controlRunnerService();

// 节点系统信息（CPU/内存用量 + 走势图）：复用概览接口，它自带 3 秒轮询与卸载清理。
// remoteNodeList 只给 available/ip/port/remarks/uuid，没有系统指标，所以两边按 uuid 合并。
const { state: AllDaemonData } = useOverviewInfo();

// 各节点 NPU 占用率（npu-smi）。daemon 侧后台采样 + 缓存，这里只是读快照
const { execute: fetchNpu, state: npuData } = npuStatusAll();

const daemonId = computed(() => (route.query.node as string) || "");
const repoSlug = computed(() => (route.query.repo as string) || "");
const level = computed<"node" | "repo" | "runner">(() => {
  if (daemonId.value && repoSlug.value) return "runner";
  if (daemonId.value) return "repo";
  return "node";
});

// 已纳管 + 未纳管一起展示，未纳管的打个标记（磁盘上有 runner，注册表里还没有）
const allRepos = computed<Array<RepoSummary & { registered: boolean }>>(() => {
  const d = repoData.value;
  if (!d) return [];
  return [
    ...d.repos.map((r) => ({ ...r, registered: true })),
    ...d.unregistered.map((r) => ({ ...r, registered: false }))
  ];
});

// 每个节点上有哪些仓库、多少 runner。runner 自带 daemonId，按它归堆
const nodeCards = computed(() =>
  (nodes.value || []).map((node) => {
    const runners: RepoRunner[] = [];
    const repos = new Set<string>();
    for (const repo of allRepos.value) {
      const mine = repo.runners.filter((r) => r.daemonId === node.uuid);
      if (mine.length) {
        repos.add(repo.slug);
        runners.push(...mine);
      }
    }
    // 该节点的系统指标（概览接口按 uuid 对上）
    const sys = AllDaemonData.value?.remote?.find((r) => r.uuid === node.uuid);
    const running = runners.filter((r) => r.running).length;
    const busy = runners.filter((r) => r.busy).length;
    return {
      node,
      sys,
      // 该节点的 NPU 快照；没有 npu-smi 的节点为 undefined / available=false
      npu: npuData.value?.[node.uuid],
      repoCount: repos.size,
      total: runners.length,
      running,
      busy,
      // 空闲 = 在跑但没接 job：CI 场景第一位的问题「现在还能接多少活」
      idle: Math.max(0, running - busy),
      orphaned: runners.filter((r) => r.managedBy === "none").length,
      conflicted: runners.filter((r) => r.managedBy === "both").length
    };
  })
);

// NPU 显存 MB → GB 文本
function fmtGB(mb?: number) {
  if (!mb || mb <= 0) return "0G";
  return `${(mb / 1024).toFixed(mb < 10240 ? 1 : 0)}G`;
}

// 节点已运行时长（秒 → 天/小时/分钟）
function fmtUptime(sec?: number) {
  if (!sec || sec <= 0) return "--";
  const d = Math.floor(sec / 86400);
  if (d >= 1) return `${d} 天`;
  const h = Math.floor(sec / 3600);
  if (h >= 1) return `${h} 小时`;
  return `${Math.floor(sec / 60)} 分钟`;
}

// 1 分钟负载。CI 任务突发，瞬时 CPU% 会骗人（可能采样在空隙），负载更能反映排队/饱和。
// Windows 没有 loadavg（恒为 0），显示 -- 免得误导。
function fmtLoad(sys?: { loadavg?: number[]; platform?: string }) {
  if (!sys || sys.platform === "win32") return "--";
  const v = sys.loadavg?.[0];
  return v == null || Number.isNaN(v) ? "--" : v.toFixed(2);
}

const reposOfNode = computed(() =>
  allRepos.value
    .map((repo) => {
      const runners = repo.runners.filter((r) => r.daemonId === daemonId.value);
      return { ...repo, runners, total: runners.length };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
);

const runnersOfRepo = computed<RepoRunner[]>(() => {
  const repo = allRepos.value.find((r) => r.slug === repoSlug.value);
  if (!repo) return [];
  return repo.runners
    .filter((r) => r.daemonId === daemonId.value)
    .sort((a, b) => a.agentName.localeCompare(b.agentName, undefined, { numeric: true }));
});

const currentNodeName = computed(
  () => nodes.value?.find((n) => n.uuid === daemonId.value)?.remarks || daemonId.value
);

async function load(silent = false) {
  try {
    // NPU 单独 catch：没有 npu-smi 的节点属正常情况，不该让整个列表报错
    await Promise.all([fetchNodes(), fetchRepos(), fetchNpu().catch(() => undefined)]);
  } catch (err: any) {
    if (!silent) message.error("加载失败：" + (err?.message || err));
  }
}

// job 会来会走，10 秒自动刷一次
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  load();
  timer = setInterval(() => load(true), 10000);
});
onUnmounted(() => clearInterval(timer));

function statusColor(r: RepoRunner) {
  if (r.busy) return "processing";
  if (r.managedBy === "both") return "error";
  if (r.managedBy === "none") return "warning";
  return r.running ? "success" : "default";
}

function statusLabel(r: RepoRunner) {
  if (r.managedBy === "none") return "无人托管";
  if (r.busy) return "正在跑 job";
  return r.running ? "空闲待命" : "已停止";
}

// systemd 的时间戳形如 "Fri 2026-07-03 11:52:54 CST"，只留日期和时分
function shortTime(s: string) {
  if (!s) return "—";
  const m = s.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
  return m ? m[1] : s;
}

const acting = ref<Record<string, boolean>>({});

async function doControl(r: RepoRunner, action: "start" | "stop" | "restart") {
  if (!r.service) return message.error("这个 runner 没有 systemd 服务，面板管不了它的启停");
  acting.value[r.dir] = true;
  try {
    await control({ params: { daemonId: r.daemonId }, data: { service: r.service, action } });
    message.success(`${r.agentName} ${action} 成功`);
    await load(true);
  } catch (err: any) {
    message.error(`${action} 失败：` + (err?.message || err));
  } finally {
    acting.value[r.dir] = false;
  }
}

// 停/重启一个正在跑 job 的 runner 会当场中断 CI 任务，必须让人明确知道自己在干什么
function confirmControl(r: RepoRunner, action: "start" | "stop" | "restart") {
  if (action === "start" || !r.busy) return doControl(r, action);
  Modal.confirm({
    title: `${r.agentName} 正在跑 CI 任务`,
    icon: () => h(ExclamationCircleOutlined),
    content: `${action === "stop" ? "停止" : "重启"}它会当场中断正在执行的 job，该 job 会失败。确定继续吗？`,
    okText: "我确定，仍然继续",
    okType: "danger",
    cancelText: "取消",
    onOk: () => doControl(r, action)
  });
}

// 导入弹窗：在节点视图里点开时带上当前节点，省一次选择
const importDialog = ref<InstanceType<typeof ImportRunnerDialog>>();
function openImport() {
  const preset = daemonId.value
    ? { daemonId: daemonId.value, nodeName: currentNodeName.value }
    : undefined;
  importDialog.value?.openDialog(preset);
}

// 进 runner 详情页（实时日志 + 基本信息 + 文件管理/配置）
function goDetail(r: RepoRunner) {
  router.push({ path: "/instances/runner", query: { daemonId: r.daemonId, dir: r.dir } });
}

const goRoot = () => router.push({ path: route.path });
const goNode = (uuid: string) => router.push({ path: route.path, query: { node: uuid } });
const goRepo = (slug: string) =>
  router.push({ path: route.path, query: { node: daemonId.value, repo: slug } });
</script>

<template>
  <div style="min-height: 100%" class="container">
    <a-row :gutter="[24, 24]" style="min-height: 100%">
      <!-- 创建入口（内含「添加 Runner」对话框）。新注册的 runner 立刻会出现在下面的列表里 -->
      <a-col :span="24">
        <CreateInstanceOptions :card="card" @created="load()" />
      </a-col>

      <a-col :span="24">
        <BetweenMenus>
          <template #left>
            <a-typography-title class="mb-0" :level="4">
              <CloudServerOutlined />
              {{ card.title }}
            </a-typography-title>
          </template>
          <template #right>
            <a-space>
              <a-button @click="openImport()"><DatabaseOutlined /> 导入 runner</a-button>
              <a-button :loading="isLoading" @click="load()">
                <ReloadOutlined /> 刷新
              </a-button>
            </a-space>
          </template>
        </BetweenMenus>
      </a-col>

      <!-- 面包屑：三级下钻的返回路径 -->
      <a-col :span="24">
        <a-breadcrumb>
          <a-breadcrumb-item>
            <a @click="goRoot()">全部节点</a>
          </a-breadcrumb-item>
          <a-breadcrumb-item v-if="level !== 'node'">
            <a @click="goNode(daemonId)">{{ currentNodeName }}</a>
          </a-breadcrumb-item>
          <a-breadcrumb-item v-if="level === 'runner'">{{ repoSlug }}</a-breadcrumb-item>
        </a-breadcrumb>
      </a-col>

      <a-col v-if="repoData?.failedNodes?.length" :span="24">
        <a-alert
          type="warning"
          show-icon
          :message="`有 ${repoData.failedNodes.length} 个节点扫描失败，下面的数据不完整`"
          :description="repoData.failedNodes.map((n) => `${n.nodeName}: ${n.error}`).join('；')"
        />
      </a-col>

      <!-- L1：节点 -->
      <template v-if="level === 'node'">
        <!-- 每行 2 个：和「节点」页 NodeList 一致。CPU/内存是左右并排两张图，
             挤在 1/3 宽的卡片里会糊成一团，给到一半宽才够看 -->
        <a-col v-for="c in nodeCards" :key="c.node.uuid" :span="24" :lg="12">
          <a-card hoverable @click="goNode(c.node.uuid)">
            <template #title>
              <a-badge :status="c.node.available ? 'success' : 'error'" />
              {{ c.node.remarks || `${c.node.ip}:${c.node.port}` }}
            </template>
            <template #extra><RightOutlined /></template>
            <a-row>
              <a-col :span="6"><a-statistic title="仓库" :value="c.repoCount" /></a-col>
              <a-col :span="6">
                <a-statistic
                  title="运行中"
                  :value="c.running"
                  :suffix="`/ ${c.total}`"
                  :value-style="{ color: c.running === c.total ? '#52c41a' : '#faad14' }"
                />
              </a-col>
              <a-col :span="6">
                <a-statistic
                  title="空闲"
                  :value="c.idle"
                  :value-style="{ color: c.idle ? '#52c41a' : '#faad14' }"
                />
              </a-col>
              <a-col :span="6">
                <a-statistic
                  title="跑 job"
                  :value="c.busy"
                  :value-style="{ color: c.busy ? '#1677ff' : undefined }"
                />
              </a-col>
            </a-row>
            <div v-if="c.orphaned || c.conflicted" style="margin-top: 12px">
              <a-tag v-if="c.orphaned" color="warning">
                <WarningOutlined /> {{ c.orphaned }} 个无人托管
              </a-tag>
              <a-tag v-if="c.conflicted" color="error">
                <WarningOutlined /> {{ c.conflicted }} 个托管冲突
              </a-tag>
            </div>

            <!-- 节点系统指标：和「节点」页同款的 CPU/内存走势图 -->
            <template v-if="c.sys">
              <a-divider style="margin: 16px 0 12px" />
              <!-- 刻意不显示 MCSManager 的「实例数」：在句柄实例模型下那些实例只是文件管理的抓手、
                   并不代表在跑，数值≈runner 数，和上面的统计重复且语义误导 -->
              <div
                style="
                  display: flex;
                  justify-content: space-between;
                  gap: 8px;
                  flex-wrap: wrap;
                  font-size: 12px;
                  opacity: 0.65;
                  margin-bottom: 8px;
                "
              >
                <span>{{ c.sys.platformText || "--" }}</span>
                <span>负载 {{ fmtLoad(c.sys.system) }}</span>
                <span>运行 {{ fmtUptime(c.sys.system?.uptime) }}</span>
                <span>v{{ c.sys.version || "--" }}</span>
              </div>
              <NodeSimpleChart
                class="mt-8"
                :cpu-usage="c.sys.cpuInfo ?? ''"
                :mem-usage="c.sys.memText ?? ''"
                :cpu-data="c.sys.cpuChartData ?? []"
                :mem-data="c.sys.memChartData ?? []"
              />
            </template>

            <!-- NPU(昇腾)占用率：数据来自 npu-smi，没这命令的节点不显示本区 -->
            <template v-if="c.npu?.available && c.npu.chips.length">
              <a-divider style="margin: 12px 0" />
              <div
                style="
                  display: flex;
                  justify-content: space-between;
                  font-size: 12px;
                  margin-bottom: 6px;
                "
              >
                <span style="opacity: 0.65">
                  NPU {{ c.npu.chips.length }} 颗 · 满载 {{ c.npu.busyChips }}
                </span>
                <span style="opacity: 0.65">
                  HBM {{ fmtGB(c.npu.hbmUsed) }} / {{ fmtGB(c.npu.hbmTotal) }}
                </span>
              </div>
              <div style="display: flex; align-items: center; gap: 8px">
                <a-progress
                  :percent="c.npu.avgUtil"
                  :stroke-color="c.npu.avgUtil >= 80 ? '#ff4d4f' : '#1677ff'"
                  size="small"
                  style="flex: 1; margin: 0"
                />
              </div>
              <!-- 每颗芯片一根小条：一眼看出哪几颗在闲着 -->
              <div style="display: flex; gap: 2px; margin-top: 6px">
                <a-tooltip
                  v-for="chip in c.npu.chips"
                  :key="chip.phyId"
                  :title="`NPU${chip.npuId}-芯片${chip.chipId} (phy ${chip.phyId})：占用 ${chip.util}% · ${chip.temp}℃ · HBM ${fmtGB(chip.hbmUsed)}/${fmtGB(chip.hbmTotal)}`"
                >
                  <div
                    style="flex: 1; height: 14px; border-radius: 2px; background: #f0f0f0"
                    :style="{
                      background: `linear-gradient(to top, ${
                        chip.util >= 80 ? '#ff4d4f' : '#1677ff'
                      } ${chip.util}%, #f0f0f0 ${chip.util}%)`
                    }"
                  />
                </a-tooltip>
              </div>
            </template>
          </a-card>
        </a-col>
        <a-col v-if="!nodeCards.length && !isLoading" :span="24">
          <a-empty description="没有节点" />
        </a-col>
      </template>

      <!-- L2：该节点上的仓库 -->
      <template v-else-if="level === 'repo'">
        <a-col v-for="r in reposOfNode" :key="r.slug" :xs="24" :sm="12" :lg="8">
          <a-card hoverable @click="goRepo(r.slug)">
            <template #title><DatabaseOutlined /> {{ r.slug }}</template>
            <template #extra><RightOutlined /></template>
            <a-row>
              <a-col :span="12">
                <a-statistic
                  title="运行中"
                  :value="r.running"
                  :suffix="`/ ${r.total}`"
                  :value-style="{ color: r.running === r.total ? '#52c41a' : '#faad14' }"
                />
              </a-col>
              <a-col :span="12">
                <a-statistic
                  title="正在跑 job"
                  :value="r.busy"
                  :value-style="{ color: r.busy ? '#1677ff' : undefined }"
                />
              </a-col>
            </a-row>
            <div style="margin-top: 12px">
              <a-tag v-if="!r.registered">未纳管</a-tag>
              <a-tag v-if="r.registered && !r.hasToken">未配 PAT</a-tag>
              <a-tag v-if="r.orphaned" color="warning">
                <WarningOutlined /> {{ r.orphaned }} 个无人托管
              </a-tag>
              <a-tag v-if="r.conflicted" color="error">
                <WarningOutlined /> {{ r.conflicted }} 个托管冲突
              </a-tag>
            </div>
          </a-card>
        </a-col>
        <a-col v-if="!reposOfNode.length && !isLoading" :span="24">
          <a-empty description="这个节点上没有扫描到 runner" />
        </a-col>
      </template>

      <!-- L3：该仓库的 runner -->
      <a-col v-else :span="24">
        <a-table
          :data-source="runnersOfRepo"
          row-key="dir"
          :loading="isLoading"
          :pagination="false"
          size="middle"
          :scroll="{ x: 900 }"
        >
          <a-table-column key="agentName" title="Runner" :width="170">
            <template #default="{ record }">
              <div style="font-weight: 500">{{ record.agentName }}</div>
              <!-- 目录名和 GitHub 上的名字经常对不上，两个都得显示 -->
              <div v-if="record.dirName !== record.agentName" style="font-size: 12px; opacity: 0.6">
                目录: {{ record.dirName }}
              </div>
            </template>
          </a-table-column>

          <a-table-column key="status" title="状态" :width="130">
            <template #default="{ record }">
              <a-badge :status="statusColor(record)" :text="statusLabel(record)" />
            </template>
          </a-table-column>

          <a-table-column key="managedBy" title="托管方式" :width="120">
            <template #default="{ record }">
              <a-tag v-if="record.managedBy === 'systemd'" color="blue">systemd</a-tag>
              <a-tag v-else-if="record.managedBy === 'panel'" color="purple">面板实例</a-tag>
              <a-tooltip
                v-else-if="record.managedBy === 'both'"
                title="systemd 和面板都在托管同一个目录，可能跑起两个 Runner.Listener 抢同一个 GitHub 身份"
              >
                <a-tag color="error"><WarningOutlined /> 冲突</a-tag>
              </a-tooltip>
              <a-tooltip v-else title="既没装 systemd 服务、面板也没托管，没有任何东西会启动它">
                <a-tag color="warning"><WarningOutlined /> 无人托管</a-tag>
              </a-tooltip>
            </template>
          </a-table-column>

          <a-table-column key="since" title="启动于" :width="140">
            <template #default="{ record }">
              <span style="font-size: 13px">{{ shortTime(record.since) }}</span>
            </template>
          </a-table-column>

          <a-table-column key="dir" title="目录">
            <template #default="{ record }">
              <span style="font-size: 12px; opacity: 0.75">{{ record.dir }}</span>
            </template>
          </a-table-column>

          <a-table-column key="action" title="操作" :width="260" fixed="right">
            <template #default="{ record }">
              <a-space>
                <a-button size="small" type="primary" ghost @click="goDetail(record)">详情</a-button>
                <template v-if="record.service">
                  <a-button
                    v-if="!record.running"
                    size="small"
                    type="primary"
                    :loading="acting[record.dir]"
                    @click="confirmControl(record, 'start')"
                  >
                    启动
                  </a-button>
                  <a-button
                    v-else
                    size="small"
                    danger
                    :loading="acting[record.dir]"
                    @click="confirmControl(record, 'stop')"
                  >
                    停止
                  </a-button>
                  <a-button
                    size="small"
                    :loading="acting[record.dir]"
                    :disabled="!record.running"
                    @click="confirmControl(record, 'restart')"
                  >
                    重启
                  </a-button>
                </template>
                <a-tooltip v-else title="没有 systemd 服务，面板无法启停">
                  <span style="opacity: 0.45">不可启停</span>
                </a-tooltip>
              </a-space>
            </template>
          </a-table-column>
        </a-table>
      </a-col>
    </a-row>

    <!-- 导入既有 runner：扫描节点磁盘 → 勾选 → 写 .cipanel 纳管 -->
    <ImportRunnerDialog ref="importDialog" @imported="load()" />
  </div>
</template>
