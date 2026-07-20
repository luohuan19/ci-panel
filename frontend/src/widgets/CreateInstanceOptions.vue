<script setup lang="ts">
// 「创建实例」区：从原“应用市场”页(widgets/market/index.vue)抽出，
// 现挂在 CI 实例列表页顶部。仅保留创建方式选项 + 创建表单，去掉模板市场与引导。
import { openNodeSelectDialog } from "@/components/fc/index";
import { router } from "@/config/router";
import { useLayoutCardTools } from "@/hooks/useCardTools";
import { QUICKSTART_METHOD } from "@/hooks/widgets/quickStartFlow";
import { t } from "@/lang/i18n";
import { useAppStateStore } from "@/stores/useAppStateStore";
import type { LayoutCard } from "@/types";
import InstallOptionButton from "@/widgets/market/InstallOptionButton.vue";
import CreateInstanceForm from "@/widgets/setupApp/CreateInstanceForm.vue";
import AddRunnerDialog from "@/widgets/AddRunnerDialog.vue";
import {
  AppstoreAddOutlined,
  BlockOutlined,
  FileZipOutlined,
  FolderOpenOutlined
} from "@ant-design/icons-vue";
import { ref } from "vue";

const props = defineProps<{
  card: LayoutCard;
}>();

const emit = defineEmits<{ (e: "created"): void }>();

const { isAdmin } = useAppStateStore();
const { getMetaOrRouteValue } = useLayoutCardTools(props.card);
const daemonId = getMetaOrRouteValue("daemonId", false) ?? "";

// 「直接创建」= 注册一个 GitHub Runner，点击时打开该对话框
const runnerDialogRef = ref<InstanceType<typeof AddRunnerDialog>>();

const formData = ref({
  createMethod: QUICKSTART_METHOD.DOCKER,
  daemonId: daemonId || ""
});
const showCreateForm = ref(false);

const handleNext = (instanceUuid: string) => {
  showCreateForm.value = false;
  router.push({
    path: "/instances/terminal",
    query: {
      daemonId: formData.value.daemonId,
      instanceId: instanceUuid
    }
  });
};

const handleInstallAction = async (createMethod: QUICKSTART_METHOD) => {
  formData.value.createMethod = createMethod;
  try {
    const selectedNode = await openNodeSelectDialog();
    if (!selectedNode) return;
    formData.value.daemonId = selectedNode.uuid;
    showCreateForm.value = true;
  } catch (error) {
    console.error(error);
  }
};

const manualInstallOptions = [
  {
    label: t("TXT_CODE_a3efb1cc"),
    icon: FileZipOutlined,
    description: t("TXT_CODE_f09da050"),
    // 导入压缩包：复用批量面板，导入模式（指定 tar.gz）
    action: (e: Event) => {
      runnerDialogRef.value?.open("import");
      e.preventDefault();
    }
  },
  {
    label: t("TXT_CODE_bae487e4"),
    icon: BlockOutlined,
    description: t("TXT_CODE_256e5825"),
    // 使用 Docker 镜像创建：暂时禁用，保持显示
    disabled: true,
    action: (e: Event) => {
      handleInstallAction(QUICKSTART_METHOD.DOCKER);
      e.preventDefault();
    }
  },
  {
    label: t("TXT_CODE_e0fca76"),
    icon: FolderOpenOutlined,
    description: t("TXT_CODE_b3844cf8"),
    // 直接创建：用内置 GitHub runner 包
    action: (e: Event) => {
      runnerDialogRef.value?.open("direct");
      e.preventDefault();
    }
  }
];
</script>

<template>
  <div v-if="isAdmin" class="create-instance-options">
    <a-typography-title :level="4" style="margin-bottom: 8px">
      <AppstoreAddOutlined />
      {{ t("TXT_CODE_5a74975b") }}
    </a-typography-title>
    <a-typography-paragraph>
      <p style="opacity: 0.6">
        {{ t("TXT_CODE_81ad9e80") }}
      </p>
    </a-typography-paragraph>
    <div class="manual-install-options">
      <a-row :gutter="[16, 16]">
        <a-col
          v-for="(option, index) in manualInstallOptions"
          :key="index"
          :span="24"
          :md="12"
          :lg="8"
        >
          <InstallOptionButton :option="option" />
        </a-col>
      </a-row>
    </div>

    <a-modal
      v-model:open="showCreateForm"
      :title="t('TXT_CODE_645bc545')"
      :width="1000"
      :footer="null"
      :destroy-on-close="true"
    >
      <CreateInstanceForm
        :create-method="formData.createMethod"
        :daemon-id="formData.daemonId"
        @next-step="handleNext"
      />
    </a-modal>

    <!-- 「直接创建」触发的：注册 Runner 对话框 -->
    <AddRunnerDialog ref="runnerDialogRef" @created="emit('created')" />
  </div>
</template>

<style lang="scss" scoped>
.create-instance-options {
  margin-bottom: 8px;
}
.manual-install-options {
  margin: 20px auto 8px;
}
</style>
