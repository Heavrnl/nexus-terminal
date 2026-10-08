<script lang="ts">
import { ref } from 'vue';

// 模块级单例响应式变量，保证同一时刻全局最多只有一个说明框处于弹出状态
const globalActiveTooltipId = ref<string | null>(null);
</script>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, type CSSProperties } from 'vue';

const props = withDefaults(
  defineProps<{
    text?: string;
  }>(),
  {
    text: '',
  }
);

const tooltipId = 'help-tip-' + Math.random().toString(36).substring(2, 9);
const isOpen = computed(() => globalActiveTooltipId.value === tooltipId);

const triggerRef = ref<HTMLElement | null>(null);
const popoverRef = ref<HTMLElement | null>(null);

const popoverStyle = ref<CSSProperties>({});
const arrowStyle = ref<CSSProperties>({});
const isPlacementTop = ref(false);

const updatePosition = () => {
  if (!triggerRef.value || !popoverRef.value) return;

  const triggerRect = triggerRef.value.getBoundingClientRect();
  const popoverEl = popoverRef.value;
  const popoverWidth = popoverEl.offsetWidth || 280;
  const popoverHeight = popoverEl.offsetHeight || 70;

  const margin = 12;
  const spacing = 8;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // 水平位置：以 trigger 为中心，并在视口边界内做 clamp
  let left = triggerRect.left + triggerRect.width / 2 - popoverWidth / 2;
  if (left < margin) {
    left = margin;
  } else if (left + popoverWidth > viewportWidth - margin) {
    left = Math.max(margin, viewportWidth - popoverWidth - margin);
  }

  // 垂直位置：优先下方，下方超出且上方有空间则放上方
  let top = triggerRect.bottom + spacing;
  let placementTop = false;

  if (top + popoverHeight > viewportHeight - margin) {
    if (triggerRect.top - popoverHeight - spacing >= margin) {
      top = triggerRect.top - popoverHeight - spacing;
      placementTop = true;
    }
  }

  isPlacementTop.value = placementTop;
  popoverStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
  };

  // 小箭头水平位置相对于 popover 容器
  const triggerCenterX = triggerRect.left + triggerRect.width / 2;
  const arrowX = Math.round(triggerCenterX - left - 6);
  const clampedArrowX = Math.max(12, Math.min(arrowX, popoverWidth - 24));
  arrowStyle.value = {
    left: `${clampedArrowX}px`,
  };
};

const toggle = (e?: Event) => {
  e?.stopPropagation?.();
  if (isOpen.value) {
    close();
  } else {
    globalActiveTooltipId.value = tooltipId;
    nextTick(() => {
      updatePosition();
    });
  }
};

const close = () => {
  if (globalActiveTooltipId.value === tooltipId) {
    globalActiveTooltipId.value = null;
  }
};

const handleDocumentClick = (e: MouseEvent) => {
  if (!isOpen.value) return;
  const target = e.target as Node;
  if (
    popoverRef.value &&
    !popoverRef.value.contains(target) &&
    triggerRef.value &&
    !triggerRef.value.contains(target)
  ) {
    close();
  }
};

const handleKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && isOpen.value) {
    close();
  }
};

const handleWindowChange = () => {
  if (isOpen.value) {
    updatePosition();
  }
};

onMounted(() => {
  document.addEventListener('click', handleDocumentClick, true);
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('resize', handleWindowChange);
  window.addEventListener('scroll', handleWindowChange, true);
});

onUnmounted(() => {
  if (globalActiveTooltipId.value === tooltipId) {
    globalActiveTooltipId.value = null;
  }
  document.removeEventListener('click', handleDocumentClick, true);
  window.removeEventListener('keydown', handleKeyDown);
  window.removeEventListener('resize', handleWindowChange);
  window.removeEventListener('scroll', handleWindowChange, true);
});
</script>

<template>
  <div class="inline-flex items-center shrink-0">
    <!-- 触发按钮 -->
    <button
      ref="triggerRef"
      type="button"
      @click="toggle"
      class="inline-flex items-center justify-center w-5 h-5 rounded-full text-text-secondary/70 hover:text-foreground hover:bg-muted/40 active:scale-95 transition-all cursor-pointer focus:outline-none"
      :class="{ 'text-primary bg-primary/10 ring-1 ring-primary/30': isOpen }"
      aria-label="查看说明"
    >
      <i class="fas fa-circle-exclamation text-xs"></i>
    </button>

    <!-- 说明浮层 -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition duration-150 ease-out"
        enter-from-class="opacity-0 scale-95"
        enter-to-class="opacity-100 scale-100"
        leave-active-class="transition duration-100 ease-in"
        leave-from-class="opacity-100 scale-100"
        leave-to-class="opacity-0 scale-95"
      >
        <div
          v-if="isOpen"
          ref="popoverRef"
          :style="popoverStyle"
          class="fixed z-[9999] bg-background border border-border rounded-xl shadow-xl p-3 sm:p-3.5 max-w-[calc(100vw-24px)] w-72 sm:w-80 select-text outline-none"
          tabindex="-1"
          @click.stop
        >
          <!-- 小指示箭头 -->
          <div
            v-if="!isPlacementTop"
            :style="arrowStyle"
            class="absolute -top-1.5 w-3 h-3 bg-background border-t border-l border-border rotate-45 transform pointer-events-none"
          ></div>
          <div
            v-else
            :style="arrowStyle"
            class="absolute -bottom-1.5 w-3 h-3 bg-background border-b border-r border-border rotate-45 transform pointer-events-none"
          ></div>

          <!-- 说明框内容区 -->
          <div class="relative flex items-start justify-between gap-2.5 z-10">
            <div class="flex-1 text-xs sm:text-[13px] text-foreground leading-relaxed break-words">
              <slot>{{ text }}</slot>
            </div>
            <button
              type="button"
              @click="close"
              class="text-text-secondary/60 hover:text-foreground active:scale-95 p-1 -mr-1 -mt-1 rounded-lg hover:bg-muted/40 transition-colors shrink-0 cursor-pointer"
              aria-label="关闭"
            >
              <i class="fas fa-times text-xs"></i>
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
