<script setup lang="ts">
import type { LayoutCard } from "@/types/index";
import { LAYOUT_CARD_TYPES } from "@/config/index";
import { computed, onErrorCaptured, ref } from "vue";

const props = defineProps<{
  card: LayoutCard;
}>();

const componentMap: { [key: string]: any } = LAYOUT_CARD_TYPES;

const loadError = ref(false);
const cardError = ref<Error>(new Error(""));

// 一个已保存的布局可能引用了后来被删掉的卡片类型。此时 componentMap 取不到组件，
// <component :is="undefined"> 只会在控制台警告并渲染成空节点，onErrorCaptured 也捕获不到
// （那是警告而非抛错），结果就是一块无法排查的空白卡片。这里显式转成可见的错误卡片。
const unknownType = computed(() => !componentMap[props.card.type]);

onErrorCaptured((error: Error) => {
  console.error(`Card: ${props.card.id}-${props.card.type}-${props.card.title} Error:`, error);
  loadError.value = true;
  cardError.value = error;
  return false;
});
</script>

<template>
  <div
    :id="'layout-card-container-' + card.id"
    class="layout-card-container transition-all-6 global-drag-animation"
  >
    <component
      :is="componentMap[card.type]"
      v-if="!loadError && !unknownType"
      style="height: 100%"
      :card="props.card"
    ></component>

    <CardError
      v-else
      :error="unknownType ? new Error(`Unknown card type: ${card.type}`) : cardError"
      :title="card.title"
    ></CardError>
  </div>
</template>

<style lang="scss" scoped>
.layout-card-container {
  width: 100%;
  height: 100%;
}
</style>
