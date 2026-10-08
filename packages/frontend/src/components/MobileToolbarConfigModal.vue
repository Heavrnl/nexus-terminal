<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMobileToolbarConfig, type ToolbarItemDefinition } from '../composables/useMobileToolbarConfig';
import MobileBottomSheet from './common/MobileBottomSheet.vue';

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

// ==================== 仿手机桌面长按悬浮拖拽状态 ====================
// 是否正在拖拽中
const isDragging = ref(false);
// 当前被拖拽的 Item 对象
const draggedItem = ref<ToolbarItemDefinition | null>(null);
// 当前在列表中的槽位索引
const currentSlotIndex = ref<number>(-1);
// 悬浮卡片的屏幕绝对位置 (px)
const floatPos = ref({ x: 0, y: 0 });
// 悬浮卡片的固定尺寸 (px)
const floatSize = ref({ width: 80, height: 80 });

// 手指相对卡片左上角的偏移量
let touchOffset = { x: 0, y: 0 };
// 长按定时器
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let startTouchX = 0;
let startTouchY = 0;

// 清理长按定时器
const clearTimer = () => {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
};

// 探测手指/指针所在的目标卡片槽位
const detectTargetSlot = (clientX: number, clientY: number) => {
  if (typeof document === 'undefined') return;
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return;

  const cardEl = el.closest('[data-active-index]') as HTMLElement | null;
  if (cardEl && cardEl.dataset.activeIndex !== undefined) {
    const targetIdx = parseInt(cardEl.dataset.activeIndex, 10);
    if (!isNaN(targetIdx) && targetIdx !== currentSlotIndex.value && currentSlotIndex.value !== -1) {
      const fromIdx = currentSlotIndex.value;
      moveActiveItem(fromIdx, targetIdx);
      currentSlotIndex.value = targetIdx;
      // 碰撞换位震动反馈
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(12);
      }
    }
  }
};

// 移动端 Touch 全局滑动处理（传入 passive: false 彻底阻断页面任何上下滚动）
const onGlobalTouchMove = (e: TouchEvent) => {
  if (!isDragging.value) return;
  // 必须阻止默认行为，杜绝页面上下滑动
  e.preventDefault();

  const touch = e.touches[0];
  if (!touch) return;

  floatPos.value = {
    x: touch.clientX - touchOffset.x,
    y: touch.clientY - touchOffset.y,
  };

  detectTargetSlot(touch.clientX, touch.clientY);
};

// 移动端 Touch 结束
const onGlobalTouchEnd = () => {
  clearTimer();
  window.removeEventListener('touchmove', onGlobalTouchMove);
  window.removeEventListener('touchend', onGlobalTouchEnd);
  window.removeEventListener('touchcancel', onGlobalTouchEnd);

  if (isDragging.value) {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(18);
    }
    isDragging.value = false;
    draggedItem.value = null;
    currentSlotIndex.value = -1;
  }
};

// 卡片 touchstart 处理：220ms 长按判定
const handleCardTouchStart = (e: TouchEvent, item: ToolbarItemDefinition, index: number) => {
  const touch = e.touches[0];
  if (!touch) return;

  clearTimer();
  startTouchX = touch.clientX;
  startTouchY = touch.clientY;

  const target = (e.currentTarget as HTMLElement) || (e.target as HTMLElement);
  const rect = target.getBoundingClientRect();

  // 记录卡片当前大小与手指相对偏移
  floatSize.value = { width: rect.width, height: rect.height };
  touchOffset = {
    x: touch.clientX - rect.left,
    y: touch.clientY - rect.top,
  };

  longPressTimer = setTimeout(() => {
    isDragging.value = true;
    draggedItem.value = item;
    currentSlotIndex.value = index;
    floatPos.value = {
      x: touch.clientX - touchOffset.x,
      y: touch.clientY - touchOffset.y,
    };

    // 震动提示
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(35);
    }

    // 挂载全局 touch 监听，锁定屏幕
    window.addEventListener('touchmove', onGlobalTouchMove, { passive: false });
    window.addEventListener('touchend', onGlobalTouchEnd);
    window.addEventListener('touchcancel', onGlobalTouchEnd);
  }, 220);
};

// 卡片 touchmove 处理：尚未长按前如果有滑动则取消长按（允许用户正常滚动列表）
const handleCardTouchMoveEarly = (e: TouchEvent) => {
  if (!isDragging.value && longPressTimer) {
    const touch = e.touches[0];
    if (touch) {
      const dx = Math.abs(touch.clientX - startTouchX);
      const dy = Math.abs(touch.clientY - startTouchY);
      if (dx > 8 || dy > 8) {
        clearTimer();
      }
    }
  }
};

// ==================== 桌面端鼠标长按拖拽兜底 ====================
const onGlobalMouseMove = (e: MouseEvent) => {
  if (!isDragging.value) return;
  e.preventDefault();

  floatPos.value = {
    x: e.clientX - touchOffset.x,
    y: e.clientY - touchOffset.y,
  };

  detectTargetSlot(e.clientX, e.clientY);
};

const onGlobalMouseUp = () => {
  clearTimer();
  window.removeEventListener('mousemove', onGlobalMouseMove);
  window.removeEventListener('mouseup', onGlobalMouseUp);

  if (isDragging.value) {
    isDragging.value = false;
    draggedItem.value = null;
    currentSlotIndex.value = -1;
  }
};

const handleCardMouseDown = (e: MouseEvent, item: ToolbarItemDefinition, index: number) => {
  // 只响应鼠标左键
  if (e.button !== 0) return;
  clearTimer();

  const target = (e.currentTarget as HTMLElement) || (e.target as HTMLElement);
  const rect = target.getBoundingClientRect();

  floatSize.value = { width: rect.width, height: rect.height };
  touchOffset = {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  };

  longPressTimer = setTimeout(() => {
    isDragging.value = true;
    draggedItem.value = item;
    currentSlotIndex.value = index;
    floatPos.value = {
      x: e.clientX - touchOffset.x,
      y: e.clientY - touchOffset.y,
    };

    window.addEventListener('mousemove', onGlobalMouseMove);
    window.addEventListener('mouseup', onGlobalMouseUp);
  }, 200);
};

// 组件卸载时清理所有事件监听与定时器
onBeforeUnmount(() => {
  clearTimer();
  if (typeof window !== 'undefined') {
    window.removeEventListener('touchmove', onGlobalTouchMove);
    window.removeEventListener('touchend', onGlobalTouchEnd);
    window.removeEventListener('touchcancel', onGlobalTouchEnd);
    window.removeEventListener('mousemove', onGlobalMouseMove);
    window.removeEventListener('mouseup', onGlobalMouseUp);
  }
});

const handleClose = () => {
  onGlobalTouchEnd();
  emit('close');
};
</script>

<template>
  <MobileBottomSheet
    :visible="isVisible"
    :title="t('mobileToolbar.title', '自定义工具栏')"
    icon="fas fa-sliders-h"
    height="h-[85vh]"
    max-height="max-h-[90vh]"
    :show-close-button="false"
    :panel-class="isDragging ? 'touch-none select-none' : ''"
    @close="handleClose"
  >
    <template #header-actions>
      <!-- 恢复默认 -->
      <button
        type="button"
        @click="resetToDefault"
        class="px-2.5 py-1 text-xs font-medium text-text-secondary hover:text-foreground bg-header/60 hover:bg-border/40 border border-border/60 rounded-lg active:scale-95 transition-all cursor-pointer"
        :title="t('common.resetDefault', '恢复默认')"
      >
        <i class="fas fa-undo text-[10px] mr-1"></i>
        <span>{{ t('common.reset', '重置') }}</span>
      </button>

      <!-- 完成按钮 -->
      <button
        type="button"
        @click="handleClose"
        class="px-3 py-1 text-xs font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95 transition-all shadow-xs cursor-pointer"
      >
        {{ t('common.done', '完成') }}
      </button>
    </template>

    <template #sub-header>
      <!-- 帮助提示胶囊条 -->
      <div class="px-4 py-2 bg-header/30 border-b border-border/30 flex items-center gap-2 text-[11px] text-text-secondary shrink-0">
        <i class="fas fa-hand-pointer text-primary text-xs shrink-0"></i>
        <span>{{ isDragging ? '正在拖动中，移动到目标槽位松手落位' : '长按上方卡片可悬浮拖拽排序，点击右上角 +/- 快速增删' }}</span>
      </div>
    </template>

          <!-- 可滚动内容区：分上下两层 -->
          <div
            class="sheet-body flex-grow overflow-y-auto px-4 py-3 space-y-5 overscroll-contain"
            :class="{ 'overflow-hidden touch-none': isDragging }"
          >
            <!-- 上层区域：当前工具栏 (已启用并显示的按钮) -->
            <section class="space-y-2.5">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-1.5">
                  <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
                  <h4 class="text-xs font-semibold text-foreground uppercase tracking-wider">
                    {{ t('mobileToolbar.activeAreaTitle', '当前工具栏显示区') }}
                  </h4>
                  <span class="text-[10px] px-1.5 py-0.2 rounded-full bg-emerald-500/10 text-emerald-400 font-mono font-medium">
                    {{ activeItems.length }}
                  </span>
                </div>
                <span class="text-[11px] text-text-secondary/70">
                  {{ isDragging ? '移动到槽位松手换位' : '长按卡片悬浮拖动' }}
                </span>
              </div>

              <!-- 当前工具栏卡片网格 -->
              <div class="grid grid-cols-3 sm:grid-cols-4 gap-2.5 min-h-[96px] p-2 rounded-xl bg-header/20 border border-border/40 relative">
                <div
                  v-for="(item, idx) in activeItems"
                  :key="item.id"
                  :data-active-index="idx"
                  @touchstart="handleCardTouchStart($event, item, idx)"
                  @touchmove="handleCardTouchMoveEarly($event)"
                  @touchend="clearTimer"
                  @touchcancel="clearTimer"
                  @mousedown="handleCardMouseDown($event, item, idx)"
                  @mouseup="clearTimer"
                  class="relative flex flex-col items-center justify-center p-3 rounded-xl border shadow-xs transition-colors select-none group"
                  :class="[
                    isDragging && draggedItem?.id === item.id
                      ? 'border-2 border-dashed border-primary/60 bg-primary/10 opacity-30 shadow-inner'
                      : 'bg-background border-border/70 hover:border-primary/50 cursor-grab active:cursor-grabbing'
                  ]"
                >
                  <!-- 移除按钮（右上角红色减号）仅在非拖拽状态下可点击 -->
                  <button
                    v-show="!isDragging"
                    type="button"
                    @click.stop="removeFromActive(item.id)"
                    class="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white flex items-center justify-center text-[10px] shadow-sm hover:scale-110 active:scale-90 transition-transform cursor-pointer z-10"
                    :title="t('common.remove', '移除至仓库')"
                  >
                    <i class="fas fa-minus"></i>
                  </button>

                  <!-- 按钮图标与名称 -->
                  <div class="flex flex-col items-center justify-center py-0.5 gap-1.5 w-full text-center pointer-events-none">
                    <div class="w-9 h-9 rounded-xl bg-header/60 text-primary flex items-center justify-center">
                      <i :class="item.icon" class="text-base"></i>
                    </div>
                    <span class="text-xs font-medium text-foreground tracking-tight truncate w-full px-1">
                      {{ item.name }}
                    </span>
                  </div>

                  <!-- 底部微小的把手视觉指示 -->
                  <div class="w-5 h-1 bg-border/60 rounded-full mt-1 opacity-40 pointer-events-none"></div>
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

        <!-- ==================== 仿手机桌面悬浮跟随卡片镜像 (Floating Ghost) ==================== -->
        <div
          v-if="isDragging && draggedItem"
          class="fixed pointer-events-none z-[9999] rounded-xl bg-background border-2 border-primary shadow-2xl flex flex-col items-center justify-center p-3 select-none will-change-transform"
          :style="{
            left: `${floatPos.x}px`,
            top: `${floatPos.y}px`,
            width: `${floatSize.width}px`,
            height: `${floatSize.height}px`,
            transform: 'scale(1.12) rotate(2deg)',
            transition: 'transform 0.12s cubic-bezier(0.2, 0, 0, 1)',
          }"
        >
          <div class="w-9 h-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
            <i :class="draggedItem.icon" class="text-base"></i>
          </div>
          <span class="text-xs font-semibold text-foreground tracking-tight truncate w-full text-center px-1 mt-1">
            {{ draggedItem.name }}
          </span>
          <div class="w-5 h-1 bg-primary/40 rounded-full mt-1"></div>
        </div>
  </MobileBottomSheet>
</template>

<style scoped>
/* 彻底禁用拖拽时移动端的文本选中与呼出系统菜单 */
.mobile-toolbar-sheet {
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}
</style>
