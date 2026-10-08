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
  if (!props.isMobile) {
    emit('update:isSearchActive', false);
  }
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
    class="bg-header border-b border-border/50 select-none flex-shrink-0 overflow-hidden"
    :class="isMobile ? 'h-11 px-2.5 flex items-center justify-between' : 'h-9 px-2 flex items-center justify-between'"
  >
    <!-- 移动端专属模式 -->
    <template v-if="isMobile">
      <!-- 移动端：激活搜索时全宽覆盖 -->
      <div v-if="isSearchActive" class="w-full flex items-center gap-2 animate-in fade-in duration-150">
        <div class="relative flex-1">
          <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary/70 text-xs pointer-events-none"></i>
          <input
            ref="searchInputRef"
            type="text"
            :value="searchQuery"
            @input="onSearchInput"
            :placeholder="t('fileManager.searchPlaceholder', '搜索当前目录文件...')"
            class="w-full h-8.5 bg-input border border-border rounded-xl pl-8.5 pr-7 text-xs text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
            data-focus-id="fileManagerSearch"
            @keyup.esc="cancelSearch"
            @keydown.enter.prevent="emit('keydown-search', $event)"
          />
          <button
            v-if="searchQuery"
            type="button"
            class="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary hover:text-foreground text-xs"
            @click.stop="emit('update:searchQuery', '')"
          >
            <i class="fas fa-times-circle"></i>
          </button>
        </div>
        <button
          type="button"
          class="text-xs font-semibold text-primary px-2 py-1.5 active:opacity-60 cursor-pointer shrink-0"
          @click="cancelSearch"
        >
          取消
        </button>
      </div>

      <!-- 移动端：正常工具栏图标排布 (大拇指友好大触控) -->
      <template v-else>
        <!-- 左侧快捷工具 -->
        <div class="flex items-center gap-1.5">
          <!-- CD 到终端 -->
          <button
            type="button"
            class="w-8 h-8 rounded-xl bg-header/60 border border-border/50 flex items-center justify-center text-text-secondary hover:text-foreground active:scale-95 active:bg-primary/20 transition-all disabled:opacity-40"
            @click.stop="emit('cd-to-terminal')"
            :disabled="!isConnected"
            title="在终端打开此路径"
          >
            <i class="fas fa-terminal text-xs"></i>
          </button>

          <!-- 搜索按钮 -->
          <button
            type="button"
            class="w-8 h-8 rounded-xl bg-header/60 border border-border/50 flex items-center justify-center text-text-secondary hover:text-foreground active:scale-95 active:bg-primary/20 transition-all disabled:opacity-40"
            @click.stop="activateSearch"
            :disabled="!isConnected"
            title="搜索文件"
          >
            <i class="fas fa-search text-xs"></i>
          </button>

          <!-- 列表紧凑模式收缩按钮 -->
          <button
            type="button"
            class="w-8 h-8 rounded-xl border flex items-center justify-center text-xs active:scale-95 transition-all"
            :class="isCompactMode ? 'bg-primary/15 border-primary/40 text-primary font-medium' : 'bg-header/60 border border-border/50 text-text-secondary hover:text-foreground'"
            @click.stop="emit('toggle-compact-mode')"
            :title="isCompactMode ? '当前为紧凑模式（点击展开详细）' : '当前为详细模式（点击收缩列表）'"
          >
            <i :class="isCompactMode ? 'fas fa-compress-alt text-xs' : 'fas fa-expand-alt text-xs'"></i>
          </button>
        </div>

        <!-- 右侧核心操作工具 (多选、新建文件、新建文件夹、上传) -->
        <div class="flex items-center gap-1.5 ml-auto">
          <!-- 多选切换 -->
          <button
            type="button"
            @click="emit('toggle-multi-select')"
            title="多选操作"
            class="w-8 h-8 rounded-xl flex items-center justify-center text-xs active:scale-95 transition-all disabled:opacity-40"
            :class="isMultiSelectMode ? 'bg-primary text-white shadow-xs font-medium' : 'bg-header/60 border border-border/50 text-text-secondary hover:text-foreground'"
          >
            <i class="fas fa-check-square text-xs"></i>
          </button>

          <!-- 新建文件 -->
          <button
            type="button"
            @click="emit('new-file')"
            :disabled="!isConnected"
            title="新建文件"
            class="w-8 h-8 rounded-xl bg-header/60 border border-border/50 flex items-center justify-center text-text-secondary hover:text-foreground active:scale-95 active:bg-primary/20 transition-all disabled:opacity-40"
          >
            <i class="far fa-file-alt text-xs text-primary"></i>
          </button>

          <!-- 新建文件夹 -->
          <button
            type="button"
            @click="emit('new-folder')"
            :disabled="!isConnected"
            title="新建文件夹"
            class="w-8 h-8 rounded-xl bg-header/60 border border-border/50 flex items-center justify-center text-text-secondary hover:text-foreground active:scale-95 active:bg-amber-500/20 transition-all disabled:opacity-40"
          >
            <i class="fas fa-folder-plus text-xs text-amber-500"></i>
          </button>

          <!-- 上传文件 -->
          <button
            type="button"
            @click="emit('upload-files')"
            :disabled="!isConnected"
            title="上传文件"
            class="w-8 h-8 rounded-xl bg-header/60 border border-border/50 flex items-center justify-center text-text-secondary hover:text-foreground active:scale-95 active:bg-sky-500/20 transition-all disabled:opacity-40"
          >
            <i class="fas fa-arrow-up-from-bracket text-xs text-sky-500"></i>
          </button>
        </div>
      </template>
    </template>

    <!-- 桌面端常规视图 (100% 保持原有布局) -->
    <template v-else>
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
    </template>
  </div>
</template>

<style scoped>
</style>
