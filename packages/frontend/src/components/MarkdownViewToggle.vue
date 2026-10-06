<script setup lang="ts">
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const props = defineProps<{
  viewMode: 'split' | 'edit' | 'preview';
  syncScroll: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:viewMode', mode: 'split' | 'edit' | 'preview'): void;
  (e: 'update:syncScroll', enabled: boolean): void;
}>();

const handleToggleSyncScroll = () => {
  emit('update:syncScroll', !props.syncScroll);
};
</script>

<template>
  <div class="markdown-view-toggle">
    <button
      type="button"
      class="markdown-toggle-btn"
      :class="{ active: props.viewMode === 'edit' }"
      @click="emit('update:viewMode', 'edit')"
      :title="t('fileManager.markdown.editOnly')"
    >
      <i class="fas fa-code"></i>
    </button>
    <button
      type="button"
      class="markdown-toggle-btn"
      :class="{ active: props.viewMode === 'split' }"
      @click="emit('update:viewMode', 'split')"
      :title="t('fileManager.markdown.split')"
    >
      <i class="fas fa-columns"></i>
    </button>
    <button
      type="button"
      class="markdown-toggle-btn"
      :class="{ active: props.viewMode === 'preview' }"
      @click="emit('update:viewMode', 'preview')"
      :title="t('fileManager.markdown.previewOnly')"
    >
      <i class="fas fa-eye"></i>
    </button>

    <!-- 双栏分屏模式下的同步滚动切换按钮 -->
    <template v-if="props.viewMode === 'split'">
      <span class="markdown-toggle-divider"></span>
      <button
        type="button"
        class="markdown-toggle-btn sync-scroll-btn"
        :class="{ active: props.syncScroll }"
        @click="handleToggleSyncScroll"
        :title="props.syncScroll ? t('fileManager.markdown.syncScrollEnabled') : t('fileManager.markdown.syncScrollDisabled')"
      >
        <i :class="props.syncScroll ? 'fas fa-link' : 'fas fa-unlink'"></i>
      </button>
    </template>
  </div>
</template>

<style scoped>
.markdown-view-toggle {
  display: flex;
  align-items: center;
  background-color: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  padding: 2px;
  gap: 2px;
}

.markdown-toggle-divider {
  width: 1px;
  height: 14px;
  background-color: rgba(255, 255, 255, 0.2);
  margin: 0 2px;
}

.markdown-toggle-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 24px;
  border-radius: 4px;
  font-size: 0.78rem;
  color: #9ca3af;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: all 0.15s ease;
}

.markdown-toggle-btn:hover {
  color: #ffffff;
  background-color: rgba(255, 255, 255, 0.1);
}

.markdown-toggle-btn.active {
  color: #ffffff;
  background-color: var(--color-primary, #3b82f6);
}
</style>
