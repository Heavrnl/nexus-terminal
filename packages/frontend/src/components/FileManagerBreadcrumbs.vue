<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import type { FileListItem } from '../types/sftp.types';
import type { SftpManagerInstance } from '../composables/useSftpActions';
import PathHistoryDropdown from './PathHistoryDropdown.vue';
import FavoritePathsModal from './FavoritePathsModal.vue';
import { usePathHistoryStore } from '../stores/pathHistory.store';

const props = defineProps<{
  currentPath: string;
  isConnected: boolean;
  isLoading: boolean;
  isMobile: boolean;
  sftpManager: SftpManagerInstance | null;
}>();

const emit = defineEmits<{
  (e: 'navigate-to-path', path: string): void;
  (e: 'open-file', fileItem: FileListItem, fullPath?: string): void;
  (e: 'cd-to-terminal'): void;
  (e: 'refresh'): void;
}>();

const { t } = useI18n();
const pathHistoryStore = usePathHistoryStore();
const { selectedIndex: pathSelectedIndex, filteredHistory: filteredPathHistory } = storeToRefs(pathHistoryStore);

// --- 路径编辑与历史下拉状态 ---
const isEditing = ref(false);
const editablePath = ref('');
const pathInputRef = ref<HTMLInputElement | null>(null);
const pathHistoryDropdownRef = ref<InstanceType<typeof PathHistoryDropdown> | null>(null);
const showPathHistoryDropdown = ref(false);

// --- 常用路径收藏夹状态 ---
const showFavoritePathsModal = ref(false);
const favoritePathsButtonRef = ref<HTMLButtonElement | null>(null);

// --- 复制成功提示 ---
const copySuccess = ref(false);

// --- 斜杠下拉级联菜单状态 ---
const activeDropdownDir = ref<string | null>(null);
const dropdownItems = ref<FileListItem[]>([]);
const isLoadingDropdown = ref(false);
const dropdownFilter = ref('');
const dropdownPopoverRef = ref<HTMLDivElement | null>(null);
const dropdownPosition = ref<{ top: number; left: number }>({ top: 0, left: 0 });
const breadcrumbStreamRef = ref<HTMLDivElement | null>(null);

const closeDirDropdown = () => {
  activeDropdownDir.value = null;
  dropdownItems.value = [];
  dropdownFilter.value = '';
};

watch(() => props.currentPath, (newPath) => {
  if (!isEditing.value) {
    editablePath.value = newPath;
  }
  closeDirDropdown();
  nextTick(() => {
    if (breadcrumbStreamRef.value) {
      breadcrumbStreamRef.value.scrollLeft = breadcrumbStreamRef.value.scrollWidth;
    }
  });
}, { immediate: true });

// --- 面包屑分段解析 ---
interface BreadcrumbSegment {
  name: string;
  path: string;
  isRoot: boolean;
}

const breadcrumbSegments = computed<BreadcrumbSegment[]>(() => {
  const path = props.currentPath || '/';
  if (path === '/' || path === '') {
    return [{ name: '/', path: '/', isRoot: true }];
  }

  const parts = path.split('/').filter(Boolean);
  const segments: BreadcrumbSegment[] = [
    { name: '/', path: '/', isRoot: true }
  ];

  let accumulatedPath = '';
  for (const part of parts) {
    accumulatedPath += `/${part}`;
    segments.push({
      name: part,
      path: accumulatedPath,
      isRoot: false,
    });
  }

  return segments;
});

// --- 导航至指定路径 ---
const navigateTo = (targetPath: string) => {
  if (props.isLoading || !props.isConnected) return;
  const trimmed = targetPath.trim() || '/';
  closeDirDropdown();
  if (trimmed !== props.currentPath) {
    emit('navigate-to-path', trimmed);
    pathHistoryStore.addPath(trimmed);
  }
};

// --- 编辑输入框操作 ---
const startEdit = () => {
  if (props.isLoading || !props.isConnected) return;
  closeDirDropdown();
  isEditing.value = true;
  editablePath.value = props.currentPath;
  showPathHistoryDropdown.value = true;
  if (pathHistoryStore.historyList.length === 0) {
    pathHistoryStore.fetchHistory();
  }
  pathHistoryStore.setSearchTerm(editablePath.value);

  nextTick(() => {
    pathInputRef.value?.focus();
    pathInputRef.value?.select();
  });
};

const cancelEdit = () => {
  isEditing.value = false;
  showPathHistoryDropdown.value = false;
  editablePath.value = props.currentPath;
  pathHistoryStore.resetSelection();
};

const confirmEdit = () => {
  const target = editablePath.value.trim();
  isEditing.value = false;
  showPathHistoryDropdown.value = false;
  pathHistoryStore.resetSelection();
  if (target) {
    navigateTo(target);
  }
};

const handlePathInputKeydown = (event: KeyboardEvent) => {
  if (!showPathHistoryDropdown.value) {
    if (event.key === 'Enter') confirmEdit();
    else if (event.key === 'Escape') cancelEdit();
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
        navigateTo(filteredPathHistory.value[pathSelectedIndex.value].path);
      } else {
        confirmEdit();
      }
      break;
    case 'Escape':
      event.preventDefault();
      cancelEdit();
      break;
  }
};

const handlePathInputChange = () => {
  if (showPathHistoryDropdown.value) {
    pathHistoryStore.setSearchTerm(editablePath.value);
  }
};

const handlePathInputBlur = () => {
  setTimeout(() => {
    const activeEl = document.activeElement;
    const dropdownEl = pathHistoryDropdownRef.value?.$el;
    if (dropdownEl && dropdownEl.contains(activeEl)) {
      return;
    }
    if (pathInputRef.value !== activeEl) {
      isEditing.value = false;
      showPathHistoryDropdown.value = false;
    }
  }, 150);
};

const handlePathSelectedFromHistory = (path: string) => {
  editablePath.value = path;
  navigateTo(path);
};

// --- 斜杠下拉级联菜单 ---
const toggleDirDropdown = async (dirPath: string, event: MouseEvent) => {
  event.stopPropagation();
  if (!props.isConnected || !props.sftpManager) return;

  if (activeDropdownDir.value === dirPath) {
    closeDirDropdown();
    return;
  }

  activeDropdownDir.value = dirPath;
  dropdownFilter.value = '';
  isLoadingDropdown.value = true;
  dropdownItems.value = [];

  // 计算下拉浮层定位
  const targetEl = event.currentTarget as HTMLElement;
  const rect = targetEl.getBoundingClientRect();
  const parentContainer = targetEl.closest('.breadcrumbs-container');
  const parentRect = parentContainer?.getBoundingClientRect() || { top: 0, left: 0 };

  dropdownPosition.value = {
    top: rect.bottom - parentRect.top + 4,
    left: Math.max(0, rect.left - parentRect.left),
  };

  try {
    const items = await props.sftpManager.listDirectoryContents(dirPath);
    dropdownItems.value = items;
  } catch (err) {
    console.warn(`[Breadcrumbs] 加载目录 ${dirPath} 清单失败:`, err);
    dropdownItems.value = [];
  } finally {
    isLoadingDropdown.value = false;
  }
};


// 筛选过滤后的下拉列表项
const filteredDropdownItems = computed(() => {
  const query = dropdownFilter.value.trim().toLowerCase();
  if (!query) return dropdownItems.value;
  return dropdownItems.value.filter(item => item.filename.toLowerCase().includes(query));
});

const handleDropdownItemClick = (item: FileListItem) => {
  if (!activeDropdownDir.value || !props.sftpManager) return;
  const targetPath = props.sftpManager.joinPath(activeDropdownDir.value, item.filename);

  if (item.attrs.isDirectory) {
    navigateTo(targetPath);
  } else {
    emit('open-file', item, targetPath);
  }
  closeDirDropdown();
};

// 一键复制当前绝对路径
const copyCurrentPath = async (e: MouseEvent) => {
  e.stopPropagation();
  try {
    await navigator.clipboard.writeText(props.currentPath || '/');
    copySuccess.value = true;
    setTimeout(() => {
      copySuccess.value = false;
    }, 1500);
  } catch (err) {
    console.error('[Breadcrumbs] 复制路径失败:', err);
  }
};

// 全局点击监听用于关闭级联下拉浮层
const handleGlobalClick = (event: MouseEvent) => {
  if (activeDropdownDir.value && dropdownPopoverRef.value) {
    const target = event.target as Node;
    if (!dropdownPopoverRef.value.contains(target)) {
      closeDirDropdown();
    }
  }
};

onMounted(() => {
  window.addEventListener('click', handleGlobalClick);
});

onBeforeUnmount(() => {
  window.removeEventListener('click', handleGlobalClick);
});

defineExpose({
  startEdit,
  cancelEdit,
});
</script>

<template>
  <div
    class="breadcrumbs-container relative flex items-center h-8 px-2 bg-header/90 border-b border-border/70 text-xs select-none transition-colors duration-150 flex-shrink-0"
    :class="{ 'ring-1 ring-primary/40 border-primary/50': isEditing }"
  >
    <!-- 最左侧：将终端目录切换到当前路径按钮 -->
    <button
      type="button"
      class="flex items-center justify-center w-6 h-6 mr-1 rounded text-text-secondary hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
      @click.stop="emit('cd-to-terminal')"
      :disabled="!isConnected"
      :title="t('fileManager.actions.cdToTerminal', 'Change terminal directory to current path')"
    >
      <i class="fas fa-terminal text-[11px] text-text-secondary/80"></i>
    </button>

    <!-- 面包屑显示态 -->
    <div
      v-if="!isEditing"
      class="flex items-center flex-grow min-w-0 h-full overflow-hidden"
      @click="startEdit"
    >
      <!-- 可点击的面包屑段落流：自适应宽度，超出时自动滚动且预留右侧空白 -->
      <div
        ref="breadcrumbStreamRef"
        class="flex items-center flex-shrink min-w-0 max-w-[calc(100%-36px)] overflow-x-auto no-scrollbar py-0.5"
      >
        <template v-for="(seg, idx) in breadcrumbSegments" :key="seg.path">
          <!-- 根目录纯图标按钮 -->
          <template v-if="seg.isRoot">
            <button
              type="button"
              class="flex items-center justify-center w-6 h-6 rounded text-text-secondary hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-150 flex-shrink-0"
              :class="{ 'text-foreground bg-black/5 dark:bg-white/5': breadcrumbSegments.length === 1 }"
              @click.stop="navigateTo('/')"
              :title="t('fileManager.actions.rootDirectory', '根目录')"
            >
              <i class="fas fa-hdd text-xs text-primary/80"></i>
            </button>
            <!-- 根目录与下一级之间的斜杠按钮（在有子目录时显示） -->
            <button
              v-if="breadcrumbSegments.length > 1"
              type="button"
              class="slash-btn flex items-center justify-center h-5 w-4 rounded text-text-secondary/60 hover:text-primary hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-150 flex-shrink-0 font-mono text-xs select-none"
              @click.stop="toggleDirDropdown('/', $event)"
              :class="{ 'text-primary bg-primary/15 font-semibold': activeDropdownDir === '/' }"
              title="展开目录子项"
            >
              /
            </button>
          </template>

          <!-- 普通路径段落 -->
          <template v-else>
            <button
              type="button"
              class="flex items-center px-1.5 py-0.5 rounded text-text-secondary hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-150 font-medium truncate max-w-[140px] flex-shrink-0"
              :class="{ 'text-foreground font-semibold bg-black/5 dark:bg-white/5': idx === breadcrumbSegments.length - 1 }"
              @click.stop="navigateTo(seg.path)"
              :title="seg.path"
            >
              {{ seg.name }}
            </button>
            <!-- 段落后的斜杠按钮 -->
            <button
              type="button"
              class="slash-btn flex items-center justify-center h-5 w-4 rounded text-text-secondary/60 hover:text-primary hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-150 flex-shrink-0 font-mono text-xs select-none"
              @click.stop="toggleDirDropdown(seg.path, $event)"
              :class="{ 'text-primary bg-primary/15 font-semibold': activeDropdownDir === seg.path }"
              title="展开目录子项"
            >
              /
            </button>
          </template>
        </template>
      </div>

      <!-- 右侧强制常驻空白点击区域（超出宽度时仍保留至少 36px 空间用于切换输入模式） -->
      <div
        class="flex-grow flex-shrink-0 min-w-[36px] h-full cursor-text hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-100 rounded-sm"
        title="点击直接输入路径"
      ></div>
    </div>

    <!-- 文本输入编辑态（Windows 点击变输入框模式） -->
    <div
      v-else
      class="relative flex items-center flex-grow min-w-0 h-full"
    >
      <input
        ref="pathInputRef"
        type="text"
        v-model="editablePath"
        @keydown="handlePathInputKeydown"
        @input="handlePathInputChange"
        @blur="handlePathInputBlur"
        class="w-full h-6 px-1.5 py-0.5 bg-background border border-primary/50 rounded text-foreground font-mono text-xs outline-none focus:ring-1 focus:ring-primary"
        placeholder="/path/to/directory"
      />
      <!-- 历史路径下拉 -->
      <PathHistoryDropdown
        v-if="showPathHistoryDropdown"
        ref="pathHistoryDropdownRef"
        @pathSelected="handlePathSelectedFromHistory"
        @closeDropdown="showPathHistoryDropdown = false"
        class="left-0 right-0 top-full mt-1"
      />
    </div>

    <!-- 右侧工具操作集合（复制路径、收藏夹星标、刷新） -->
    <div class="flex items-center gap-1 ml-2 flex-shrink-0 text-text-secondary">
      <!-- 复制当前路径按钮 -->
      <button
        type="button"
        class="flex items-center justify-center w-6 h-6 rounded hover:bg-black/10 dark:hover:bg-white/10 hover:text-foreground transition-colors duration-150"
        @click="copyCurrentPath"
        :title="copySuccess ? '已复制到剪贴板！' : '复制当前路径'"
      >
        <i v-if="!copySuccess" class="far fa-copy text-[11px]"></i>
        <i v-else class="fas fa-check text-[11px] text-green-500"></i>
      </button>

      <!-- 常用路径收藏夹按钮 -->
      <div class="relative flex-shrink-0">
        <button
          ref="favoritePathsButtonRef"
          type="button"
          class="flex items-center justify-center w-6 h-6 rounded hover:bg-black/10 dark:hover:bg-white/10 hover:text-yellow-500 transition-colors duration-150"
          @click.stop="showFavoritePathsModal = !showFavoritePathsModal"
          :title="t('fileManager.favoritePathsTooltip', '常用路径收藏夹')"
        >
          <i class="fas fa-star text-[11px]"></i>
        </button>
        <FavoritePathsModal
          :is-visible="showFavoritePathsModal"
          :trigger-element="favoritePathsButtonRef"
          @close="showFavoritePathsModal = false"
          @navigate-to-path="(p: string) => { emit('navigate-to-path', p); showFavoritePathsModal = false; }"
        />
      </div>

      <!-- 快速刷新当前目录 -->
      <button
        type="button"
        class="flex items-center justify-center w-6 h-6 rounded hover:bg-black/10 dark:hover:bg-white/10 hover:text-foreground transition-colors duration-150"
        @click.stop="emit('refresh')"
        :disabled="!isConnected || isLoading"
        :title="t('fileManager.actions.refresh', '刷新目录')"
      >
        <i class="fas fa-sync-alt text-[10px]" :class="{ 'fa-spin': isLoading }"></i>
      </button>
    </div>

    <!-- 斜杠级联下拉菜单浮层 Popover -->
    <div
      v-if="activeDropdownDir"
      ref="dropdownPopoverRef"
      class="absolute z-50 min-w-[200px] max-w-[280px] bg-header border border-border/80 rounded-lg shadow-2xl p-1 text-xs backdrop-blur-md animate-in fade-in zoom-in-95 duration-100"
      :style="{
        top: `${dropdownPosition.top}px`,
        left: `${dropdownPosition.left}px`,
      }"
      @click.stop
    >
      <!-- 下拉头部搜索过滤框 -->
      <div class="relative mb-1 px-1">
        <input
          v-model="dropdownFilter"
          type="text"
          placeholder="筛选当前目录项..."
          class="w-full px-2 py-1 pl-6 bg-background border border-border/60 rounded text-[11px] text-foreground outline-none focus:border-primary"
          @keydown.esc="closeDirDropdown"
          autofocus
        />
        <i class="fas fa-search absolute left-2.5 top-1/2 -translate-y-1/2 text-[10px] text-text-secondary pointer-events-none"></i>
      </div>

      <!-- 目录内容列表 -->
      <div class="max-h-56 overflow-y-auto space-y-0.5 no-scrollbar">
        <!-- 加载中动画 -->
        <div v-if="isLoadingDropdown" class="flex items-center justify-center py-4 text-text-secondary gap-2">
          <i class="fas fa-circle-notch fa-spin text-primary"></i>
          <span>正在获取清单...</span>
        </div>

        <!-- 空目录提示 -->
        <div v-else-if="filteredDropdownItems.length === 0" class="py-3 text-center text-text-secondary">
          <span v-if="dropdownFilter">未找到匹配项</span>
          <span v-else>目录为空</span>
        </div>

        <!-- 项目列表项 -->
        <div
          v-else
          v-for="item in filteredDropdownItems"
          :key="item.filename"
          @click="handleDropdownItemClick(item)"
          class="flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-100"
          :class="item.attrs.isDirectory ? 'font-medium text-foreground' : 'text-text-secondary'"
        >
          <i
            :class="item.attrs.isDirectory ? 'fas fa-folder text-yellow-500' : 'far fa-file-alt text-text-secondary'"
            class="text-xs flex-shrink-0"
          ></i>
          <span class="truncate flex-grow">{{ item.filename }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
