<script setup lang="ts">
// runner 实时日志视图（自研补充）：读 runner 目录 _diag 日志，支持 tail -f 式增量跟随。
// 初次拉尾部若干行；开自动跟随后每秒带 nextOffset 回去，只取新增段追加到底部（省流量、平滑）。
// systemd 托管的 runner 没有 PTY 终端，就靠这个在网页看控制台。
import { ref, computed, watch, onUnmounted, nextTick } from "vue";
import { message } from "ant-design-vue";
import { ReloadOutlined } from "@ant-design/icons-vue";
import { runnerDiagLogs, type DiagLogFile } from "@/services/apis/runner";

const props = defineProps<{
  daemonId: string;
  dir: string;
  height?: string; // 日志区高度，默认按视口
}>();

const loading = ref(false);
const files = ref<DiagLogFile[]>([]);
const currentFile = ref("");
const text = ref("");
const nextOffset = ref(0);
const auto = ref(true);
const logEl = ref<HTMLElement>();

// 内容太长时只保留尾部，避免 DOM/内存无限增长
const MAX_CHARS = 800_000;

let timer: ReturnType<typeof setInterval> | undefined;
function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

function fmtSize(n: number) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + " KB";
  return n + " B";
}
const fileOptions = computed(() =>
  files.value.map((f) => ({ value: f.name, label: `${f.name}  ·  ${fmtSize(f.size)}` }))
);

function nearBottom() {
  const el = logEl.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}
function scrollToBottom() {
  nextTick(() => {
    const el = logEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

// 初次加载(或切文件/reset)：拉尾部并重铺
async function loadInitial(file?: string) {
  if (!props.dir || !props.daemonId) return;
  loading.value = true;
  try {
    const { execute, state } = runnerDiagLogs();
    await execute({
      params: { daemonId: props.daemonId },
      data: { dir: props.dir, file: (file ?? currentFile.value) || undefined, lines: 500 }
    });
    const r = state.value;
    if (r) {
      files.value = r.files || [];
      currentFile.value = r.file || "";
      text.value = r.content || "";
      nextOffset.value = r.nextOffset || 0;
    }
    scrollToBottom();
  } catch (err: any) {
    message.error("读取日志失败：" + (err?.message || err));
    text.value = "";
  } finally {
    loading.value = false;
  }
}

// 跟随一拍：只取新增段
async function follow() {
  if (!props.dir || !currentFile.value) return;
  try {
    const stick = nearBottom();
    const { execute, state } = runnerDiagLogs();
    await execute({
      params: { daemonId: props.daemonId },
      data: { dir: props.dir, file: currentFile.value, offset: nextOffset.value }
    });
    const r = state.value;
    if (!r) return;
    // 文件切换了(轮转)也同步文件列表
    files.value = r.files || files.value;
    if (r.reset) {
      text.value = r.content || "";
    } else if (r.content) {
      text.value += r.content;
    }
    if (text.value.length > MAX_CHARS) text.value = text.value.slice(-MAX_CHARS);
    nextOffset.value = r.nextOffset || nextOffset.value;
    if ((r.content || r.reset) && stick) scrollToBottom();
  } catch {
    /* 跟随失败(比如临时断连)静默，下一拍再试 */
  }
}

function toggleAuto(on: unknown) {
  auto.value = Boolean(on);
  stopTimer();
  if (auto.value) timer = setInterval(follow, 1000);
}
function onPickFile(name: unknown) {
  currentFile.value = String(name);
  loadInitial(String(name));
}

// dir/daemonId 变了重头来
watch(
  () => [props.dir, props.daemonId],
  () => {
    currentFile.value = "";
    loadInitial();
    if (auto.value) {
      stopTimer();
      timer = setInterval(follow, 1000);
    }
  },
  { immediate: true }
);

onUnmounted(stopTimer);
defineExpose({ reload: () => loadInitial() });
</script>

<template>
  <div class="runner-log-view">
    <div class="toolbar">
      <a-select
        v-if="fileOptions.length"
        :value="currentFile"
        :options="fileOptions"
        size="small"
        style="min-width: 280px; flex: 1"
        @change="onPickFile"
      />
      <span v-else style="opacity: 0.6; flex: 1">暂无日志文件</span>
      <a-space>
        <span style="font-size: 12px">自动跟随</span>
        <a-switch :checked="auto" size="small" @change="toggleAuto" />
        <a-button size="small" :loading="loading" @click="loadInitial()">
          <ReloadOutlined /> 刷新
        </a-button>
      </a-space>
    </div>
    <pre ref="logEl" class="log-body" :style="{ height: height || 'calc(100vh - 320px)' }">{{
      text || "（没有日志内容，该 runner 可能从未运行过）"
    }}</pre>
  </div>
</template>

<style scoped>
.runner-log-view {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}
.log-body {
  margin: 0;
  padding: 12px;
  background: #1e1e1e;
  color: #d4d4d4;
  font-family: "Menlo", "Consolas", "Courier New", monospace;
  font-size: 12px;
  line-height: 1.5;
  border-radius: 6px;
  overflow: auto;
  white-space: pre;
  min-height: 200px;
}
</style>
