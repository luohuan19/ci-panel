import { GLOBAL_INSTANCE_NAME } from "@/config/const";
import { t } from "@/lang/i18n";
import { getInstanceInfo } from "@/services/apis/instance";
import type { InstanceDetail, MapData } from "@/types";
import { INSTANCE_STATUS, INSTANCE_STATUS_CODE } from "@/types/const";
import { computed, onMounted, onUnmounted, ref, type Ref } from "vue";

export const TYPE_UNIVERSAL = "universal";
export const TYPE_WEB_SHELL = "universal/web_shell";

export const INSTANCE_TYPE_TRANSLATION: MapData<string> = {
  [TYPE_UNIVERSAL]: t("TXT_CODE_a92a4aa1"),
  [TYPE_WEB_SHELL]: t("TXT_CODE_31c5a4d0")
};

interface Params {
  instanceId?: string;
  daemonId?: string;
  autoRefresh?: boolean;
  instanceInfo?: Ref<InstanceDetail | undefined>;
}

export interface InstanceMoreDetail extends InstanceDetail {
  moreInfo?: {
    isRunning: boolean;
    isStopped: boolean;
    instanceTypeText: string;
    statusText: string;
  };
}

export function useInstanceMoreDetail(info: InstanceMoreDetail): InstanceMoreDetail {
  const { statusText, isRunning, isStopped, instanceTypeText } = useInstanceInfo({
    instanceInfo: ref(info)
  });

  info.moreInfo = {
    statusText: statusText.value,
    isRunning: isRunning.value,
    isStopped: isStopped.value,
    instanceTypeText: instanceTypeText.value
  };

  return info;
}

export function useInstanceInfo(params: Params) {
  let task: NodeJS.Timeout | undefined;
  const { daemonId, instanceId, instanceInfo, autoRefresh } = params;

  const { execute, state, isLoading, isReady } = getInstanceInfo();

  let finalState = state;
  if (instanceInfo) finalState = instanceInfo;

  const isUnknown = computed(() => finalState?.value?.status === INSTANCE_STATUS_CODE.BUSY);
  const isStopped = computed(() => finalState?.value?.status === INSTANCE_STATUS_CODE.STOPPED);
  const isStopping = computed(() => finalState?.value?.status === INSTANCE_STATUS_CODE.STOPPING);
  const isStarting = computed(() => finalState?.value?.status === INSTANCE_STATUS_CODE.STARTING);
  const isRunning = computed(() => finalState?.value?.status === INSTANCE_STATUS_CODE.RUNNING);
  const isGlobalTerminal = computed(() => {
    return state.value?.config.nickname === GLOBAL_INSTANCE_NAME;
  });

  const instanceTypeText = computed(() => {
    return (
      INSTANCE_TYPE_TRANSLATION[String(finalState?.value?.config.type)] || t("TXT_CODE_da7a0328")
    );
  });
  const statusText = computed(
    () => String(INSTANCE_STATUS[finalState.value?.status ?? -1]) || t("TXT_CODE_c8333afa")
  );

  onMounted(async () => {
    if (instanceId && daemonId) {
      await execute({
        params: {
          uuid: instanceId,
          daemonId: daemonId
        }
      });

      if (autoRefresh) {
        task = setInterval(async () => {
          await execute({
            params: {
              uuid: instanceId,
              daemonId: daemonId
            }
          });
        }, 3000);
      }
    }
  });

  onUnmounted(() => {
    if (task) clearInterval(task);
    task = undefined;
  });

  return {
    isLoading,
    isReady,
    instanceInfo: finalState,
    execute,
    statusText,
    isUnknown,
    isStopped,
    isStopping,
    isStarting,
    isRunning,
    instanceTypeText,
    isGlobalTerminal
  };
}
