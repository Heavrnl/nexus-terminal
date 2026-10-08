<script setup lang="ts">
import { ref, computed } from 'vue';

const props = defineProps<{
  canScroll: boolean;
  scrollProgress: number; // 0 到 1
  thumbHeightRatio: number; // 0 到 1
}>();

const emit = defineEmits<{
  (e: 'scroll-progress', progress: number): void;
}>();

const trackRef = ref<HTMLDivElement | null>(null);
const isDragging = ref(false);

const thumbHeightPercent = computed(() => {
  return Math.round(props.thumbHeightRatio * 100);
});

const thumbTopPercent = computed(() => {
  const maxTop = 100 - thumbHeightPercent.value;
  return Math.min(maxTop, Math.max(0, props.scrollProgress * maxTop));
});

const handleDragTo = (clientY: number) => {
  if (!props.canScroll || !trackRef.value) return;

  const rect = trackRef.value.getBoundingClientRect();
  const trackHeight = rect.height;
  if (trackHeight <= 0) return;

  const thumbHeightPx = Math.max(28, props.thumbHeightRatio * trackHeight);
  const maxTopPx = trackHeight - thumbHeightPx;
  if (maxTopPx <= 0) return;

  const relativeY = clientY - rect.top;
  const targetTopPx = relativeY - thumbHeightPx / 2;
  const progress = Math.min(1, Math.max(0, targetTopPx / maxTopPx));

  emit('scroll-progress', progress);
};

const handleTouchStart = (event: TouchEvent) => {
  if (event.touches.length > 0) {
    isDragging.value = true;
    handleDragTo(event.touches[0].clientY);
  }
};

const handleTouchMove = (event: TouchEvent) => {
  if (event.touches.length > 0) {
    handleDragTo(event.touches[0].clientY);
  }
};

const handleTouchEnd = () => {
  isDragging.value = false;
};

const handleMouseDown = (event: MouseEvent) => {
  isDragging.value = true;
  handleDragTo(event.clientY);

  const onMouseMove = (moveEvent: MouseEvent) => {
    handleDragTo(moveEvent.clientY);
  };
  const onMouseUp = () => {
    isDragging.value = false;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
};
</script>

<template>
  <div
    v-if="props.canScroll"
    ref="trackRef"
    class="mobile-terminal-scrollbar-track"
    :class="{ 'is-dragging': isDragging }"
    @touchstart.stop.prevent="handleTouchStart"
    @touchmove.stop.prevent="handleTouchMove"
    @touchend.stop.prevent="handleTouchEnd"
    @touchcancel.stop.prevent="handleTouchEnd"
    @mousedown.stop.prevent="handleMouseDown"
  >
    <div
      class="mobile-terminal-scrollbar-thumb"
      :style="{
        height: `${thumbHeightPercent}%`,
        top: `${thumbTopPercent}%`
      }"
    >
      <div class="thumb-pill"></div>
    </div>
  </div>
</template>

<style scoped>
/* 移动端专属终端悬浮滚动条样式 */
.mobile-terminal-scrollbar-track {
  position: absolute;
  top: 6px;
  bottom: 6px;
  right: 2px;
  width: 24px; /* 宽触摸热区，方便手指盲抓 */
  z-index: 40;
  display: flex;
  justify-content: flex-end;
  align-items: flex-start;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
}

.mobile-terminal-scrollbar-thumb {
  position: absolute;
  right: 2px;
  width: 14px;
  min-height: 28px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  pointer-events: none;
  transition: opacity 0.2s ease;
}

/* 极简灰药丸状滚动条 */
.thumb-pill {
  width: 5px;
  height: 100%;
  border-radius: 9999px;
  background-color: rgba(156, 163, 175, 0.45);
  box-shadow: 0 0 2px rgba(0, 0, 0, 0.35);
  transition: width 0.15s ease, opacity 0.15s ease, background-color 0.15s ease, box-shadow 0.15s ease;
}

/* 拖动激活态或触摸按下态 */
.mobile-terminal-scrollbar-track.is-dragging .thumb-pill,
.mobile-terminal-scrollbar-track:active .thumb-pill {
  width: 7px;
  opacity: 1;
  background-color: rgba(209, 213, 219, 0.8);
  box-shadow: 0 0 3px rgba(0, 0, 0, 0.45);
}
</style>
