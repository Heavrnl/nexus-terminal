<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue';
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

// 响应式阈值：
// - 当未激活搜索时，容器宽度 >= 530px 时展示完整文字，小于 530px 自动紧凑折叠为纯图标
// - 当激活搜索框时，搜索框需要占用空间，因此需要 >= 640px 才展示文字，否则收拢为纯图标
const showButtonLabels = computed(() => {
  if (props.isMobile) return false;
  return props.isSearchActive ? containerWidth.value >= 640 : containerWidth.value >= 530;
});

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
  <div
    ref="headerContainerRef"
    class="h-9 px-2 bg-header flex items-center justify-between border-b border-border/50 select-none flex-shrink-0 overflow-hidden"
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

      <!-- 分隔微线 -->
      <div class="h-4 w-px bg-border/60 mx-1 flex-shrink-0"></div>

      <!-- 搜索区域 -->
      <div class="flex items-center flex-shrink min-w-0">
        <button
          v-if="!isSearchActive"
          type="button"
          class="flex items-center justify-center w-7 h-7 text-text-secondary rounded transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed hover:enabled:bg-black/10 dark:hover:enabled:bg-white/10 hover:enabled:text-foreground flex-shrink-0"
          @click.stop="activateSearch"
          :disabled="!isConnected"
          :title="t('fileManager.searchPlaceholder')"
        >
          <i class="fas fa-search text-xs"></i>
        </button>
        <div v-else class="relative flex items-center min-w-[80px] max-w-[200px] flex-shrink">
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
    <div class="flex items-center gap-1 flex-shrink-0 ml-auto pl-1">
      <!-- 移动端多选切换按钮 -->
      <button
        v-if="isMobile"
        type="button"
        @click="emit('toggle-multi-select')"
        :title="isMultiSelectMode ? t('fileManager.actions.exitMultiSelect', 'Exit Multi-Select Mode') : t('fileManager.actions.multiSelect', 'Enter Multi-Select Mode')"
        class="flex items-center justify-center w-7 h-7 rounded text-xs transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
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
