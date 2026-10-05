<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import PathHistoryDropdown from './PathHistoryDropdown.vue';
import FavoritePathsModal from './FavoritePathsModal.vue';
import { usePathHistoryStore } from '../stores/pathHistory.store';

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
  (e: 'navigate-to-path', path: string): void;
  (e: 'cd-to-terminal'): void;
  (e: 'refresh'): void;
  (e: 'go-parent'): void;
  (e: 'open-popup-editor'): void;
  (e: 'upload-files'): void;
  (e: 'new-folder'): void;
  (e: 'new-file'): void;
  (e: 'toggle-multi-select'): void;
  (e: 'keydown-search', event: KeyboardEvent): void;
}>();

const { t } = useI18n();
const pathHistoryStore = usePathHistoryStore();
const { selectedIndex: pathSelectedIndex, filteredHistory: filteredPathHistory } = storeToRefs(pathHistoryStore);

// --- 路径编辑与历史下拉状态 ---
const isEditingPath = ref(false);
const editablePath = ref('');
const pathInputRef = ref<HTMLInputElement | null>(null);
const pathInputWrapperRef = ref<HTMLDivElement | null>(null);
const pathHistoryDropdownRef = ref<InstanceType<typeof PathHistoryDropdown> | null>(null);
const showPathHistoryDropdown = ref(false);

// --- 常用路径收藏夹状态 ---
const showFavoritePathsModal = ref(false);
const favoritePathsButtonRef = ref<HTMLButtonElement | null>(null);

// --- 搜索输入框引用 ---
const searchInputRef = ref<HTMLInputElement | null>(null);

watch(() => props.currentPath, (newPath) => {
  if (!isEditingPath.value) {
    editablePath.value = newPath;
  }
}, { immediate: true });

// --- 路径历史操作 ---
const openPathHistory = () => {
  showPathHistoryDropdown.value = true;
  if (pathHistoryStore.historyList.length === 0) {
    pathHistoryStore.fetchHistory();
  }
  pathHistoryStore.setSearchTerm(editablePath.value);
};

const closePathHistory = () => {
  showPathHistoryDropdown.value = false;
  pathHistoryStore.resetSelection();
};

const handlePathInputFocus = () => {
  isEditingPath.value = true;
  if (props.isLoading || !props.isConnected) return;
  editablePath.value = props.currentPath;
  openPathHistory();
  nextTick(() => {
    pathInputRef.value?.select();
  });
};

const handlePathInputChange = () => {
  if (showPathHistoryDropdown.value) {
    pathHistoryStore.setSearchTerm(editablePath.value);
  }
};

const handlePathInputKeydown = (event: KeyboardEvent) => {
  if (!showPathHistoryDropdown.value) {
    if (event.key === 'Enter') {
      confirmPathEdit();
    } else if (event.key === 'Escape') {
      cancelPathEdit();
    }
    return;
  }

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      pathHistoryStore.selectNextPath();
      break;
    case 'ArrowUp':
      event.preventDefault();
      pathHistoryStore.selectPreviousPath();
      break;
    case 'Enter':
      event.preventDefault();
      if (pathSelectedIndex.value >= 0 && filteredPathHistory.value[pathSelectedIndex.value]) {
        confirmPathNavigation(filteredPathHistory.value[pathSelectedIndex.value].path);
      } else {
        confirmPathEdit();
      }
      closePathHistory();
      break;
    case 'Escape':
      event.preventDefault();
      closePathHistory();
      break;
  }
};

const confirmPathNavigation = (targetPath: string) => {
  const trimmed = targetPath.trim();
  isEditingPath.value = false;
  closePathHistory();
  if (trimmed && trimmed !== props.currentPath) {
    emit('navigate-to-path', trimmed);
    pathHistoryStore.addPath(trimmed);
  }
};

const confirmPathEdit = () => {
  confirmPathNavigation(editablePath.value);
};

const cancelPathEdit = () => {
  isEditingPath.value = false;
  closePathHistory();
  editablePath.value = props.currentPath;
};

const startPathEdit = () => {
  if (props.isLoading || !props.isConnected) return;
  editablePath.value = props.currentPath;
  isEditingPath.value = true;
  openPathHistory();
  nextTick(() => {
    pathInputRef.value?.focus();
    pathInputRef.value?.select();
  });
};

const handlePathInputBlur = (event: FocusEvent) => {
  setTimeout(() => {
    const activeEl = document.activeElement;
    const dropdownEl = pathHistoryDropdownRef.value?.$el;
    if (dropdownEl && dropdownEl.contains(activeEl)) {
      return;
    }
    if (pathInputRef.value !== activeEl) {
      isEditingPath.value = false;
      closePathHistory();
    }
  }, 150);
};

const handlePathSelectedFromDropdown = (path: string) => {
  editablePath.value = path;
  confirmPathNavigation(path);
};

// --- 搜索框交互 ---
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
  pathInputRef,
  startPathEdit,
  focusSearchInput,
  closePathHistory,
});
</script>

<template>
  <div class="flex items-center justify-between flex-wrap gap-2 p-2 bg-header flex-shrink-0">
    <!-- 路径与导航操作包裹层 -->
    <div class="flex items-center gap-2 flex-grow min-w-0">
      <div class="flex items-center flex-shrink-0">
        <!-- CD 到终端按钮 -->
        <button
          class="flex items-center justify-center w-7 h-7 text-text-secondary rounded transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed hover:enabled:bg-black/10 hover:enabled:text-foreground"
          @click.stop="emit('cd-to-terminal')"
          :disabled="!isConnected || isEditingPath"
          :title="t('fileManager.actions.cdToTerminal', 'Change terminal directory to current path')"
        >
          <i class="fas fa-terminal text-base"></i>
        </button>
        <!-- 刷新按钮 -->
        <button
          class="flex items-center justify-center w-7 h-7 text-text-secondary rounded transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed hover:enabled:bg-black/10 hover:enabled:text-foreground"
          @click.stop="emit('refresh')"
          :disabled="!isConnected || isEditingPath"
          :title="t('fileManager.actions.refresh')"
        >
          <i class="fas fa-sync-alt text-base"></i>
        </button>
        <!-- 返回上一级目录按钮 -->
        <button
          class="flex items-center justify-center w-7 h-7 text-text-secondary rounded transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed hover:enabled:bg-black/10 hover:enabled:text-foreground"
          @click.stop="emit('go-parent')"
          :disabled="!isConnected || currentPath === '/' || isEditingPath"
          :title="t('fileManager.actions.parentDirectory')"
        >
          <i class="fas fa-arrow-up text-base"></i>
        </button>
        <!-- 搜索区域 -->
        <div class="flex items-center flex-shrink-0">
          <button
            v-if="!isSearchActive"
            class="flex items-center justify-center w-7 h-7 text-text-secondary rounded transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed hover:enabled:bg-black/10 hover:enabled:text-foreground"
            @click.stop="activateSearch"
            :disabled="!isConnected"
            :title="t('fileManager.searchPlaceholder')"
          >
            <i class="fas fa-search text-base"></i>
          </button>
          <div v-else class="relative flex items-center min-w-[150px] flex-shrink">
            <i class="fas fa-search absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none"></i>
            <input
              ref="searchInputRef"
              type="text"
              :value="searchQuery"
              @input="onSearchInput"
              :placeholder="t('fileManager.searchPlaceholder')"
              class="flex-grow bg-background border border-border rounded pl-7 pr-2 py-1 text-foreground text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary min-w-[10px] transition-colors duration-200"
              data-focus-id="fileManagerSearch"
              @blur="deactivateSearch"
              @keyup.esc="cancelSearch"
              @keydown.up.prevent="emit('keydown-search', $event)"
              @keydown.down.prevent="emit('keydown-search', $event)"
              @keydown.enter.prevent="emit('keydown-search', $event)"
            />
          </div>
        </div>
        <!-- 常用路径收藏夹按钮 -->
        <div class="relative flex-shrink-0">
          <button
            ref="favoritePathsButtonRef"
            class="flex items-center justify-center w-7 h-7 text-text-secondary rounded transition-colors duration-200 hover:enabled:bg-black/10 hover:enabled:text-foreground"
            @click="showFavoritePathsModal = !showFavoritePathsModal"
          >
            <i class="fas fa-star text-base"></i>
          </button>
          <FavoritePathsModal
            :is-visible="showFavoritePathsModal"
            :trigger-element="favoritePathsButtonRef"
            @close="showFavoritePathsModal = false"
            @navigate-to-path="(p: string) => { emit('navigate-to-path', p); showFavoritePathsModal = false; }"
          />
        </div>
      </div>

      <!-- 路径文本与输入栏 -->
      <div
        ref="pathInputWrapperRef"
        class="relative flex items-center bg-background border border-border rounded px-1.5 py-0.5"
        :class="{ 'flex-grow min-w-0': isEditingPath || showPathHistoryDropdown, 'w-fit max-w-full': !isEditingPath && !showPathHistoryDropdown }"
      >
        <span
          v-show="!isEditingPath && !showPathHistoryDropdown"
          @click="startPathEdit"
          class="text-text-secondary pr-2 cursor-text truncate"
        >
          <strong
            :title="t('fileManager.editPathTooltip')"
            class="font-medium text-link px-1 rounded transition-colors duration-200"
            :class="{
              'hover:bg-black/5': isConnected,
              'opacity-60 cursor-not-allowed': !isConnected
            }"
          >
            {{ currentPath || '/' }}
          </strong>
        </span>
        <input
          v-show="isEditingPath || showPathHistoryDropdown"
          ref="pathInputRef"
          type="text"
          v-model="editablePath"
          class="flex-grow bg-transparent text-foreground p-0.5 outline-none min-w-[100px]"
          data-focus-id="fileManagerPathInput"
          @focus="handlePathInputFocus"
          @input="handlePathInputChange"
          @keydown="handlePathInputKeydown"
          @blur="handlePathInputBlur"
        />
        <PathHistoryDropdown
          v-if="showPathHistoryDropdown"
          ref="pathHistoryDropdownRef"
          @pathSelected="handlePathSelectedFromDropdown"
          @closeDropdown="closePathHistory"
          class="left-0 right-0 top-full mt-1"
        />
      </div>
    </div>

    <!-- 主操作按钮区 -->
    <div class="flex items-center gap-2 flex-shrink-0">
      <!-- 打开编辑器按钮 -->
      <button
        v-if="showPopupFileEditor"
        @click="emit('open-popup-editor')"
        :disabled="!isConnected"
        :title="t('fileManager.actions.openEditor', 'Open Popup Editor')"
        class="flex items-center gap-1 px-2.5 py-1 bg-background border border-border rounded text-foreground text-xs transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed hover:enabled:bg-header hover:enabled:border-primary hover:enabled:text-primary"
        :class="{ 'px-1.5': isMobile }"
      >
        <i class="far fa-edit text-sm"></i>
        <span v-if="!isMobile">{{ t('fileManager.actions.openEditor', 'Open Editor') }}</span>
      </button>

      <!-- 上传按钮 -->
      <button
        @click="emit('upload-files')"
        :disabled="!isConnected"
        :title="t('fileManager.actions.uploadFile')"
        class="flex items-center gap-1 px-2.5 py-1 bg-background border border-border rounded text-foreground text-xs transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed hover:enabled:bg-header hover:enabled:border-primary hover:enabled:text-primary"
        :class="{ 'px-1.5': isMobile }"
      >
        <i class="fas fa-upload text-sm"></i>
        <span v-if="!isMobile">{{ t('fileManager.actions.upload') }}</span>
      </button>

      <!-- 新建文件夹按钮 -->
      <button
        @click="emit('new-folder')"
        :disabled="!isConnected"
        :title="t('fileManager.actions.newFolder')"
        class="flex items-center gap-1 px-2.5 py-1 bg-background border border-border rounded text-foreground text-xs transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed hover:enabled:bg-header hover:enabled:border-primary hover:enabled:text-primary"
        :class="{ 'px-1.5': isMobile }"
      >
        <i class="fas fa-folder-plus text-sm"></i>
        <span v-if="!isMobile">{{ t('fileManager.actions.newFolder') }}</span>
      </button>

      <!-- 新建文件按钮 -->
      <button
        @click="emit('new-file')"
        :disabled="!isConnected"
        :title="t('fileManager.actions.newFile')"
        class="flex items-center gap-1 px-2.5 py-1 bg-background border border-border rounded text-foreground text-xs transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed hover:enabled:bg-header hover:enabled:border-primary hover:enabled:text-primary"
        :class="{ 'px-1.5': isMobile }"
      >
        <i class="far fa-file-alt text-sm"></i>
        <span v-if="!isMobile">{{ t('fileManager.actions.newFile') }}</span>
      </button>

      <!-- 移动端多选切换按钮 -->
      <button
        v-if="isMobile"
        @click="emit('toggle-multi-select')"
        :title="isMultiSelectMode ? t('fileManager.actions.exitMultiSelect', 'Exit Multi-Select Mode') : t('fileManager.actions.multiSelect', 'Enter Multi-Select Mode')"
        class="flex items-center gap-1 px-1.5 py-1 bg-background border border-border rounded text-foreground text-xs transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
        :class="{
          'hover:bg-header hover:border-primary hover:text-primary': !isMultiSelectMode,
          'bg-primary text-white border-primary': isMultiSelectMode
        }"
      >
        <i class="fas fa-check-square text-sm"></i>
      </button>
    </div>
  </div>
</template>
