<script setup lang="ts">
// CI Job 看板（自研补充）：展示 GitHub Actions workflow 运行状态
import { onMounted, ref } from "vue";
import { message } from "ant-design-vue";
import { ciRepos, ciRuns, type CiRun } from "@/services/apis/ci";

const { execute: fetchRepos, state: repos } = ciRepos();
const { execute: fetchRuns, state: runs, isLoading } = ciRuns();

const repo = ref<string>("");

async function load() {
  try {
    await fetchRuns({ params: repo.value ? { repo: repo.value } : {} });
  } catch (err: any) {
    message.error("拉取失败（检查后端 CIP_GITHUB_TOKEN）：" + (err?.message || err));
  }
}

onMounted(async () => {
  try {
    await fetchRepos();
    if (repos.value && repos.value.length) repo.value = repos.value[0];
  } catch {
    /* 未配置仓库时忽略 */
  }
  await load();
});

function statusColor(r: CiRun) {
  if (r.status !== "completed") return "processing";
  return (
    { success: "success", failure: "error", cancelled: "default" }[
      r.conclusion || ""
    ] || "default"
  );
}
function statusText(r: CiRun) {
  if (r.status !== "completed") return r.status === "queued" ? "排队中" : "运行中";
  return (
    { success: "成功", failure: "失败", cancelled: "已取消" }[r.conclusion || ""] ||
    r.conclusion ||
    "—"
  );
}

const columns = [
  { title: "#", dataIndex: "run_number", width: 80 },
  { title: "工作流", dataIndex: "name" },
  { title: "分支", dataIndex: "branch", width: 150 },
  { title: "触发", dataIndex: "event", width: 130 },
  { title: "结果", key: "status", width: 130 },
  { title: "时间", dataIndex: "created_at", width: 200 },
  { title: "", key: "link", width: 90 }
];
</script>

<template>
  <div style="padding: 24px">
    <a-card :bordered="false">
      <template #title>
        <span style="font-weight: 600">CI Job 看板 · GitHub Actions</span>
      </template>
      <template #extra>
        <a-space>
          <a-select
            v-if="repos && repos.length"
            v-model:value="repo"
            style="width: 220px"
            :options="repos.map((r) => ({ label: r, value: r }))"
            @change="load"
          />
          <a-button :loading="isLoading" type="primary" @click="load">刷新</a-button>
        </a-space>
      </template>

      <a-table
        :columns="columns"
        :data-source="runs || []"
        row-key="id"
        :loading="isLoading"
        :pagination="{ pageSize: 15 }"
        :locale="{ emptyText: '暂无数据 —— 后端需配置 CIP_GITHUB_TOKEN 与 CIP_GITHUB_REPOS' }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.dataIndex === 'run_number'">
            <span style="color: #8a91a3">#{{ record.run_number }}</span>
          </template>
          <template v-else-if="column.dataIndex === 'name'">
            <span style="font-weight: 600">{{ record.name }}</span>
          </template>
          <template v-else-if="column.dataIndex === 'branch'">
            <a-tag>{{ record.branch }}</a-tag>
          </template>
          <template v-else-if="column.dataIndex === 'created_at'">
            <span style="color: #8a91a3">{{ new Date(record.created_at).toLocaleString() }}</span>
          </template>
          <template v-else-if="column.key === 'status'">
            <a-tag :color="statusColor(record as CiRun)">{{ statusText(record as CiRun) }}</a-tag>
          </template>
          <template v-else-if="column.key === 'link'">
            <a :href="record.html_url" target="_blank" rel="noopener">GitHub ↗</a>
          </template>
        </template>
      </a-table>
    </a-card>
  </div>
</template>
