<script setup lang="ts">
// Runner 详情页（自研补充）：独立页面，不走卡片布局。
// 布局仿实例终端页：主区是实时日志(_diag，tail -f 式跟随)，右侧是基本信息 + 功能组。
// 功能组只留两项：文件管理(复用现成实例文件管理，靠句柄实例的 instanceUuid) + Runner 配置。
// systemd 托管的 runner 靠这页也能看控制台、启停(走 systemctl)、管文件。
import { ref, computed, onMounted, onUnmounted, h } from "vue";
import { useRoute, useRouter } from "vue-router";
import { message, Modal } from "ant-design-vue";
import {
  ArrowLeftOutlined,
  FolderOpenOutlined,
  SettingOutlined,
  ExclamationCircleOutlined,
  WarningOutlined,
  DeleteOutlined,
  PlusOutlined
} from "@ant-design/icons-vue";
import RunnerLogView from "./RunnerLogView.vue";
import FileManager from "./instance/FileManager.vue";
import DeleteResultView from "./DeleteResultView.vue";
import {
  runnerState,
  controlRunnerService,
  registerRunners,
  deleteRunner,
  getRunnerEnv,
  setRunnerEnv,
  type ScannedRunner,
  type DeleteRunnerResult,
  type RunnerEnvVar,
  type EnvTarget
} from "@/services/apis/runner";

const route = useRoute();
const router = useRouter();

const daemonId = computed(() => String(route.query.daemonId || ""));
const dir = computed(() => String(route.query.dir || ""));

const runner = ref<ScannedRunner | null>(null);
const loading = ref(false);
const acting = ref(false);

// 面板实例状态码 3 = 运行中（对齐 daemon Instance.STATUS_RUNNING）
const INSTANCE_RUNNING = 3;

const running = computed(() => {
  const r = runner.value;
  if (!r) return false;
  if (r.systemd?.loaded) return r.systemd.activeState === "active";
  if (r.instanceUuid) return r.instanceStatus === INSTANCE_RUNNING;
  return false;
});

const statusText = computed(() => {
  const r = runner.value;
  if (!r) return "—";
  if (r.managedBy === "none") return "无人托管";
  if (r.busy) return "正在跑 job";
  return running.value ? "空闲待命" : "已停止";
});
const statusBadge = computed(() => {
  const r = runner.value;
  if (!r) return "default";
  if (r.busy) return "processing";
  if (r.managedBy === "both") return "error";
  if (r.managedBy === "none") return "warning";
  return running.value ? "success" : "default";
});

function shortTime(s?: string) {
  if (!s) return "—";
  const m = s.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
  return m ? m[1] : s;
}

async function loadState(silent = false) {
  if (!daemonId.value || !dir.value) return;
  if (!silent) loading.value = true;
  try {
    const { execute, state } = runnerState();
    await execute({ params: { daemonId: daemonId.value }, data: { dir: dir.value } });
    runner.value = state.value?.runner || null;
  } catch (err: any) {
    if (!silent) message.error("加载 runner 状态失败：" + (err?.message || err));
  } finally {
    loading.value = false;
  }
}

// ---- systemd 启停（正在跑 job 的停/重启要二次确认，避免中断 CI）----
async function doControl(action: "start" | "stop" | "restart") {
  const r = runner.value;
  if (!r?.systemd?.service)
    return message.error("这个 runner 没有 systemd 服务，面板管不了它的启停");
  acting.value = true;
  try {
    const { execute } = controlRunnerService();
    await execute({
      params: { daemonId: daemonId.value },
      data: { service: r.systemd.service, action }
    });
    message.success(`${action} 成功`);
    await loadState(true);
  } catch (err: any) {
    message.error(`${action} 失败：` + (err?.message || err));
  } finally {
    acting.value = false;
  }
}
function confirmControl(action: "start" | "stop" | "restart") {
  if (action === "start" || !runner.value?.busy) return doControl(action);
  Modal.confirm({
    title: `${runner.value?.agentName} 正在跑 CI 任务`,
    icon: () => h(ExclamationCircleOutlined),
    content: `${action === "stop" ? "停止" : "重启"}它会当场中断正在执行的 job，该 job 会失败。确定继续吗？`,
    okText: "我确定，仍然继续",
    okType: "danger",
    cancelText: "取消",
    onOk: () => doControl(action)
  });
}

// ---- 功能组 ----
// 文件管理：直接内嵌 MCSManager 的 FileManager 卡片(它只吃 card.meta 里的 instanceId/daemonId，
// 编辑走对话框、不跳路由)。做成抽屉是为了避免复用 /instances/terminal/files 那条路由带出的
// "终端"面包屑层级——文件管理留在 runner 详情页内，层级清爽。
const fileOpen = ref(false);
const fileCard = ref<any>(null);
function openFileManager() {
  const r = runner.value;
  if (!r?.instanceUuid) return message.error("这个 runner 还没有句柄实例，无法打开文件管理");
  fileCard.value = { meta: { instanceId: r.instanceUuid, daemonId: daemonId.value } };
  fileOpen.value = true;
}

// runner 配置抽屉：展示事实 + 可改所属组（写回 marker）+ 环境变量（写 systemd override.conf）
const configOpen = ref(false);
const groupEdit = ref("");
const savingGroup = ref(false);
function openConfig() {
  groupEdit.value = runner.value?.group || "";
  configOpen.value = true;
  void loadEnv();
}

// ---- 环境变量编辑：两个目标 ----
// override —— systemd drop-in override.conf 的 Environment=，进「监听进程」（代理放这里才能连 GitHub）。
// dotenv   —— runner 目录的 .env，runsvc 不 source 它，只被 runner 读取注入到 job/step（设备号、库路径）。
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const overrideVars = ref<RunnerEnvVar[]>([]);
const dotenvVars = ref<RunnerEnvVar[]>([]);
const envHasSystemd = ref(false);
const envLoading = ref(false);
// 加载失败时编辑器是空的，而保存走 replace(整表覆盖)——此时点保存会清空该 runner 全部变量。
// 故加载失败即禁用保存，必须重试成功后才能改。
const envLoadFailed = ref(false);
const savingTarget = ref<EnvTarget | "">(""); // 正在保存哪个区，用于按钮 loading
function rowsRef(target: EnvTarget) {
  return target === "override" ? overrideVars : dotenvVars;
}
async function loadEnv() {
  const r = runner.value;
  if (!daemonId.value || !r?.dir) return;
  envLoading.value = true;
  try {
    const { execute, state } = getRunnerEnv();
    await execute({ params: { daemonId: daemonId.value }, data: { dir: r.dir } });
    envHasSystemd.value = Boolean(state.value?.hasSystemd);
    overrideVars.value = (state.value?.override?.vars || []).map((v) => ({
      key: v.key,
      value: v.value
    }));
    dotenvVars.value = (state.value?.dotenv?.vars || []).map((v) => ({
      key: v.key,
      value: v.value
    }));
    envLoadFailed.value = false;
  } catch (err: any) {
    envLoadFailed.value = true;
    overrideVars.value = [];
    dotenvVars.value = [];
    message.error("加载环境变量失败：" + (err?.message || err));
  } finally {
    envLoading.value = false;
  }
}
function addEnvRow(target: EnvTarget) {
  rowsRef(target).value.push({ key: "", value: "" });
}
function removeEnvRow(target: EnvTarget, i: number) {
  rowsRef(target).value.splice(i, 1);
}
async function saveEnv(target: EnvTarget) {
  const r = runner.value;
  if (!r?.dir) return;
  // 保存是整表覆盖，没读到当前值就保存等于清空——拦住
  if (envLoadFailed.value) return message.error("当前环境变量未加载成功，请先重试加载再保存");
  // 过滤空行，前端先校验变量名（后端/助手也会再校验一次）
  const rows = rowsRef(target)
    .value.map((v) => ({ key: v.key.trim(), value: v.value }))
    .filter((v) => v.key);
  const bad = rows.find((v) => !ENV_KEY_RE.test(v.key));
  if (bad) return message.error(`非法变量名：${bad.key}（只能字母数字下划线，且不以数字开头）`);
  const keys = rows.map((v) => v.key);
  if (new Set(keys).size !== keys.length) return message.error("有重复的变量名");
  savingTarget.value = target;
  try {
    const { execute } = setRunnerEnv();
    // 详情页是单个 runner 的完整编辑，整表覆盖（replace）
    await execute({
      params: { daemonId: daemonId.value },
      data: { dir: r.dir, target, upsert: rows, replace: true }
    });
    message.success(target === "override" ? "已保存 systemd 环境变量" : "已保存 .env");
    await loadEnv();
    promptRestart();
  } catch (err: any) {
    message.error("保存环境变量失败：" + (err?.message || err));
  } finally {
    savingTarget.value = "";
  }
}
// 环境变量改动需重启单元才生效——弹窗提示，正在跑 job 的二次确认（复用启停确认）
function promptRestart() {
  const r = runner.value;
  if (!r?.systemd?.service) return;
  Modal.confirm({
    title: "重启 runner 使环境变量生效？",
    icon: () => h(ExclamationCircleOutlined),
    content: r.busy
      ? "环境变量已写入，需重启单元才生效。该 runner 正在跑 job，重启会当场中断它！"
      : "环境变量已写入，需重启单元才生效。",
    okText: r.busy ? "仍然重启" : "立即重启",
    okType: r.busy ? "danger" : "primary",
    cancelText: "稍后手动重启",
    onOk: () => doControl("restart")
  });
}
async function saveGroup() {
  const r = runner.value;
  if (!r) return;
  savingGroup.value = true;
  try {
    const { execute } = registerRunners();
    await execute({
      params: { daemonId: daemonId.value },
      data: { items: [{ dir: r.dir, repo: r.repo, group: groupEdit.value.trim() }] }
    });
    message.success("已保存");
    configOpen.value = false;
    await loadState(true);
  } catch (err: any) {
    message.error("保存失败：" + (err?.message || err));
  } finally {
    savingGroup.value = false;
  }
}

// ---- 彻底删除 runner（不可逆）----
const deleting = ref(false);
const deleteOpen = ref(false);
const manualToken = ref(""); // 手输的 GitHub 删除 token，留空则用仓库 PAT 自动获取
function confirmDelete() {
  if (!runner.value) return;
  manualToken.value = "";
  deleteOpen.value = true;
}
// 删除结果分步展示
const resultOpen = ref(false);
const deleteResults = ref<DeleteRunnerResult[]>([]);
async function doDelete() {
  const r = runner.value;
  if (!r) return;
  deleting.value = true;
  try {
    const { execute, state } = deleteRunner();
    await execute({
      params: { daemonId: daemonId.value },
      data: {
        dir: r.dir,
        repo: r.repo,
        force: Boolean(r.busy),
        removeToken: manualToken.value.trim()
      }
    });
    const res = state.value;
    if (!res) throw new Error("删除无响应");
    deleteOpen.value = false;
    // 有任何失败/跳过的步骤就展开分步结果，让用户看到卡在哪、如何手动补做；全干净则直接提示
    const hasIssue = !res.ok || (res.steps || []).some((s) => s.status !== "ok");
    if (hasIssue) {
      deleteResults.value = [res];
      resultOpen.value = true;
    } else {
      message.success("已彻底删除");
      goBack();
    }
  } catch (err: any) {
    message.error("删除失败：" + (err?.message || err));
  } finally {
    deleting.value = false;
  }
}
// 关闭结果弹窗后回列表（目录删没删都回，列表会反映真实状态）
function closeResult() {
  resultOpen.value = false;
  goBack();
}

// 5 秒刷新基本信息（日志自己有跟随，不在这里管）
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  loadState();
  timer = setInterval(() => loadState(true), 5000);
});
onUnmounted(() => timer && clearInterval(timer));

// 返回到该 runner 所属的仓库层级（RunnerExplorer 的 L3 视图靠 node+repo 定位）；
// 仓库还没探到时退回到节点层级，再不行才回全部节点。
function goBack() {
  const repo = runner.value?.repo;
  if (daemonId.value && repo) {
    router.push({ path: "/instances", query: { node: daemonId.value, repo } });
  } else if (daemonId.value) {
    router.push({ path: "/instances", query: { node: daemonId.value } });
  } else {
    router.push({ path: "/instances" });
  }
}
</script>

<template>
  <div class="runner-detail">
    <div class="header">
      <a-button type="text" @click="goBack"><ArrowLeftOutlined /> 返回</a-button>
      <a-typography-title :level="4" class="title">
        {{ runner?.agentName || "Runner" }}
        <a-badge
          :status="statusBadge"
          :text="statusText"
          style="margin-left: 12px; font-size: 14px"
        />
      </a-typography-title>
    </div>

    <a-alert
      v-if="runner?.managedBy === 'both'"
      type="error"
      show-icon
      style="margin-bottom: 12px"
      message="托管冲突：systemd 和面板都在托管这个目录，可能跑起两个 Runner.Listener 抢同一个 GitHub 身份"
    />
    <a-alert
      v-if="runner?.broken"
      type="warning"
      show-icon
      style="margin-bottom: 12px"
      :message="runner.broken"
    />

    <a-row :gutter="[16, 16]">
      <!-- 主区：实时日志 -->
      <a-col :xs="24" :lg="16">
        <a-card title="控制台（_diag 日志）" size="small">
          <RunnerLogView v-if="dir && daemonId" :daemon-id="daemonId" :dir="dir" />
        </a-card>
      </a-col>

      <!-- 右侧：基本信息 + 功能组 -->
      <a-col :xs="24" :lg="8">
        <a-card
          title="基本信息"
          size="small"
          :loading="loading && !runner"
          style="margin-bottom: 16px"
        >
          <a-descriptions :column="1" size="small" bordered>
            <a-descriptions-item label="名称">{{ runner?.agentName || "—" }}</a-descriptions-item>
            <a-descriptions-item label="仓库">{{ runner?.repo || "—" }}</a-descriptions-item>
            <a-descriptions-item label="托管方式">
              <a-tag v-if="runner?.managedBy === 'systemd'" color="blue">systemd</a-tag>
              <a-tag v-else-if="runner?.managedBy === 'panel'" color="purple">面板实例</a-tag>
              <a-tag v-else-if="runner?.managedBy === 'both'" color="error">
                <WarningOutlined /> 冲突
              </a-tag>
              <a-tag v-else color="warning"><WarningOutlined /> 无人托管</a-tag>
            </a-descriptions-item>
            <a-descriptions-item label="来源">
              <span v-if="runner?.source === 'provision'">面板创建</span>
              <span v-else-if="runner?.source === 'import'">导入</span>
              <span v-else>—</span>
            </a-descriptions-item>
            <a-descriptions-item label="所属组">{{ runner?.group || "—" }}</a-descriptions-item>
            <a-descriptions-item label="systemd 单元">
              {{
                runner?.systemd?.service || "—"
              }}
            </a-descriptions-item>
            <a-descriptions-item label="启动于">
              {{
                shortTime(runner?.systemd?.since)
              }}
            </a-descriptions-item>
            <a-descriptions-item label="目录">
              <span style="font-size: 12px; word-break: break-all">{{ runner?.dir }}</span>
            </a-descriptions-item>
          </a-descriptions>

          <!-- systemd 启停 -->
          <div v-if="runner?.systemd?.service" style="margin-top: 12px">
            <a-space>
              <a-button
                v-if="!running"
                type="primary"
                size="small"
                :loading="acting"
                @click="confirmControl('start')"
              >
                启动
              </a-button>
              <a-button
                v-else
                danger
                size="small"
                :loading="acting"
                @click="confirmControl('stop')"
              >
                停止
              </a-button>
              <a-button
                size="small"
                :loading="acting"
                :disabled="!running"
                @click="confirmControl('restart')"
              >
                重启
              </a-button>
            </a-space>
          </div>
        </a-card>

        <a-card title="功能" size="small">
          <a-space direction="vertical" style="width: 100%">
            <a-button block @click="openFileManager"><FolderOpenOutlined /> 文件管理</a-button>
            <a-button block @click="openConfig"><SettingOutlined /> Runner 配置</a-button>
            <a-button block danger :loading="deleting" @click="confirmDelete">
              <DeleteOutlined /> 彻底删除
            </a-button>
          </a-space>
        </a-card>
      </a-col>
    </a-row>

    <!-- 文件管理抽屉：内嵌 FileManager 卡片，靠句柄实例的 instanceUuid 驱动 -->
    <a-drawer
      v-model:open="fileOpen"
      :title="`文件管理 · ${runner?.agentName || ''}`"
      placement="right"
      width="92%"
      :body-style="{ padding: '12px' }"
      destroy-on-close
    >
      <FileManager v-if="fileOpen && fileCard" :card="fileCard" />
    </a-drawer>

    <!-- 彻底删除确认弹窗 -->
    <a-modal
      v-model:open="deleteOpen"
      :title="`彻底删除 ${runner?.agentName || ''}？`"
      :width="560"
      ok-text="确认删除"
      :ok-button-props="{ danger: true, loading: deleting }"
      cancel-text="取消"
      @ok="doDelete"
    >
      <a-alert
        v-if="runner?.busy"
        type="error"
        show-icon
        style="margin-bottom: 12px"
        message="该 runner 正在跑 job，删除会当场中断这个 CI 任务！"
      />
      <p style="margin-bottom: 8px">此操作<strong>不可逆</strong>，将会：</p>
      <ul style="padding-left: 18px; margin: 0 0 12px">
        <li>停止并卸载 systemd 服务</li>
        <li>从 GitHub 注销该 runner</li>
        <li>删除面板句柄实例与纳管标记</li>
        <li>
          删除整个目录：<span style="word-break: break-all">{{ runner?.dir }}</span>
        </li>
      </ul>
      <a-form layout="vertical">
        <a-form-item label="GitHub 删除 token（可选）">
          <a-input
            v-model:value="manualToken"
            placeholder="留空则用该仓库已配置的 PAT 自动获取"
            allow-clear
          />
          <div style="font-size: 12px; opacity: 0.6; margin-top: 4px">
            没配 PAT 或面板连不上 GitHub 时，去 GitHub 仓库 Settings → Actions → Runners → 选中该
            runner → Remove，复制命令里的 token 粘到这里。留空且取不到 token 时，仅本地删除、GitHub
            上需你手动移除。
          </div>
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- 删除结果分步展示 -->
    <a-modal
      v-model:open="resultOpen"
      title="删除结果"
      :width="600"
      :mask-closable="false"
      ok-text="返回列表"
      @ok="closeResult"
      @cancel="closeResult"
    >
      <DeleteResultView :results="deleteResults" />
    </a-modal>

    <!-- Runner 配置抽屉 -->
    <a-drawer v-model:open="configOpen" title="Runner 配置" placement="right" :width="480">
      <a-descriptions :column="1" size="small" bordered style="margin-bottom: 16px">
        <a-descriptions-item label="名称">{{ runner?.agentName }}</a-descriptions-item>
        <a-descriptions-item label="仓库">{{ runner?.repo || "—" }}</a-descriptions-item>
        <a-descriptions-item label="目录">
          <span style="font-size: 12px; word-break: break-all">{{ runner?.dir }}</span>
        </a-descriptions-item>
        <a-descriptions-item label="句柄实例">
          {{
            runner?.instanceUuid || "—"
          }}
        </a-descriptions-item>
      </a-descriptions>

      <a-form layout="vertical">
        <a-form-item label="所属组">
          <a-input v-model:value="groupEdit" placeholder="用于把同批 runner 归到一组" />
          <a-space style="margin-top: 8px">
            <a-button type="primary" size="small" :loading="savingGroup" @click="saveGroup">
              保存所属组
            </a-button>
          </a-space>
        </a-form-item>
      </a-form>

      <a-divider style="margin: 12px 0" />

      <!-- 环境变量：两个目标 ------------------------------------------------->
      <div class="env-editor">
        <a-typography-text strong>环境变量</a-typography-text>

        <!-- 读不到当前值时禁止保存：保存是整表覆盖，空表保存会清空该 runner 全部变量 -->
        <a-alert
          v-if="envLoadFailed"
          type="error"
          show-icon
          style="margin: 8px 0"
          message="环境变量加载失败，已禁用保存以免误清空。请重试加载。"
        >
          <template #action>
            <a-button size="small" :loading="envLoading" @click="loadEnv">重试</a-button>
          </template>
        </a-alert>

        <!-- 目标一：systemd override.conf（进监听进程） -->
        <div style="margin-top: 8px">
          <div style="display: flex; align-items: center; justify-content: space-between">
            <a-typography-text strong>systemd（override.conf）</a-typography-text>
            <a-tag v-if="overrideVars.length" color="blue">{{ overrideVars.length }} 项</a-tag>
          </div>
          <a-alert
            type="info"
            show-icon
            style="margin: 8px 0 12px"
            message="写入 systemd 单元的 Environment=，进「监听进程」。代理这类要让 runner 连上 GitHub 的变量必须放这里。改后需重启单元生效。"
          />
          <a-alert
            v-if="!envHasSystemd"
            type="warning"
            show-icon
            message="该 runner 未装 systemd 服务，无法设置 systemd 级环境变量。"
          />
          <template v-else>
            <a-spin :spinning="envLoading">
              <div v-for="(row, i) in overrideVars" :key="'ov' + i" class="env-row">
                <a-input
                  v-model:value="row.key"
                  placeholder="变量名，如 HTTP_PROXY"
                  class="env-key"
                />
                <span class="env-eq">=</span>
                <a-input v-model:value="row.value" placeholder="值" class="env-val" />
                <a-button type="text" danger size="small" @click="removeEnvRow('override', i)">
                  <DeleteOutlined />
                </a-button>
              </div>
              <a-button
                type="dashed"
                block
                size="small"
                style="margin-top: 4px"
                @click="addEnvRow('override')"
              >
                <PlusOutlined /> 添加变量
              </a-button>
            </a-spin>
            <a-button
              type="primary"
              size="small"
              style="margin-top: 12px"
              :loading="savingTarget === 'override'"
              :disabled="envLoadFailed"
              @click="saveEnv('override')"
            >
              保存 systemd 环境变量
            </a-button>
          </template>
        </div>

        <a-divider style="margin: 16px 0" />

        <!-- 目标二：runner 目录 .env（只进 job/step） -->
        <div>
          <div style="display: flex; align-items: center; justify-content: space-between">
            <a-typography-text strong>运行时 .env</a-typography-text>
            <a-tag v-if="dotenvVars.length" color="green">{{ dotenvVars.length }} 项</a-tag>
          </div>
          <a-alert
            type="info"
            show-icon
            style="margin: 8px 0 12px"
            message="写入 runner 目录的 .env，只注入到 job/step 执行环境（不进监听进程）。设备号、库路径这类放这里。改后需重启单元生效。"
          />
          <a-spin :spinning="envLoading">
            <div v-for="(row, i) in dotenvVars" :key="'de' + i" class="env-row">
              <a-input
                v-model:value="row.key"
                placeholder="变量名，如 DEVICE_RANGE"
                class="env-key"
              />
              <span class="env-eq">=</span>
              <a-input v-model:value="row.value" placeholder="值，如 8-11" class="env-val" />
              <a-button type="text" danger size="small" @click="removeEnvRow('dotenv', i)">
                <DeleteOutlined />
              </a-button>
            </div>
            <a-button
              type="dashed"
              block
              size="small"
              style="margin-top: 4px"
              @click="addEnvRow('dotenv')"
            >
              <PlusOutlined /> 添加变量
            </a-button>
          </a-spin>
          <a-space style="margin-top: 12px">
            <a-button
              type="primary"
              size="small"
              :loading="savingTarget === 'dotenv'"
              :disabled="envLoadFailed"
              @click="saveEnv('dotenv')"
            >
              保存 .env
            </a-button>
            <a-button size="small" @click="configOpen = false">关闭</a-button>
          </a-space>
        </div>
      </div>
    </a-drawer>
  </div>
</template>

<style scoped>
.runner-detail {
  padding: 16px;
}
.header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.title {
  margin: 0 !important;
}
.env-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.env-key {
  flex: 0 0 40%;
}
.env-eq {
  opacity: 0.5;
}
.env-val {
  flex: 1 1 auto;
}
</style>
