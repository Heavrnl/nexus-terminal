<script setup lang="ts">
import { ref, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{
  currentPath: string;
  isConnected: boolean;
  isLoading: boolean;
  isMobile: boolean;
  isMultiSelectMode: boolean;
  showPopupFileEditor: boolean;
  searchQuery: string;
  isSearchActive: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:searchQuery', value: string): void;
  (e: 'update:isSearchActive', value: boolean): void;
  (e: 'cd-to-terminal'): void;
  (e: 'open-popup-editor'): void;
  (e: 'upload-files'): void;
  (e: 'new-folder'): void;
  (e: 'new-file'): void;
  (e: 'toggle-multi-select'): void;
  (e: 'keydown-search', event: KeyboardEvent): void;
}>();

const { t } = useI18n();

// --- 搜索输入框引用与交互 ---
const searchInputRef = ref<HTMLInputElement | null>(null);

const activateSearch = () => {
  emit('update:isSearchActive', true);
  nextTick(() => {
    searchInputRef.value?.focus();
  });
};

const deactivateSearch = () => {
  emit('update:isSearchActive', false);
};

const cancelSearch = () => {
  emit('update:searchQuery', '');
  emit('update:isSearchActive', false);
};

const onSearchInput = (e: Event) => {
  const target = e.target as HTMLInputElement;
  emit('update:searchQuery', target.value);
};

const focusSearchInput = (): boolean => {
  if (!props.isSearchActive) {
    activateSearch();
    nextTick(() => {
      searchInputRef.value?.focus();
    });
    return true;
  } else if (searchInputRef.value) {
    searchInputRef.value.focus();
    return true;
  }
  return false;
};

// 暴露用于外部焦点的引用和操作方法
defineExpose({
  searchInputRef,
  focusSearchInput,
});
</script>

<template>
  <div class="h-9 px-2 bg-header flex items-center justify-between border-b border-border/50 select-none flex-shrink-0">
    <!-- 左侧快捷导航与搜索工具 -->
    <div class="flex items-center gap-1 min-w-0">
      <!-- CD 到终端按钮 -->
      <button
        type="button"
        class="flex items-center justify-center w-7 h-7 text-text-secondary rounded transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed hover:enabled:bg-black/10 dark:hover:enabled:bg-white/10 hover:enabled:text-foreground flex-shrink-0"
        @click.stop="emit('cd-to-terminal')"
        :disabled="!isConnected"
        :title="t('fileManager.actions.cdToTerminal', 'Change terminal directory to current path')"
      >
        <i class="fas fa-terminal text-xs"></i>
      </button>

      <!-- 分隔微线 -->
      <div class="h-4 w-px bg-border/60 mx-1 flex-shrink-0"></div>

      <!-- 搜索区域 -->
      <div class="flex items-center flex-shrink-0">
        <button
          v-if="!isSearchActive"
          type="button"
          class="flex items-center justify-center w-7 h-7 text-text-secondary rounded transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed hover:enabled:bg-black/10 dark:hover:enabled:bg-white/10 hover:enabled:text-foreground"
          @click.stop="activateSearch"
          :disabled="!isConnected"
          :title="t('fileManager.searchPlaceholder')"
        >
          <i class="fas fa-search text-xs"></i>
        </button>
        <div v-else class="relative flex items-center min-w-[140px] max-w-[220px]">
          <i class="fas fa-search absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary/70 text-[11px] pointer-events-none"></i>
          <input
            ref="searchInputRef"
            type="text"
            :value="searchQuery"
            @input="onSearchInput"
            :placeholder="t('fileManager.searchPlaceholder')"
            class="w-full bg-background border border-border/80 rounded pl-6 pr-6 py-0.5 text-foreground text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors duration-150"
            data-focus-id="fileManagerSearch"
            @blur="deactivateSearch"
            @keyup.esc="cancelSearch"
            @keydown.up.prevent="emit('keydown-search', $event)"
            @keydown.down.prevent="emit('keydown-search', $event)"
            @keydown.enter.prevent="emit('keydown-search', $event)"
          />
          <button
            v-if="searchQuery"
            type="button"
            class="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-secondary hover:text-foreground text-[10px]"
            @click.stop="cancelSearch"
          >
            <i class="fas fa-times"></i>
          </button>
        </div>
      </div>
    </div>

    <!-- 右侧主要操作按钮组 -->
    <div class="flex items-center gap-1 flex-shrink-0">
      <!-- 移动端多选切换按钮 -->
      <button
        v-if="isMobile"
        type="button"
        @click="emit('toggle-multi-select')"
        :title="isMultiSelectMode ? t('fileManager.actions.exitMultiSelect', 'Exit Multi-Select Mode') : t('fileManager.actions.multiSelect', 'Enter Multi-Select Mode')"
        class="flex items-center justify-center h-7 px-2 rounded text-xs transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
        :class="isMultiSelectMode ? 'bg-primary text-white font-medium' : 'text-text-secondary hover:bg-black/10 dark:hover:bg-white/10 hover:text-foreground'"
      >
        <i class="fas fa-check-square text-xs"></i>
      </button>

      <!-- 新建文件按钮 -->
      <button
        type="button"
        @click="emit('new-file')"
        :disabled="!isConnected"
        :title="t('fileManager.actions.newFile')"
        class="flex items-center gap-1.5 h-7 px-2 rounded text-xs text-text-secondary hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <i class="far fa-file-alt text-xs text-primary/80"></i>
        <span v-if="!isMobile" class="text-[12px]">{{ t('fileManager.actions.newFile') }}</span>
      </button>

      <!-- 新建文件夹按钮 -->
      <button
        type="button"
        @click="emit('new-folder')"
        :disabled="!isConnected"
        :title="t('fileManager.actions.newFolder')"
        class="flex items-center gap-1.5 h-7 px-2 rounded text-xs text-text-secondary hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <i class="fas fa-folder-plus text-xs text-yellow-500/85"></i>
        <span v-if="!isMobile" class="text-[12px]">{{ t('fileManager.actions.newFolder') }}</span>
      </button>

      <!-- 上传文件按钮 -->
      <button
        type="button"
        @click="emit('upload-files')"
        :disabled="!isConnected"
        :title="t('fileManager.actions.uploadFile')"
        class="flex items-center gap-1.5 h-7 px-2 rounded text-xs text-text-secondary hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <i class="fas fa-arrow-up-from-bracket text-xs text-sky-500/85"></i>
        <span v-if="!isMobile" class="text-[12px]">{{ t('fileManager.actions.upload') }}</span>
      </button>

      <!-- 打开独立代码编辑器按钮 -->
      <button
        v-if="showPopupFileEditor"
        type="button"
        @click="emit('open-popup-editor')"
        :disabled="!isConnected"
        :title="t('fileManager.actions.openEditor', 'Open Editor')"
        class="flex items-center gap-1.5 h-7 px-2 rounded text-xs text-text-secondary hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <i class="far fa-edit text-xs"></i>
        <span v-if="!isMobile" class="text-[12px]">{{ t('fileManager.actions.openEditor', 'Open Editor') }}</span>
      </button>
    </div>
  </div>
</template>
