<script setup lang="ts">
// 服务器端目录选择器（自研补充）：浏览扫描根下的目录树、可新建目录，选定一个作基目录。
// 后端严格限制在 CIP_SCAN_ROOTS 之下，前端只做展示与导航。
import { ref } from "vue";
import { message } from "ant-design-vue";
import {
  FolderOutlined,
  FolderOpenOutlined,
  ArrowUpOutlined,
  PlusOutlined,
  ReloadOutlined
} from "@ant-design/icons-vue";
import { listRunnerDirs, makeRunnerDir } from "@/services/apis/runner";

const emit = defineEmits<{ (e: "select", path: string): void }>();

const open = ref(false);
const loading = ref(false);
const daemonId = ref("");
const cur = ref(""); // 当前路径
const parent = ref("");
const dirs = ref<string[]>([]);

async function loadDir(path?: string) {
  if (!daemonId.value) return;
  loading.value = true;
  try {
    const { execute, state } = listRunnerDirs();
    await execute({ params: { daemonId: daemonId.value }, data: { path } });
    const d = state.value;
    if (d) {
      cur.value = d.path;
      parent.value = d.parent;
      dirs.value = d.dirs;
    }
  } catch (err: any) {
    message.error("读取目录失败：" + (err?.message || err));
  } finally {
    loading.value = false;
  }
}

// 对外：打开选择器
function openDialog(node: string, startPath?: string) {
  daemonId.value = node;
  open.value = true;
  loadDir(startPath || undefined);
}
defineExpose({ openDialog });

function enter(name: string) {
  loadDir(cur.value.replace(/\/$/, "") + "/" + name);
}
function goUp() {
  if (parent.value) loadDir(parent.value);
}
// 新建文件夹：用真正的 a-modal + a-input（跟随暗色主题），不用 Modal.confirm 塞裸 input
const folderOpen = ref(false);
const folderName = ref("");
const creatingFolder = ref(false);
function newFolder() {
  folderName.value = "";
  folderOpen.value = true;
}
async function doCreateFolder() {
  const name = folderName.value.trim();
  if (!name) return message.error("请输入文件夹名");
  creatingFolder.value = true;
  try {
    const { execute } = makeRunnerDir();
    await execute({ params: { daemonId: daemonId.value }, data: { path: cur.value, name } });
    folderOpen.value = false;
    await loadDir(cur.value);
    message.success("已创建");
  } catch (err: any) {
    message.error("创建失败：" + (err?.message || err));
  } finally {
    creatingFolder.value = false;
  }
}
function pick() {
  emit("select", cur.value);
  open.value = false;
}
</script>

<template>
  <a-modal v-model:open="open" title="选择基目录" :width="640" :footer="null">
    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px">
      <a-button size="small" :disabled="!parent" @click="goUp"><ArrowUpOutlined /> 上级</a-button>
      <a-button size="small" @click="newFolder"><PlusOutlined /> 新建文件夹</a-button>
      <a-button size="small" :loading="loading" @click="loadDir(cur)"><ReloadOutlined /></a-button>
      <a-input :value="cur" readonly style="flex: 1" />
    </div>

    <div class="dir-list">
      <a-empty v-if="!dirs.length && !loading" description="没有子目录" :image="undefined" />
      <div
        v-for="name in dirs"
        :key="name"
        class="dir-item"
        @dblclick="enter(name)"
        @click="enter(name)"
      >
        <FolderOutlined style="color: #faad14" />
        <span>{{ name }}</span>
      </div>
    </div>

    <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 14px">
      <span style="font-size: 12px; opacity: 0.6">
        <FolderOpenOutlined /> 双击进入子目录；选定后作为基目录（每个 runner = 基目录/&lt;name&gt;）
      </span>
      <a-space>
        <a-button @click="open = false">取消</a-button>
        <a-button type="primary" @click="pick">选择当前目录</a-button>
      </a-space>
    </div>

    <!-- 新建文件夹（真正的 antd 组件，跟随暗色主题）-->
    <a-modal
      v-model:open="folderOpen"
      title="在当前目录下新建文件夹"
      :ok-button-props="{ loading: creatingFolder }"
      ok-text="创建"
      cancel-text="取消"
      @ok="doCreateFolder"
    >
      <div style="font-size: 12px; opacity: 0.6; margin-bottom: 8px">{{ cur }}</div>
      <a-input
        v-model:value="folderName"
        placeholder="文件夹名"
        allow-clear
        @press-enter="doCreateFolder"
      />
    </a-modal>
  </a-modal>
</template>


<style scoped>
.dir-list {
  height: 320px;
  overflow: auto;
  border: 1px solid var(--color-gray-4, #eee);
  border-radius: 6px;
  padding: 6px;
}
.dir-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
}
.dir-item:hover {
  background: rgba(22, 119, 255, 0.08);
}
</style>
