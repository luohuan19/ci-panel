<script setup lang="ts">
import type { Component } from "vue";

const props = defineProps<{
  option: {
    label: string;
    icon: Component;
    description: string;
    action: (e: Event) => void;
    disabled?: boolean;
  };
}>();

const handleClick = (e: Event) => {
  if (props.option.disabled) return;
  props.option.action(e);
};
</script>

<template>
  <div
    class="install-option-button"
    :class="{ disabled: option.disabled }"
    role="button"
    :tabindex="option.disabled ? -1 : 0"
    :aria-disabled="option.disabled || undefined"
    @click="handleClick"
    @keydown.enter.space.prevent="handleClick"
  >
    <div class="button-inner">
      <div class="button-icon">
        <component :is="option.icon" />
      </div>
      <div class="button-content">
        <span class="button-label">{{ option.label }}</span>
        <span class="button-desc">{{ option.description }}</span>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.install-option-button {
  --ai-gradient-from: #8b5cf6;
  --ai-gradient-via: #06b6d4;
  --ai-gradient-to: #3b82f6;
  cursor: pointer;
  border-radius: 12px;
  padding: 1px;
  background: var(--color-gray-3);
  border: 1px solid var(--color-gray-5);
  height: 130px;
  transition:
    transform 0.25s ease,
    box-shadow 0.25s ease,
    background 0.25s ease,
    border-color 0.25s ease;

  // 禁用态：保持显示但灰置、不可点、无 hover 动效
  &.disabled {
    cursor: not-allowed;
    opacity: 0.45;
    filter: grayscale(0.6);

    &:hover {
      transform: none;
      border-color: var(--color-gray-5);
      background: var(--color-gray-3);
      box-shadow: none;
    }
    &:hover .button-inner {
      background: var(--color-gray-2);
    }
    &:hover .button-icon {
      color: var(--color-blue-6);
      background: rgba(22, 119, 255, 0.1);
    }
    &:active {
      transform: none;
    }
  }

  &:not(.disabled):hover {
    transform: scale(1.03);
    border-color: transparent;
    background: linear-gradient(
      135deg,
      var(--ai-gradient-from),
      var(--ai-gradient-via),
      var(--ai-gradient-to)
    );
    box-shadow:
      0 8px 24px -8px rgba(139, 92, 246, 0.4),
      0 4px 12px -4px rgba(6, 182, 212, 0.3);
  }

  &:active {
    transform: scale(1.01);
  }

  .button-inner {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 16px 18px;
    border-radius: 11px;
    background: var(--color-gray-2);
    height: 100%;
    min-height: 72px;
  }

  &:hover .button-inner {
    background: var(--color-gray-2);
  }

  .button-icon {
    flex-shrink: 0;
    width: 50px;
    height: 50px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    font-size: 20px;
    color: var(--color-blue-6);
    background: rgba(22, 119, 255, 0.1);
    transition: all 0.25s ease;
  }

  &:hover .button-icon {
    color: var(--ai-gradient-via);
    background: rgba(6, 182, 212, 0.15);
  }

  .button-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .button-label {
    font-size: 15px;
    font-weight: 600;
    color: var(--color-gray-10);
  }

  .button-desc {
    font-size: 13px;
    color: var(--color-gray-7);
    line-height: 1.35;
  }

  .button-cta {
    flex-shrink: 0;
    font-size: 13px;
    font-weight: 500;
    color: var(--color-blue-6);
    transition: color 0.2s ease;
  }

  &:hover .button-cta {
    color: var(--ai-gradient-from);
  }
}
</style>
