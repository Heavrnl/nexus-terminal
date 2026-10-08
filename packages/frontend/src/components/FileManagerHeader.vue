<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import MobileFileManagerHeader from './MobileFileManagerHeader.vue';

const props = defineProps<{
  currentPath: string;
  isConnected: boolean;
  isLoading: boolean;
  isMobile: boolean;
  isMultiSelectMode: boolean;
  showPopupFileEditor: boolean;
  searchQuery: string;
  isSearchActive: boolean;
  isCompactMode?: boolean;
  showDirectoryTree?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:searchQuery', value: string): void;
  (e: 'update:isSearchActive', value: boolean): void;
  (e: 'toggle-compact-mode'): void;
  (e: 'toggle-directory-tree'): void;
  (e: 'cd-to-terminal'): void;
  (e: 'open-popup-editor'): void;
  (e: 'upload-files'): void;
  (e: 'new-folder'): void;
  (e: 'new-file'): void;
  (e: 'toggle-multi-select'): void;
  (e: 'keydown-search', event: KeyboardEvent): void;
}>();

const { t } = useI18n();

// --- 容器宽度自适应响应式监听 ---
const headerContainerRef = ref<HTMLDivElement | null>(null);
const containerWidth = ref<number>(600);
let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  if (headerContainerRef.value) {
    containerWidth.value = headerContainerRef.value.offsetWidth;
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect) {
          containerWidth.value = entry.contentRect.width;
        }
      }
    });
    resizeObserver.observe(headerContainerRef.value);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});

const showButtonLabels = computed(() => {
  if (props.isMobile) return false;
  return containerWidth.value >= 530;
});

// --- 搜索输入框引用与交互 ---
const searchInputRef = ref<HTMLInputElement | null>(null);

const toggleSearch = () => {
  emit('update:isSearchActive', !props.isSearchActive);
};

const activateSearch = () => {
  emit('update:isSearchActive', true);
  nextTick(() => {
    searchInputRef.value?.focus();
  });
};

const cancelSearch = () => {
  emit('update:searchQuery', '');
  emit('update:isSearchActive', false);
};

const onSearchInput = (e: Event) => {
  const target = e.target as HTMLInputElement;
  emit('update:searchQuery', target.value);
};

const mobileHeaderRef = ref<InstanceType<typeof MobileFileManagerHeader> | null>(null);

const focusSearchInput = (): boolean => {
  if (props.isMobile && mobileHeaderRef.value) {
    return mobileHeaderRef.value.focusSearchInput();
  }
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
  <!-- 移动端专属模式 -->
  <MobileFileManagerHeader
    v-if="isMobile"
    ref="mobileHeaderRef"
    :is-connected="isConnected"
    :is-compact-mode="isCompactMode"
    :is-multi-select-mode="isMultiSelectMode"
    :search-query="searchQuery"
    :is-search-active="isSearchActive"
    @update:search-query="emit('update:searchQuery', $event)"
    @update:is-search-active="emit('update:isSearchActive', $event)"
    @toggle-compact-mode="emit('toggle-compact-mode')"
    @toggle-multi-select="emit('toggle-multi-select')"
    @cd-to-terminal="emit('cd-to-terminal')"
    @upload-files="emit('upload-files')"
    @new-folder="emit('new-folder')"
    @new-file="emit('new-file')"
    @keydown-search="emit('keydown-search', $event)"
  />

  <!-- 桌面端常规视图 (100% 保持原有布局) -->
  <div
    v-else
    ref="headerContainerRef"
    class="bg-header border-b border-border/50 select-none flex-shrink-0 overflow-hidden h-9 px-2 flex items-center justify-between"
  >
      <!-- 左侧快捷导航与搜索工具 -->
      <div class="flex items-center gap-1 min-w-0 flex-shrink">
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

        <!-- 切换目录树显示按钮 -->
        <button
          type="button"
          class="flex items-center justify-center w-7 h-7 rounded transition-colors duration-150 flex-shrink-0"
          :class="showDirectoryTree ? 'bg-primary/20 text-primary font-medium' : 'text-text-secondary hover:bg-black/10 dark:hover:bg-white/10 hover:text-foreground'"
          @click.stop="emit('toggle-directory-tree')"
          :title="showDirectoryTree ? t('fileManager.actions.hideDirectoryTree', '隐藏目录树') : t('fileManager.actions.showDirectoryTree', '显示目录树')"
        >
          <i class="fas fa-sitemap text-xs"></i>
        </button>

        <!-- 分隔微线 -->
        <div class="h-4 w-px bg-border/60 mx-1 flex-shrink-0"></div>

        <!-- 搜索切换按钮（点击在下方新建/收起独立搜索栏） -->
        <button
          type="button"
          class="flex items-center justify-center w-7 h-7 rounded transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
          :class="isSearchActive ? 'bg-primary/20 text-primary font-medium' : 'text-text-secondary hover:bg-black/10 dark:hover:bg-white/10 hover:text-foreground'"
          @click.stop="toggleSearch"
          :disabled="!isConnected"
          :title="isSearchActive ? t('fileManager.actions.closeSearch', '关闭搜索栏') : t('fileManager.searchPlaceholder', '搜索')"
        >
          <i class="fas fa-search text-xs"></i>
        </button>
      </div>

      <!-- 右侧主要操作按钮组 -->
      <div class="flex items-center gap-1 flex-shrink-0 ml-auto pl-1">
        <!-- 新建文件按钮 -->
        <button
          type="button"
          @click="emit('new-file')"
          :disabled="!isConnected"
          :title="t('fileManager.actions.newFile')"
          class="flex items-center h-7 rounded text-xs text-text-secondary hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
          :class="showButtonLabels ? 'gap-1.5 px-2' : 'justify-center w-7'"
        >
          <i class="far fa-file-alt text-xs text-primary/80"></i>
          <span v-if="showButtonLabels" class="text-[12px] whitespace-nowrap">{{ t('fileManager.actions.newFile') }}</span>
        </button>

        <!-- 新建文件夹按钮 -->
        <button
          type="button"
          @click="emit('new-folder')"
          :disabled="!isConnected"
          :title="t('fileManager.actions.newFolder')"
          class="flex items-center h-7 rounded text-xs text-text-secondary hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
          :class="showButtonLabels ? 'gap-1.5 px-2' : 'justify-center w-7'"
        >
          <i class="fas fa-folder-plus text-xs text-yellow-500/85"></i>
          <span v-if="showButtonLabels" class="text-[12px] whitespace-nowrap">{{ t('fileManager.actions.newFolder') }}</span>
        </button>

        <!-- 上传文件按钮 -->
        <button
          type="button"
          @click="emit('upload-files')"
          :disabled="!isConnected"
          :title="t('fileManager.actions.uploadFile')"
          class="flex items-center h-7 rounded text-xs text-text-secondary hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
          :class="showButtonLabels ? 'gap-1.5 px-2' : 'justify-center w-7'"
        >
          <i class="fas fa-arrow-up-from-bracket text-xs text-sky-500/85"></i>
          <span v-if="showButtonLabels" class="text-[12px] whitespace-nowrap">{{ t('fileManager.actions.upload') }}</span>
        </button>

        <!-- 打开独立代码编辑器按钮 -->
        <button
          v-if="showPopupFileEditor"
          type="button"
          @click="emit('open-popup-editor')"
          :disabled="!isConnected"
          :title="t('fileManager.actions.openEditor', 'Open Editor')"
          class="flex items-center h-7 rounded text-xs text-text-secondary hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
          :class="showButtonLabels ? 'gap-1.5 px-2' : 'justify-center w-7'"
        >
          <i class="far fa-edit text-xs"></i>
          <span v-if="showButtonLabels" class="text-[12px] whitespace-nowrap">{{ t('fileManager.actions.openEditor', 'Open Editor') }}</span>
        </button>
      </div>
  </div>
</template>

<style scoped>
</style>
