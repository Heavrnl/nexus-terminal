<script setup lang="ts">
import { watch, onBeforeUnmount, type StyleValue } from 'vue';
import { useI18n } from 'vue-i18n';
import { useBottomSheetDrag } from '../../composables/useBottomSheetDrag';

export interface MobileBottomSheetProps {
  /** 控制显隐 */
  visible: boolean;
  /** 抽屉顶栏标题 */
  title?: string;
  /** 标题前置图标 (FontAwesome 类名) */
  icon?: string;
  /** 面板固定高度 class，默认 'h-[75vh]' */
  height?: string;
  /** 面板最大高度 class，默认 'max-h-[100dvh]' */
  maxHeight?: string;
  /** 自定义 z-index，默认 50 */
  zIndex?: number;
  /** 是否显示右上角收起/关闭按钮，默认 true */
  showCloseButton?: boolean;
  /** 点击遮罩背景是否触发关闭，默认 true */
  closeOnClickOverlay?: boolean;
  /** 是否监听键盘 Esc 触发关闭，默认 true */
  closeOnEsc?: boolean;
  /** 是否启用顶部手势上下拖拽与下拉关闭，默认 true */
  enableDrag?: boolean;
  /** 下拉关闭的位移阈值 (px)，默认 75 */
  dragThreshold?: number;
  /** 抽屉面板自定义样式类 */
  panelClass?: string;
  /** 抽屉内容区自定义样式类 */
  contentClass?: string;
  /** 是否渲染底部安全区内联垫片，默认 true */
  safeAreaBottom?: boolean;
}

const props = withDefaults(defineProps<MobileBottomSheetProps>(), {
  title: '',
  icon: '',
  height: 'h-[75vh]',
  maxHeight: 'max-h-[100dvh]',
  zIndex: 50,
  showCloseButton: true,
  closeOnClickOverlay: true,
  closeOnEsc: true,
  enableDrag: true,
  dragThreshold: 75,
  panelClass: '',
  contentClass: '',
  safeAreaBottom: true,
});

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void;
  (e: 'close'): void;
}>();

const { t } = useI18n();

const handleClose = () => {
  emit('update:visible', false);
  emit('close');
};

// 接入统一的底部抽屉上下手势拖拽与智能吸附控制器
const {
  sheetRef,
  handleRef,
  currentSnap,
  isJustDragged,
  toggleSnap,
  resetStyles,
} = useBottomSheetDrag({
  onClose: handleClose,
  threshold: props.dragThreshold,
});

// 手柄点击处理：防拖动误触，点击切换全屏/半屏
const handleHandleClick = (e: MouseEvent) => {
  e.stopPropagation();
  if (isJustDragged()) return;
  toggleSnap();
};

// Esc 按键全局监听
const handleKeydown = (e: KeyboardEvent) => {
  if (props.closeOnEsc && e.key === 'Escape') {
    handleClose();
  }
};

// 关键生命周期：仅在 Transition 彻底离场结束销毁 DOM 后才重置内联样式，杜绝二次弹出 Bug
const handleAfterLeave = () => {
  resetStyles();
};

watch(() => props.visible, (val) => {
  if (val) {
    resetStyles();
    if (props.closeOnEsc) {
      document.addEventListener('keydown', handleKeydown);
    }
  } else {
    document.removeEventListener('keydown', handleKeydown);
    // 注意：此处严禁调用 resetStyles()，让退出动画平滑走完后由 @after-leave 触发重置
  }
}, { immediate: true });

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeydown);
  resetStyles();
});
</script>

<template>
  <Teleport to="body">
    <Transition name="bottom-sheet" @after-leave="handleAfterLeave">
      <div
        v-if="props.visible"
        class="bottom-sheet-overlay fixed inset-0 flex flex-col justify-end bg-black/60 backdrop-blur-xs select-none"
        :style="{ zIndex: props.zIndex } as StyleValue"
        @click.self="props.closeOnClickOverlay && handleClose()"
      >
        <!-- 移动端底部滑出面板 (Bottom Sheet) -->
        <div
          ref="sheetRef"
          class="bottom-sheet-panel w-full bg-background border-t border-border/80 shadow-2xl flex flex-col overflow-hidden will-change-[height,transform]"
          :class="[
            currentSnap === 'expanded' ? 'rounded-t-none' : 'rounded-t-2xl',
            props.height,
            props.maxHeight,
            props.panelClass
          ]"
        >
          <!-- 顶部拖拽手势热区 (包含手柄与顶栏) -->
          <div
            ref="handleRef"
            class="sheet-top-drag-zone select-none shrink-0 touch-none bg-background cursor-grab active:cursor-grabbing"
            @dblclick="toggleSnap"
          >
            <!-- 默认手柄插槽或药丸指示条 -->
            <slot name="handle">
              <div
                class="sheet-handle-zone pt-2.5 pb-1 flex flex-col items-center justify-center cursor-pointer active:opacity-60 transition-opacity"
                @click="handleHandleClick"
                :title="currentSnap === 'expanded' ? t('common.collapse', '折叠半屏') : t('common.expand', '展开至顶部')"
              >
                <div
                  class="w-10 h-1.5 rounded-full transition-colors"
                  :class="currentSnap === 'expanded' ? 'bg-primary/60 hover:bg-primary/80' : 'bg-border/80 hover:bg-text-secondary/40'"
                ></div>
              </div>
            </slot>

            <!-- 顶栏插槽或默认标题栏 -->
            <slot name="header">
              <div
                v-if="props.title || $slots['header-left'] || $slots['header-actions']"
                class="sheet-header flex items-center justify-between px-4 py-2 border-b border-border/50 shrink-0"
              >
                <!-- 左侧图标与标题 -->
                <div class="flex items-center gap-2 min-w-0">
                  <slot name="header-left">
                    <div
                      v-if="props.icon"
                      class="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0"
                    >
                      <i :class="[props.icon, 'text-sm']"></i>
                    </div>
                    <h3 v-if="props.title" class="text-base font-semibold text-foreground tracking-tight truncate">
                      {{ props.title }}
                    </h3>
                  </slot>
                </div>

                <!-- 右侧自定义操作区与收起按钮 -->
                <div class="flex items-center gap-1.5 shrink-0 ml-2" data-no-drag>
                  <slot name="header-actions" />
                  <button
                    v-if="props.showCloseButton"
                    type="button"
                    @click="handleClose"
                    class="w-7 h-7 flex items-center justify-center rounded-lg text-text-secondary hover:text-foreground hover:bg-border/40 active:scale-95 transition-all cursor-pointer"
                    :title="t('common.close', '收起')"
                  >
                    <i class="fas fa-chevron-down text-sm"></i>
                  </button>
                </div>
              </div>
            </slot>

            <!-- 辅助顶栏插槽 (如搜索条、过滤器) -->
            <slot name="sub-header" />
          </div>

          <!-- 抽屉主体内容区插槽 -->
          <div
            class="bottom-sheet-content flex-grow overflow-hidden flex flex-col bg-background"
            :class="props.contentClass"
          >
            <slot />
          </div>

          <!-- 底部安全区垫片 -->
          <div v-if="props.safeAreaBottom" class="sheet-safe-bottom shrink-0"></div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 遮罩淡入淡出动效 */
.bottom-sheet-enter-active,
.bottom-sheet-leave-active {
  transition: opacity 0.22s ease;
}

.bottom-sheet-enter-from,
.bottom-sheet-leave-to {
  opacity: 0;
}

/* 抽屉底部弹性滑入滑出动效 */
.bottom-sheet-enter-active .bottom-sheet-panel {
  transition: transform 0.26s cubic-bezier(0.16, 1, 0.3, 1);
}

.bottom-sheet-leave-active .bottom-sheet-panel {
  transition: transform 0.22s cubic-bezier(0.35, 0, 0.8, 1);
}

.bottom-sheet-enter-from .bottom-sheet-panel,
.bottom-sheet-leave-to .bottom-sheet-panel {
  transform: translateY(100%);
}

.sheet-safe-bottom {
  padding-bottom: max(env(safe-area-inset-bottom, 0px), 16px);
}
</style>
