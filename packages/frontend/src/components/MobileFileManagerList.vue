<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FileListItem } from '../types/sftp.types';
import { getFileIconClass } from '../utils/fileIcons';
import { formatFileSize, formatFileMode, formatFileDate } from '../utils/fileFormatters';

const props = defineProps<{
  items: FileListItem[];
  isLoading: boolean;
  hasParentLink: boolean;
  currentPath: string;
  searchQuery: string;
  selectedItems: Set<string>;
  isMultiSelectMode: boolean;
  isConnected: boolean;
  hasClipboardContent?: boolean;
}>();

const emit = defineEmits<{
  (e: 'open-parent'): void;
  (e: 'item-click', item: FileListItem): void;
  (e: 'toggle-select', item: FileListItem): void;
  (e: 'open-action-sheet', item: FileListItem): void;
  (e: 'select-all'): void;
  (e: 'deselect-all'): void;
  (e: 'batch-download'): void;
  (e: 'batch-copy'): void;
  (e: 'batch-cut'): void;
  (e: 'batch-paste'): void;
  (e: 'batch-delete'): void;
  (e: 'exit-multi-select'): void;
}>();

const { t } = useI18n();

// 容器引用与滚动状态
const containerRef = ref<HTMLDivElement | null>(null);
const scrollTop = ref(0);
const containerHeight = ref(500);

// 单行卡片基准高度 (px)
const CARD_HEIGHT = 58;
const BUFFER_SIZE = 8;

const updateContainerDimensions = () => {
  if (containerRef.value) {
    containerHeight.value = containerRef.value.clientHeight || 500;
  }
};

const handleScroll = (event: Event) => {
  const target = event.target as HTMLElement;
  if (target) {
    scrollTop.value = target.scrollTop;
  }
};

let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  updateContainerDimensions();
  if (containerRef.value) {
    resizeObserver = new ResizeObserver(() => {
      updateContainerDimensions();
    });
    resizeObserver.observe(containerRef.value);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});

// 计算虚拟滚动切片
const totalItemsCount = computed(() => props.items.length);
const shouldUseVirtualScroll = computed(() => totalItemsCount.value > 50);

const virtualRange = computed(() => {
  if (!shouldUseVirtualScroll.value) {
    return {
      start: 0,
      end: totalItemsCount.value,
      topPadding: 0,
      bottomPadding: 0,
      visibleList: props.items.map((item, index) => ({ item, index })),
    };
  }

  const effectiveScrollTop = Math.max(0, scrollTop.value);
  const rawStart = Math.floor(effectiveScrollTop / CARD_HEIGHT) - BUFFER_SIZE;
  const start = Math.max(0, rawStart);
  const visibleCount = Math.ceil(containerHeight.value / CARD_HEIGHT);
  const rawEnd = Math.floor(effectiveScrollTop / CARD_HEIGHT) + visibleCount + BUFFER_SIZE;
  const end = Math.min(totalItemsCount.value, rawEnd);

  const topPadding = start * CARD_HEIGHT;
  const bottomPadding = Math.max(0, (totalItemsCount.value - end) * CARD_HEIGHT);

  const visibleList: Array<{ item: FileListItem; index: number }> = [];
  for (let i = start; i < end; i++) {
    if (props.items[i]) {
      visibleList.push({ item: props.items[i], index: i });
    }
  }

  return { start, end, topPadding, bottomPadding, visibleList };
});

// --- 触屏长按判定逻辑 (350ms) ---
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let touchStartX = 0;
let touchStartY = 0;
let isLongPressTriggered = false;

const handleTouchStart = (item: FileListItem, event: TouchEvent) => {
  if (props.isMultiSelectMode) return;
  const touch = event.touches[0];
  touchStartX = touch.clientX;
  touchStartY = touch.clientY;
  isLongPressTriggered = false;

  if (longPressTimer) clearTimeout(longPressTimer);
  longPressTimer = setTimeout(() => {
    isLongPressTriggered = true;
    if (navigator.vibrate) {
      navigator.vibrate(40);
    }
    emit('open-action-sheet', item);
  }, 350);
};

const handleTouchMove = (event: TouchEvent) => {
  if (!longPressTimer) return;
  const touch = event.touches[0];
  const deltaX = Math.abs(touch.clientX - touchStartX);
  const deltaY = Math.abs(touch.clientY - touchStartY);
  // 滑动超过 10px 视为滚动列表，取消长按
  if (deltaX > 10 || deltaY > 10) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
};

const handleTouchEnd = () => {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
};

// 点击条目
const handleRowClick = (item: FileListItem) => {
  if (isLongPressTriggered) {
    isLongPressTriggered = false;
    return;
  }

  if (props.isMultiSelectMode) {
    emit('toggle-select', item);
    return;
  }

  emit('item-click', item);
};

// 点击更多按钮 (三点菜单)
const handleMoreClick = (item: FileListItem, event: MouseEvent) => {
  event.stopPropagation();
  emit('open-action-sheet', item);
};

// 是否全选状态
const isAllSelected = computed(() => {
  if (props.items.length === 0) return false;
  return props.items.every(item => props.selectedItems.has(item.filename));
});

const handleToggleSelectAll = () => {
  if (isAllSelected.value) {
    emit('deselect-all');
  } else {
    emit('select-all');
  }
};
</script>

<template>
  <div class="relative flex flex-col h-full min-h-0 bg-background select-none overflow-hidden">
    <!-- 移动端文件卡片滚动列表容器 -->
    <div
      ref="containerRef"
      class="flex-grow min-h-0 overflow-y-auto overscroll-contain px-2.5 py-2 space-y-1.5 [scrollbar-width:thin] pb-24"
      @scroll="handleScroll"
    >
      <!-- 加载中骨架遮罩 -->
      <div v-if="isLoading && items.length === 0" class="py-12 flex flex-col items-center justify-center gap-3 text-text-secondary">
        <i class="fas fa-spinner fa-spin text-2xl text-primary"></i>
        <span class="text-xs">{{ t('fileManager.loading', '正在加载文件列表...') }}</span>
      </div>

      <!-- 常驻置顶：返回上一级目录卡片 -->
      <div
        v-if="hasParentLink"
        class="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl bg-header/40 hover:bg-header/80 active:bg-primary/10 border border-border/40 transition-colors cursor-pointer"
        @click="emit('open-parent')"
      >
        <div class="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
          <i class="fas fa-level-up-alt text-primary text-base"></i>
        </div>
        <div class="min-w-0 flex-1">
          <div class="text-sm font-medium text-foreground tracking-tight">
            {{ t('fileManager.parentDirectory', '返回上一级') }}
          </div>
          <div class="text-[11px] text-text-secondary font-mono">..</div>
        </div>
        <div class="text-text-secondary/50 text-xs">
          <i class="fas fa-chevron-up"></i>
        </div>
      </div>

      <!-- 空目录或无搜索结果 -->
      <div
        v-if="!isLoading && items.length === 0"
        class="py-16 flex flex-col items-center justify-center gap-2.5 text-text-secondary"
      >
        <div class="w-14 h-14 rounded-2xl bg-header/40 border border-border/50 flex items-center justify-center text-text-secondary/60 text-2xl">
          <i :class="searchQuery ? 'fas fa-search-minus' : 'fas fa-folder-open'"></i>
        </div>
        <p class="text-xs font-medium text-foreground/80">
          {{ searchQuery ? t('fileManager.noSearchResults', '未找到匹配的文件或文件夹') : t('fileManager.emptyDirectory', '此目录为空') }}
        </p>
        <p v-if="searchQuery" class="text-[11px] text-text-secondary">
          当前搜索词: "{{ searchQuery }}"
        </p>
      </div>

      <!-- 虚拟滚动顶部垫片 -->
      <div v-if="virtualRange.topPadding > 0" :style="{ height: `${virtualRange.topPadding}px` }"></div>

      <!-- 文件与文件夹卡片流 -->
      <div
        v-for="({ item }) in virtualRange.visibleList"
        :key="item.filename"
        class="group w-full flex items-center gap-3 px-3 py-2 rounded-xl transition-all duration-150 cursor-pointer border"
        :class="[
          selectedItems.has(item.filename)
            ? 'bg-primary/15 border-primary/50 text-foreground shadow-2xs'
            : 'bg-header/20 hover:bg-header/50 active:bg-header/70 border-border/40 text-foreground'
        ]"
        @click="handleRowClick(item)"
        @touchstart="handleTouchStart(item, $event)"
        @touchmove="handleTouchMove($event)"
        @touchend="handleTouchEnd"
        @touchcancel="handleTouchEnd"
      >
        <!-- 多选模式下的复选框 -->
        <div
          v-if="isMultiSelectMode"
          class="shrink-0 flex items-center justify-center w-5 h-5"
          @click.stop="emit('toggle-select', item)"
        >
          <div
            class="w-4.5 h-4.5 rounded-full border flex items-center justify-center transition-colors"
            :class="selectedItems.has(item.filename) ? 'bg-primary border-primary text-white' : 'border-border bg-header/40'"
          >
            <i v-if="selectedItems.has(item.filename)" class="fas fa-check text-[10px]"></i>
          </div>
        </div>

        <!-- 文件/文件夹图标 -->
        <div class="w-9 h-9 rounded-lg bg-header/50 border border-border/40 flex items-center justify-center shrink-0">
          <i
            :class="[
              item.attrs.isDirectory ? 'fas fa-folder text-amber-400 text-lg' :
              item.attrs.isSymbolicLink ? 'fas fa-link text-cyan-400 text-base' :
              `${getFileIconClass(item.filename)} text-base`
            ]"
          ></i>
        </div>

        <!-- 中间信息：文件名与元数据 -->
        <div class="min-w-0 flex-1 flex flex-col justify-center">
          <div class="text-[13px] font-medium leading-tight truncate text-foreground tracking-tight">
            {{ item.filename }}
          </div>
          <div class="flex items-center gap-1.5 text-[10px] text-text-secondary mt-1 flex-wrap">
            <span v-if="item.attrs.isFile" class="font-mono text-text-secondary/90">
              {{ formatFileSize(item.attrs.size) }}
            </span>
            <span v-else class="text-primary font-medium">
              文件夹
            </span>
            <span class="text-text-secondary/40">•</span>
            <span class="font-mono text-text-secondary/80">
              {{ formatFileDate(item.attrs.mtime) }}
            </span>
            <span class="text-text-secondary/40">•</span>
            <span class="font-mono text-text-secondary/70">
              {{ formatFileMode(item.attrs.mode) }}
            </span>
          </div>
        </div>

        <!-- 右侧：更多操作按钮 -->
        <div class="flex items-center shrink-0">
          <button
            class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground active:bg-primary/20 hover:bg-header/80 transition-colors"
            :title="t('fileManager.moreActions', '操作菜单')"
            @click="handleMoreClick(item, $event)"
          >
            <i class="fas fa-ellipsis-v text-xs"></i>
          </button>
        </div>
      </div>

      <!-- 虚拟滚动底部垫片 -->
      <div v-if="virtualRange.bottomPadding > 0" :style="{ height: `${virtualRange.bottomPadding}px` }"></div>
    </div>

    <!-- 底部悬浮多选工具坞 (Floating Selection Dock) -->
    <Transition name="fade-slide">
      <div
        v-if="isMultiSelectMode || selectedItems.size > 0"
        class="absolute bottom-2.5 left-2.5 right-2.5 z-40 bg-background/95 backdrop-blur-md border border-border/80 shadow-2xl rounded-2xl p-2 flex items-center justify-between gap-1.5"
      >
        <!-- 左侧已选计数与全选 -->
        <div class="flex items-center gap-2 pl-1.5 shrink-0">
          <button
            class="text-xs text-primary font-semibold hover:underline flex items-center gap-1 py-1"
            @click="handleToggleSelectAll"
          >
            <i :class="isAllSelected ? 'fas fa-check-square' : 'far fa-square'"></i>
            <span>{{ isAllSelected ? '全不选' : '全选' }}</span>
          </button>
          <span class="text-[11px] text-text-secondary">
            已选 <strong class="text-foreground">{{ selectedItems.size }}</strong> 项
          </span>
        </div>

        <!-- 右侧动作按钮组 -->
        <div class="flex items-center gap-1">
          <!-- 复制 -->
          <button
            class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground active:bg-header border border-border/40"
            :disabled="selectedItems.size === 0"
            :class="{ 'opacity-40 cursor-not-allowed': selectedItems.size === 0 }"
            title="复制"
            @click="emit('batch-copy')"
          >
            <i class="fas fa-copy text-xs"></i>
          </button>

          <!-- 剪切 -->
          <button
            class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground active:bg-header border border-border/40"
            :disabled="selectedItems.size === 0"
            :class="{ 'opacity-40 cursor-not-allowed': selectedItems.size === 0 }"
            title="剪切"
            @click="emit('batch-cut')"
          >
            <i class="fas fa-cut text-xs"></i>
          </button>

          <!-- 粘贴 (若剪贴板有内容) -->
          <button
            v-if="hasClipboardContent"
            class="w-8 h-8 rounded-lg flex items-center justify-center text-primary hover:text-primary-hover active:bg-header border border-primary/40 bg-primary/10"
            title="粘贴到当前目录"
            @click="emit('batch-paste')"
          >
            <i class="fas fa-paste text-xs"></i>
          </button>

          <!-- 批量下载 -->
          <button
            class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground active:bg-header border border-border/40"
            :disabled="selectedItems.size === 0"
            :class="{ 'opacity-40 cursor-not-allowed': selectedItems.size === 0 }"
            title="下载选中项"
            @click="emit('batch-download')"
          >
            <i class="fas fa-download text-xs"></i>
          </button>

          <!-- 批量删除 -->
          <button
            class="w-8 h-8 rounded-lg flex items-center justify-center text-rose-500 hover:text-rose-600 active:bg-rose-500/20 border border-rose-500/30 bg-rose-500/10"
            :disabled="selectedItems.size === 0"
            :class="{ 'opacity-40 cursor-not-allowed': selectedItems.size === 0 }"
            title="删除选中项"
            @click="emit('batch-delete')"
          >
            <i class="fas fa-trash-alt text-xs"></i>
          </button>

          <!-- 关闭多选模式 -->
          <button
            class="w-8 h-8 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground active:bg-header ml-1"
            title="退出多选"
            @click="emit('exit-multi-select')"
          >
            <i class="fas fa-times text-xs"></i>
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.fade-slide-enter-from,
.fade-slide-leave-to {
  opacity: 0;
  transform: translateY(12px) scale(0.98);
}
</style>
