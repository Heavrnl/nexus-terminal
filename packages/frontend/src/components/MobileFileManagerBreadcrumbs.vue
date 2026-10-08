<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FileListItem } from '../types/sftp.types';
import type { SftpManagerInstance } from '../composables/useSftpActions';
import MobilePathHistoryDrawer from './MobilePathHistoryDrawer.vue';
import FavoritePathsModal from './FavoritePathsModal.vue';
import { usePathHistoryStore } from '../stores/pathHistory.store';
import { copyToClipboard } from '../utils/clipboard';

const props = defineProps<{
  currentPath: string;
  isConnected: boolean;
  isLoading: boolean;
  sftpManager: SftpManagerInstance | null;
}>();

const emit = defineEmits<{
  (e: 'navigate-to-path', path: string): void;
  (e: 'open-file', fileItem: FileListItem, fullPath?: string): void;
  (e: 'refresh'): void;
}>();

const { t } = useI18n();
const pathHistoryStore = usePathHistoryStore();

// --- 移动端历史抽屉与常用路径弹窗 ---
const showMobilePathHistoryDrawer = ref(false);
const showFavoritePathsModal = ref(false);
const favoritePathsButtonRef = ref<HTMLButtonElement | null>(null);

// --- 复制成功反馈 ---
const copySuccess = ref(false);

// --- 斜杠下拉级联菜单 ---
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

watch(() => props.currentPath, () => {
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

// --- 路径跳转 ---
const navigateTo = (targetPath: string) => {
  if (props.isLoading || !props.isConnected) return;
  const trimmed = targetPath.trim() || '/';
  closeDirDropdown();
  if (trimmed !== props.currentPath) {
    emit('navigate-to-path', trimmed);
    pathHistoryStore.addPath(trimmed);
  }
};

// --- 返回上一级 ---
const parentPath = computed<string | null>(() => {
  const raw = (props.currentPath || '').trim();
  if (!raw || raw === '/') return null;
  const normalized = raw.replace(/\/+$/, '');
  if (!normalized || normalized === '') return null;
  const lastSlashIndex = normalized.lastIndexOf('/');
  if (lastSlashIndex <= 0) {
    return '/';
  }
  return normalized.substring(0, lastSlashIndex);
});

const canGoUp = computed(() => {
  return Boolean(props.isConnected && !props.isLoading && parentPath.value !== null);
});

const handleGoUp = () => {
  if (!canGoUp.value || !parentPath.value) return;
  navigateTo(parentPath.value);
};

// --- 打开移动端路径抽屉 ---
const openHistoryDrawer = () => {
  if (props.isLoading || !props.isConnected) return;
  closeDirDropdown();
  showMobilePathHistoryDrawer.value = true;
  if (pathHistoryStore.historyList.length === 0) {
    pathHistoryStore.fetchHistory();
  }
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

  const targetEl = event.currentTarget as HTMLElement;
  const rect = targetEl.getBoundingClientRect();
  const parentContainer = targetEl.closest('.mobile-breadcrumbs-container');
  const parentRect = parentContainer?.getBoundingClientRect() || { top: 0, left: 0 };

  dropdownPosition.value = {
    top: rect.bottom - parentRect.top + 4,
    left: Math.max(0, rect.left - parentRect.left),
  };

  try {
    const items = await props.sftpManager.listDirectoryContents(dirPath);
    dropdownItems.value = items;
  } catch (err) {
    console.warn(`[MobileBreadcrumbs] 加载目录 ${dirPath} 清单失败:`, err);
    dropdownItems.value = [];
  } finally {
    isLoadingDropdown.value = false;
  }
};

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

const copyCurrentPath = async (e: MouseEvent) => {
  e.stopPropagation();
  const success = await copyToClipboard(props.currentPath || '/');
  if (success) {
    copySuccess.value = true;
    setTimeout(() => {
      copySuccess.value = false;
    }, 1500);
  }
};

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
  openHistoryDrawer,
});
</script>

<template>
  <div class="mobile-breadcrumbs-container relative flex items-center h-10 px-2.5 bg-header/90 border-b border-border/70 text-xs select-none transition-colors duration-150 flex-shrink-0">
    <!-- 最左侧：大触控返回上一级目录按钮 -->
    <button
      type="button"
      class="flex items-center justify-center w-7.5 h-7.5 mr-1 rounded-lg text-text-secondary hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10 active:scale-95 transition-all duration-150 disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-transparent flex-shrink-0"
      @click.stop="handleGoUp"
      :disabled="!canGoUp"
      :title="canGoUp ? t('fileManager.actions.parentDirectory', '上一级') : t('fileManager.actions.alreadyRoot', '已是根目录')"
      aria-label="上一级目录"
    >
      <i class="fas fa-arrow-up text-xs"></i>
    </button>

    <!-- 移动端面包屑显示态 (点击空白唤起底部历史路径与跳转抽屉) -->
    <div
      class="flex items-center flex-grow min-w-0 h-full overflow-hidden"
      @click="openHistoryDrawer"
    >
      <div
        ref="breadcrumbStreamRef"
        class="flex items-center flex-shrink min-w-0 max-w-[calc(100%-36px)] overflow-x-auto no-scrollbar py-0.5"
      >
        <template v-for="(seg, idx) in breadcrumbSegments" :key="seg.path">
          <!-- 根目录图标按钮 -->
          <template v-if="seg.isRoot">
            <button
              type="button"
              class="flex items-center justify-center w-7 h-7 rounded text-text-secondary hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10 active:scale-95 transition-colors duration-150 flex-shrink-0"
              :class="{ 'text-foreground bg-black/5 dark:bg-white/5': breadcrumbSegments.length === 1 }"
              @click.stop="navigateTo('/')"
              :title="t('fileManager.actions.rootDirectory', '根目录')"
            >
              <i class="fas fa-hdd text-xs text-primary/80"></i>
            </button>
            <button
              v-if="breadcrumbSegments.length > 1"
              type="button"
              class="slash-btn flex items-center justify-center h-6 w-4.5 rounded text-text-secondary/60 hover:text-primary hover:bg-black/10 dark:hover:bg-white/10 active:scale-95 transition-colors duration-150 flex-shrink-0 font-mono text-xs select-none"
              :class="{ 'text-primary bg-primary/15 font-semibold': activeDropdownDir === '/' }"
              @click.stop="toggleDirDropdown('/', $event)"
              title="展开目录子项"
            >
              /
            </button>
          </template>

          <!-- 普通路径段落 -->
          <template v-else>
            <button
              type="button"
              class="flex items-center h-7 px-2 rounded text-text-secondary hover:text-foreground hover:bg-black/10 dark:hover:bg-white/10 active:scale-95 transition-colors duration-150 font-medium truncate max-w-[140px] flex-shrink-0 text-xs"
              :class="{ 'text-foreground font-semibold bg-black/5 dark:bg-white/5': idx === breadcrumbSegments.length - 1 }"
              @click.stop="navigateTo(seg.path)"
              :title="seg.path"
            >
              {{ seg.name }}
            </button>
            <button
              type="button"
              class="slash-btn flex items-center justify-center h-6 w-4.5 rounded text-text-secondary/60 hover:text-primary hover:bg-black/10 dark:hover:bg-white/10 active:scale-95 transition-colors duration-150 flex-shrink-0 font-mono text-xs select-none"
              :class="{ 'text-primary bg-primary/15 font-semibold': activeDropdownDir === seg.path }"
              @click.stop="toggleDirDropdown(seg.path, $event)"
              title="展开目录子项"
            >
              /
            </button>
          </template>
        </template>
      </div>

      <!-- 右侧空白触控热区，点击唤起底部抽屉 -->
      <div
        class="flex-grow flex-shrink-0 min-w-[36px] h-full cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-100 rounded-sm"
        title="点击打开路径历史与快速跳转"
      ></div>
    </div>

    <!-- 右侧操作栏 (复制路径、常用路径、刷新) -->
    <div class="flex items-center gap-1.5 ml-2 flex-shrink-0 text-text-secondary">
      <button
        type="button"
        class="flex items-center justify-center w-7.5 h-7.5 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 hover:text-foreground active:scale-95 transition-all duration-150"
        @click="copyCurrentPath"
        :title="copySuccess ? '已复制到剪贴板！' : '复制当前路径'"
      >
        <i v-if="!copySuccess" class="far fa-copy text-xs"></i>
        <i v-else class="fas fa-check text-xs text-emerald-500"></i>
      </button>

      <div class="relative flex-shrink-0">
        <button
          ref="favoritePathsButtonRef"
          type="button"
          class="flex items-center justify-center w-7.5 h-7.5 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 hover:text-amber-400 active:scale-95 transition-all duration-150"
          @click.stop="showFavoritePathsModal = !showFavoritePathsModal"
          :title="t('fileManager.favoritePathsTooltip', '常用路径收藏夹')"
        >
          <i class="fas fa-star text-xs text-amber-400/90"></i>
        </button>
        <FavoritePathsModal
          :is-visible="showFavoritePathsModal"
          :trigger-element="favoritePathsButtonRef"
          :is-mobile="true"
          @close="showFavoritePathsModal = false"
          @navigate-to-path="(p: string) => { emit('navigate-to-path', p); showFavoritePathsModal = false; }"
        />
      </div>

      <button
        type="button"
        class="flex items-center justify-center w-7.5 h-7.5 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 hover:text-foreground active:scale-95 transition-all duration-150"
        @click.stop="emit('refresh')"
        :disabled="!isConnected || isLoading"
        :title="t('fileManager.actions.refresh', '刷新目录')"
      >
        <i class="fas fa-sync-alt text-xs" :class="{ 'fa-spin': isLoading }"></i>
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

      <div class="max-h-56 overflow-y-auto space-y-0.5 no-scrollbar">
        <div v-if="isLoadingDropdown" class="flex items-center justify-center py-4 text-text-secondary gap-2">
          <i class="fas fa-circle-notch fa-spin text-primary"></i>
          <span>正在获取清单...</span>
        </div>

        <div v-else-if="filteredDropdownItems.length === 0" class="py-3 text-center text-text-secondary">
          <span v-if="dropdownFilter">未找到匹配项</span>
          <span v-else>目录为空</span>
        </div>

        <div
          v-else
          v-for="item in filteredDropdownItems"
          :key="item.filename"
          @click="handleDropdownItemClick(item)"
          class="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-black/10 dark:hover:bg-white/10 active:bg-primary/20 transition-colors duration-100"
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

    <!-- 移动端历史路径与跳转底部抽屉 -->
    <MobilePathHistoryDrawer
      :is-visible="showMobilePathHistoryDrawer"
      :current-path="currentPath"
      @close="showMobilePathHistoryDrawer = false"
      @navigate-to-path="(p: string) => { navigateTo(p); showMobilePathHistoryDrawer = false; }"
    />
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
