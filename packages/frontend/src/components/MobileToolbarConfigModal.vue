<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMobileToolbarConfig, type ToolbarItemDefinition } from '../composables/useMobileToolbarConfig';

const props = defineProps<{
  isVisible: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const { t } = useI18n();
const {
  activeItemIds,
  activeItems,
  warehouseItems,
  addToActive,
  removeFromActive,
  moveActiveItem,
  resetToDefault,
} = useMobileToolbarConfig();

// ==================== 拖拽与长按状态管理 ====================
const touchDraggedItemId = ref<string | null>(null);
const touchDraggedIndex = ref<number | null>(null);
const isLongPressActive = ref(false);

let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let startTouchX = 0;
let startTouchY = 0;

// 1. 触控按下：启动长按判定 (240ms)
const handleCardTouchStart = (e: TouchEvent, item: ToolbarItemDefinition, index: number) => {
  const touch = e.touches[0];
  if (!touch) return;

  startTouchX = touch.clientX;
  startTouchY = touch.clientY;
  touchDraggedItemId.value = item.id;
  touchDraggedIndex.value = index;

  if (longPressTimer) clearTimeout(longPressTimer);

  longPressTimer = setTimeout(() => {
    isLongPressActive.value = true;
    // 触发触觉反馈
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(30);
    }
  }, 240);
};

// 2. 触控滑动：判断是否长按拖拽中
const handleCardTouchMove = (e: TouchEvent) => {
  const touch = e.touches[0];
  if (!touch) return;

  // 若尚未触发长按，发生较大位移则视为正常滚动页面，取消长按
  if (!isLongPressActive.value) {
    const diffX = Math.abs(touch.clientX - startTouchX);
    const diffY = Math.abs(touch.clientY - startTouchY);
    if (diffX > 10 || diffY > 10) {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      touchDraggedItemId.value = null;
      touchDraggedIndex.value = null;
    }
    return;
  }

  // 长按已激活：阻止页面滚动，执行实时位置探测与交换排序
  e.preventDefault();

  const element = document.elementFromPoint(touch.clientX, touch.clientY);
  if (!element) return;

  // 向上查找带 data-active-index 的目标卡片
  const targetCard = element.closest('[data-active-index]') as HTMLElement | null;
  if (targetCard && targetCard.dataset.activeIndex !== undefined) {
    const targetIdx = parseInt(targetCard.dataset.activeIndex, 10);
    if (!isNaN(targetIdx) && touchDraggedIndex.value !== null && targetIdx !== touchDraggedIndex.value) {
      const fromIdx = touchDraggedIndex.value;
      moveActiveItem(fromIdx, targetIdx);
      touchDraggedIndex.value = targetIdx;
      // 轻微震动提示换位成功
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(15);
      }
    }
  }
};

// 3. 触控结束/取消：清除定时器并复位
const handleCardTouchEnd = () => {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  isLongPressActive.value = false;
  touchDraggedItemId.value = null;
  touchDraggedIndex.value = null;
};

// ==================== HTML5 桌面拖拽兜底 ====================
const html5DraggedItemId = ref<string | null>(null);
const html5DragOverIndex = ref<number | null>(null);

const handleHtml5DragStart = (item: ToolbarItemDefinition, index: number) => {
  html5DraggedItemId.value = item.id;
};

const handleHtml5DragOverSlot = (index: number) => {
  html5DragOverIndex.value = index;
};

const handleHtml5Drop = (targetIndex: number) => {
  if (!html5DraggedItemId.value) return;
  const fromIndex = activeItemIds.value.indexOf(html5DraggedItemId.value);
  if (fromIndex !== -1 && fromIndex !== targetIndex) {
    moveActiveItem(fromIndex, targetIndex);
  }
  html5DraggedItemId.value = null;
  html5DragOverIndex.value = null;
};

const handleHtml5DragEnd = () => {
  html5DraggedItemId.value = null;
  html5DragOverIndex.value = null;
};

const handleClose = () => {
  handleCardTouchEnd();
  emit('close');
};
</script>

<template>
  <Teleport to="body">
    <Transition name="bottom-sheet">
      <div
        v-if="isVisible"
        class="fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-xs select-none"
        @click.self="handleClose"
      >
        <div
          class="mobile-toolbar-sheet w-full h-[85vh] max-h-[90vh] bg-background border-t border-border/80 rounded-t-2xl shadow-2xl flex flex-col overflow-hidden"
        >
          <!-- 顶部拖拽手柄指示条 -->
          <div
            class="sheet-handle-zone pt-2.5 pb-1 flex flex-col items-center justify-center cursor-pointer active:opacity-60 transition-opacity"
            @click="handleClose"
            title="点击收起"
          >
            <div class="w-10 h-1.5 bg-border/80 rounded-full hover:bg-text-secondary/40 transition-colors"></div>
          </div>

          <!-- 顶栏标题与快捷操作 -->
          <div class="sheet-header flex items-center justify-between px-4 py-2.5 border-b border-border/50 shrink-0">
            <div class="flex items-center gap-2">
              <div class="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                <i class="fas fa-sliders-h text-sm"></i>
              </div>
              <div>
                <h3 class="text-sm font-semibold text-foreground tracking-tight">
                  {{ t('mobileToolbar.title', '自定义工具栏') }}
                </h3>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <!-- 恢复默认 -->
              <button
                type="button"
                @click="resetToDefault"
                class="px-2.5 py-1 text-xs font-medium text-text-secondary hover:text-foreground bg-header/60 hover:bg-border/40 border border-border/60 rounded-lg active:scale-95 transition-all"
                :title="t('common.resetDefault', '恢复默认')"
              >
                <i class="fas fa-undo text-[10px] mr-1"></i>
                <span>{{ t('common.reset', '重置') }}</span>
              </button>

              <!-- 完成按钮 -->
              <button
                type="button"
                @click="handleClose"
                class="px-3 py-1 text-xs font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95 transition-all shadow-xs"
              >
                {{ t('common.done', '完成') }}
              </button>
            </div>
          </div>

          <!-- 帮助提示胶囊条 -->
          <div class="px-4 py-2 bg-header/30 border-b border-border/30 flex items-center gap-2 text-[11px] text-text-secondary shrink-0">
            <i class="fas fa-hand-pointer text-primary text-xs shrink-0"></i>
            <span>{{ t('mobileToolbar.tip', '长按上方卡片可拖拽调序，点击右上角 +/- 快速增删') }}</span>
          </div>

          <!-- 可滚动内容区：分上下两层 -->
          <div
            class="sheet-body flex-grow overflow-y-auto px-4 py-3 space-y-5 overscroll-contain"
            :class="{ 'touch-none overflow-hidden': isLongPressActive }"
          >
            <!-- 上层区域：当前工具栏 (已启用并显示的按钮) -->
            <section class="space-y-2.5">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-1.5">
                  <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
                  <h4 class="text-xs font-semibold text-foreground uppercase tracking-wider">
                    {{ t('mobileToolbar.activeAreaTitle', '当前工具栏显示区 (长按拖拽排序)') }}
                  </h4>
                  <span class="text-[10px] px-1.5 py-0.2 rounded-full bg-emerald-500/10 text-emerald-400 font-mono font-medium">
                    {{ activeItems.length }}
                  </span>
                </div>
                <span class="text-[11px] text-text-secondary/70">
                  {{ isLongPressActive ? '拖动卡片交换位置' : '横向按序展示' }}
                </span>
              </div>

              <!-- 当前工具栏卡片网格 -->
              <div
                class="grid grid-cols-3 sm:grid-cols-4 gap-2.5 min-h-[96px] p-2 rounded-xl bg-header/20 border border-border/40 relative"
                @dragover.prevent
              >
                <div
                  v-for="(item, idx) in activeItems"
                  :key="item.id"
                  :data-active-index="idx"
                  draggable="true"
                  @touchstart="handleCardTouchStart($event, item, idx)"
                  @touchmove="handleCardTouchMove($event)"
                  @touchend="handleCardTouchEnd"
                  @touchcancel="handleCardTouchEnd"
                  @dragstart="handleHtml5DragStart(item, idx)"
                  @dragover.prevent="handleHtml5DragOverSlot(idx)"
                  @drop="handleHtml5Drop(idx)"
                  @dragend="handleHtml5DragEnd"
                  class="relative flex flex-col items-center justify-center p-3 rounded-xl bg-background border border-border/60 hover:border-primary/50 shadow-xs transition-transform duration-150 select-none cursor-grab active:cursor-grabbing"
                  :class="{
                    'scale-105 shadow-2xl ring-2 ring-primary border-primary z-20 bg-background/95 opacity-90': touchDraggedItemId === item.id && isLongPressActive,
                    'ring-2 ring-primary/60 border-primary': html5DragOverIndex === idx && html5DraggedItemId !== item.id,
                    'opacity-40': html5DraggedItemId === item.id
                  }"
                >
                  <!-- 移除按钮（右上角红色减号） -->
                  <button
                    type="button"
                    @click.stop="removeFromActive(item.id)"
                    class="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white flex items-center justify-center text-[10px] shadow-sm hover:scale-110 active:scale-90 transition-transform cursor-pointer z-10"
                    :title="t('common.remove', '移除至仓库')"
                  >
                    <i class="fas fa-minus"></i>
                  </button>

                  <!-- 按钮图标与名称 (垂直居中大视觉) -->
                  <div class="flex flex-col items-center justify-center py-0.5 gap-1.5 w-full text-center pointer-events-none">
                    <div class="w-9 h-9 rounded-xl bg-header/60 text-primary flex items-center justify-center">
                      <i :class="item.icon" class="text-base"></i>
                    </div>
                    <span class="text-xs font-medium text-foreground tracking-tight truncate w-full px-1">
                      {{ item.name }}
                    </span>
                  </div>

                  <!-- 长按拖拽手柄微指示点 -->
                  <div class="w-5 h-1 bg-border/60 rounded-full mt-1 opacity-60 pointer-events-none"></div>
                </div>

                <!-- 空状态 -->
                <div
                  v-if="activeItems.length === 0"
                  class="col-span-full flex flex-col items-center justify-center py-6 text-center text-text-secondary/70 border border-dashed border-border/50 rounded-lg bg-header/10"
                >
                  <i class="fas fa-inbox text-lg mb-1 text-text-secondary/40"></i>
                  <span class="text-xs">{{ t('mobileToolbar.activeEmpty', '工具栏暂无按钮，请从下方仓库添加') }}</span>
                </div>
              </div>
            </section>

            <!-- 中间分隔带 -->
            <div class="relative flex py-1 items-center">
              <div class="flex-grow border-t border-dashed border-border/60"></div>
              <span class="flex-shrink mx-3 px-2.5 py-0.5 rounded-full text-[10px] font-medium bg-header border border-border/40 text-text-secondary flex items-center gap-1">
                <i class="fas fa-boxes-stacked text-[9px]"></i>
                {{ t('mobileToolbar.divider', '功能备选仓库') }}
              </span>
              <div class="flex-grow border-t border-dashed border-border/60"></div>
            </div>

            <!-- 下层区域：功能备选仓库 (未启用按钮) -->
            <section class="space-y-2.5">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-1.5">
                  <span class="w-2 h-2 rounded-full bg-blue-500"></span>
                  <h4 class="text-xs font-semibold text-foreground uppercase tracking-wider">
                    {{ t('mobileToolbar.warehouseAreaTitle', '备选功能库 (点击添加)') }}
                  </h4>
                  <span class="text-[10px] px-1.5 py-0.2 rounded-full bg-blue-500/10 text-blue-400 font-mono font-medium">
                    {{ warehouseItems.length }}
                  </span>
                </div>
                <span class="text-[11px] text-text-secondary/70">
                  {{ t('mobileToolbar.warehouseAreaHint', '点击卡片直接加入') }}
                </span>
              </div>

              <!-- 仓库卡片网格 -->
              <div class="grid grid-cols-3 sm:grid-cols-4 gap-2.5 min-h-[96px] p-2 rounded-xl bg-header/20 border border-border/40">
                <div
                  v-for="item in warehouseItems"
                  :key="item.id"
                  @click="addToActive(item.id)"
                  class="relative flex flex-col items-center justify-center p-2.5 rounded-xl bg-background/80 hover:bg-background border border-border/50 hover:border-primary/50 shadow-xs transition-all select-none cursor-pointer active:scale-95 group"
                >
                  <!-- 添加按钮（右上角绿色加号） -->
                  <button
                    type="button"
                    @click.stop="addToActive(item.id)"
                    class="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px] shadow-sm hover:scale-110 active:scale-90 transition-transform cursor-pointer z-10"
                    :title="t('common.add', '添加至工具栏')"
                  >
                    <i class="fas fa-plus"></i>
                  </button>

                  <div class="w-9 h-9 rounded-xl bg-header/40 text-text-secondary group-hover:text-primary flex items-center justify-center transition-colors">
                    <i :class="item.icon" class="text-base"></i>
                  </div>
                  <span class="text-xs font-medium text-foreground tracking-tight truncate w-full text-center px-1 mt-1">
                    {{ item.name }}
                  </span>
                  <span class="text-[9px] text-text-secondary/60 truncate w-full text-center mt-0.5">
                    {{ item.description }}
                  </span>
                </div>

                <!-- 仓库空状态 -->
                <div
                  v-if="warehouseItems.length === 0"
                  class="col-span-full flex flex-col items-center justify-center py-6 text-center text-text-secondary/70 border border-dashed border-border/50 rounded-lg bg-header/10"
                >
                  <i class="fas fa-check-circle text-lg mb-1 text-emerald-400"></i>
                  <span class="text-xs">{{ t('mobileToolbar.warehouseEmpty', '所有功能已全部添加至工具栏') }}</span>
                </div>
              </div>
            </section>

            <!-- 底部全面屏安全区留白 -->
            <div class="sheet-safe-bottom"></div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 遮罩淡入淡出 */
.bottom-sheet-enter-active,
.bottom-sheet-leave-active {
  transition: opacity 0.22s ease;
}

.bottom-sheet-enter-from,
.bottom-sheet-leave-to {
  opacity: 0;
}

/* 抽屉平滑滑入滑出 */
.bottom-sheet-enter-active .mobile-toolbar-sheet {
  transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
}

.bottom-sheet-leave-active .mobile-toolbar-sheet {
  transition: transform 0.2s cubic-bezier(0.4, 0, 1, 1);
}

.bottom-sheet-enter-from .mobile-toolbar-sheet,
.bottom-sheet-leave-to .mobile-toolbar-sheet {
  transform: translateY(100%);
}

.sheet-safe-bottom {
  padding-bottom: max(env(safe-area-inset-bottom, 0px), 16px);
}
</style>
