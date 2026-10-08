<script setup lang="ts">
import { ref, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{
  isConnected: boolean;
  isCompactMode?: boolean;
  isMultiSelectMode: boolean;
  searchQuery: string;
  isSearchActive: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:searchQuery', value: string): void;
  (e: 'update:isSearchActive', value: boolean): void;
  (e: 'toggle-compact-mode'): void;
  (e: 'toggle-multi-select'): void;
  (e: 'cd-to-terminal'): void;
  (e: 'upload-files'): void;
  (e: 'new-folder'): void;
  (e: 'new-file'): void;
  (e: 'keydown-search', event: KeyboardEvent): void;
}>();

const { t } = useI18n();
const searchInputRef = ref<HTMLInputElement | null>(null);

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

defineExpose({
  searchInputRef,
  focusSearchInput,
});
</script>

<template>
  <div class="bg-header border-b border-border/50 select-none flex-shrink-0 overflow-hidden h-11 px-2.5 flex items-center justify-between">
    <!-- 移动端：激活搜索时全宽覆盖 -->
    <div v-if="props.isSearchActive" class="w-full flex items-center gap-2 animate-in fade-in duration-150">
      <div class="relative flex-1">
        <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary/70 text-xs pointer-events-none"></i>
        <input
          ref="searchInputRef"
          type="text"
          :value="props.searchQuery"
          @input="onSearchInput"
          :placeholder="t('fileManager.searchPlaceholder', '搜索当前目录文件...')"
          class="w-full h-8.5 bg-input border border-border rounded-xl pl-8.5 pr-7 text-xs text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
          data-focus-id="fileManagerSearch"
          @keyup.esc="cancelSearch"
          @keydown.enter.prevent="emit('keydown-search', $event)"
        />
        <button
          v-if="props.searchQuery"
          type="button"
          class="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary hover:text-foreground text-xs cursor-pointer"
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
        {{ t('common.cancel', '取消') }}
      </button>
    </div>

    <!-- 移动端：正常工具栏图标排布 (大拇指友好大触控) -->
    <template v-else>
      <!-- 左侧快捷工具 -->
      <div class="flex items-center gap-1.5">
        <!-- CD 到终端 -->
        <button
          type="button"
          class="w-8 h-8 rounded-xl bg-header/60 border border-border/50 flex items-center justify-center text-text-secondary hover:text-foreground active:scale-95 active:bg-primary/20 transition-all disabled:opacity-40 cursor-pointer"
          @click.stop="emit('cd-to-terminal')"
          :disabled="!props.isConnected"
          :title="t('fileManager.actions.cdToTerminal', '在终端打开此路径')"
        >
          <i class="fas fa-terminal text-xs"></i>
        </button>

        <!-- 搜索按钮 -->
        <button
          type="button"
          class="w-8 h-8 rounded-xl bg-header/60 border border-border/50 flex items-center justify-center text-text-secondary hover:text-foreground active:scale-95 active:bg-primary/20 transition-all disabled:opacity-40 cursor-pointer"
          @click.stop="activateSearch"
          :disabled="!props.isConnected"
          :title="t('fileManager.searchPlaceholder', '搜索文件')"
        >
          <i class="fas fa-search text-xs"></i>
        </button>

        <!-- 列表紧凑模式收缩按钮 -->
        <button
          type="button"
          class="w-8 h-8 rounded-xl border flex items-center justify-center text-xs active:scale-95 transition-all cursor-pointer"
          :class="props.isCompactMode ? 'bg-primary/15 border-primary/40 text-primary font-medium' : 'bg-header/60 border border-border/50 text-text-secondary hover:text-foreground'"
          @click.stop="emit('toggle-compact-mode')"
          :title="props.isCompactMode ? t('fileManager.compactModeOn', '当前为紧凑模式（点击展开详细）') : t('fileManager.compactModeOff', '当前为详细模式（点击收缩列表）')"
        >
          <i :class="props.isCompactMode ? 'fas fa-compress-alt text-xs' : 'fas fa-expand-alt text-xs'"></i>
        </button>
      </div>

      <!-- 右侧核心操作工具 (多选、新建文件、新建文件夹、上传) -->
      <div class="flex items-center gap-1.5 ml-auto">
        <!-- 多选切换 -->
        <button
          type="button"
          @click="emit('toggle-multi-select')"
          :title="t('fileManager.multiSelect', '多选操作')"
          class="w-8 h-8 rounded-xl flex items-center justify-center text-xs active:scale-95 transition-all disabled:opacity-40 cursor-pointer"
          :class="props.isMultiSelectMode ? 'bg-primary text-white shadow-xs font-medium' : 'bg-header/60 border border-border/50 text-text-secondary hover:text-foreground'"
        >
          <i class="fas fa-check-square text-xs"></i>
        </button>

        <!-- 新建文件 -->
        <button
          type="button"
          @click="emit('new-file')"
          :disabled="!props.isConnected"
          :title="t('fileManager.actions.newFile', '新建文件')"
          class="w-8 h-8 rounded-xl bg-header/60 border border-border/50 flex items-center justify-center text-text-secondary hover:text-foreground active:scale-95 active:bg-primary/20 transition-all disabled:opacity-40 cursor-pointer"
        >
          <i class="far fa-file-alt text-xs text-primary"></i>
        </button>

        <!-- 新建文件夹 -->
        <button
          type="button"
          @click="emit('new-folder')"
          :disabled="!props.isConnected"
          :title="t('fileManager.actions.newFolder', '新建文件夹')"
          class="w-8 h-8 rounded-xl bg-header/60 border border-border/50 flex items-center justify-center text-text-secondary hover:text-foreground active:scale-95 active:bg-amber-500/20 transition-all disabled:opacity-40 cursor-pointer"
        >
          <i class="fas fa-folder-plus text-xs text-amber-500"></i>
        </button>

        <!-- 上传文件 -->
        <button
          type="button"
          @click="emit('upload-files')"
          :disabled="!props.isConnected"
          :title="t('fileManager.actions.uploadFile', '上传文件')"
          class="w-8 h-8 rounded-xl bg-header/60 border border-border/50 flex items-center justify-center text-text-secondary hover:text-foreground active:scale-95 active:bg-sky-500/20 transition-all disabled:opacity-40 cursor-pointer"
        >
          <i class="fas fa-arrow-up-from-bracket text-xs text-sky-500"></i>
        </button>
      </div>
    </template>
  </div>
</template>
