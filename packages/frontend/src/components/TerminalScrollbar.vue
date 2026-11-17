<!--
  终端右侧滚动条（桌面 / 移动共用）。

  - 桌面：variant="gutter"，占据右侧独立一列，绝不与终端内容重叠
  - 移动：variant="floating"，悬浮在终端上方，宽热区方便手指抓

  历史上的名字是 MobileTerminalScrollbar（最早只给移动端用），
  后来桌面端也切到同一实现，名字会误导，已改为 TerminalScrollbar。
-->
<script setup lang="ts">
import { ref, computed } from 'vue';
import type { TerminalSearchMarker } from '../utils/terminalSearch';

const props = withDefaults(
  defineProps<{
    canScroll: boolean;
    scrollProgress: number; // 0 到 1
    thumbHeightRatio: number; // 0 到 1
    /**
     * floating：悬浮在终端上方（移动端，宽热区方便手指抓）
     * gutter：占据右侧独立一列，不与终端内容重叠（桌面端）
     */
    variant?: 'floating' | 'gutter';
    /** 搜索命中位置标记（top/height 为轨道百分比），没有搜索时传空数组 */
    searchMarkers?: TerminalSearchMarker[];
  }>(),
  { variant: 'floating', searchMarkers: () => [] }
);

const emit = defineEmits<{
  (e: 'scroll-progress', progress: number): void;
}>();

const trackRef = ref<HTMLDivElement | null>(null);
const isDragging = ref(false);

const isGutter = computed(() => props.variant === 'gutter');
// 悬浮模式在没有滚动空间时整体隐藏；gutter 模式常驻（否则滚动条出现/消失会让终端宽度反复变化）
const shouldRender = computed(() => (isGutter.value ? true : props.canScroll));

const thumbHeightPercent = computed(() => {
  return Math.round(Math.min(1, Math.max(0.04, props.thumbHeightRatio)) * 100);
});

const thumbTopPercent = computed(() => {
  const maxTop = 100 - thumbHeightPercent.value;
  return Math.min(maxTop, Math.max(0, props.scrollProgress * maxTop));
});

// 拖动时"抓住哪就按哪"：记录按下滑块内部的位置偏移，
// 之后滑块严格跟随鼠标位移（1:1），不会一按就跳到鼠标中心。
let grabOffsetPx = 0;

const getTrackMetrics = () => {
  const track = trackRef.value;
  if (!track) return null;
  const rect = track.getBoundingClientRect();
  const trackHeight = rect.height;
  if (trackHeight <= 0) return null;
  const thumbHeightPx = Math.min(trackHeight, Math.max(28, props.thumbHeightRatio * trackHeight));
  const maxTopPx = trackHeight - thumbHeightPx;
  if (maxTopPx <= 0) return null;
  return { rect, trackHeight, thumbHeightPx, maxTopPx };
};

const handleDragTo = (clientY: number) => {
  if (!props.canScroll) return;
  const metrics = getTrackMetrics();
  if (!metrics) return;
  const y = clientY - metrics.rect.top;
  const top = Math.min(metrics.maxTopPx, Math.max(0, y - grabOffsetPx));
  emit('scroll-progress', top / metrics.maxTopPx);
};

/** 按下：判断是按在滑块上还是轨道空白处，后者先跳过去再以滑块中心继续拖 */
const beginDrag = (clientY: number) => {
  const metrics = getTrackMetrics();
  if (!metrics) return;
  const y = clientY - metrics.rect.top;
  const thumbTop = props.scrollProgress * metrics.maxTopPx;
  const onThumb = y >= thumbTop - 4 && y <= thumbTop + metrics.thumbHeightPx + 4;
  grabOffsetPx = onThumb ? y - thumbTop : metrics.thumbHeightPx / 2;
  if (!onThumb) handleDragTo(clientY);
};

const handleTouchStart = (event: TouchEvent) => {
  if (event.touches.length > 0) {
    // 移动端拖动滚动条时，若终端隐藏 textarea 仍处于聚焦状态（例如用户按返回键收起了输入法但焦点未失），
    // 主动将其 blur，防止 Android 浏览器/WebView 在触摸交互结束时自动重新拉起软键盘。
    const activeEl = document.activeElement as HTMLElement | null;
    if (activeEl && activeEl.classList.contains('xterm-helper-textarea')) {
      activeEl.blur();
    }

    isDragging.value = true;
    beginDrag(event.touches[0].clientY);
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
  beginDrag(event.clientY);

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
    v-if="shouldRender"
    ref="trackRef"
    class="terminal-scrollbar-track"
    :class="[
      isGutter ? 'is-gutter' : 'is-floating',
      {
        'is-dragging': isDragging,
        'is-idle': !props.canScroll,
      },
    ]"
    @touchstart.stop.prevent="handleTouchStart"
    @touchmove.stop.prevent="handleTouchMove"
    @touchend.stop.prevent="handleTouchEnd"
    @touchcancel.stop.prevent="handleTouchEnd"
    @mousedown.stop.prevent="handleMouseDown"
    @mouseup.stop
    @pointerdown.stop
    @pointerup.stop
    @click.stop.prevent
  >
    <!--
      搜索命中标记：画在滚动条轨道上，让"哪些位置有命中"一眼可见。
      顺序上放在滑块之前，滑块仍压在最上层；pointer-events: none 不抢拖拽手势。
    -->
    <div
      v-for="(marker, index) in props.searchMarkers"
      :key="`search-marker-${index}`"
      class="search-marker"
      :class="{ 'is-active': marker.active }"
      :style="{
        top: `${marker.top * 100}%`,
        height: `${Math.max(marker.height * 100, 0.35)}%`
      }"
    ></div>

    <div
      class="terminal-scrollbar-thumb"
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
.terminal-scrollbar-track {
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
}

/* 移动端：悬浮在终端右侧，宽热区方便手指盲抓 */
.terminal-scrollbar-track.is-floating {
  position: absolute;
  top: 6px;
  bottom: 6px;
  right: 2px;
  width: 24px;
  z-index: 40;
  display: flex;
  justify-content: flex-end;
  align-items: flex-start;
}

/* 桌面端：占右侧独立一列（在终端外面，不压内容） */
.terminal-scrollbar-track.is-gutter {
  position: relative;
  flex: 0 0 10px;
  width: 10px;
  height: 100%;
  z-index: 5;
}

.terminal-scrollbar-thumb {
  position: absolute;
  right: 2px;
  width: 14px;
  min-height: 28px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  pointer-events: none;
  transition: opacity 0.2s ease;
  /* 必须压在搜索标记之上：标记只是"哪里有命中"的提示，
     不该反过来盖住用户正在拖动的滑块。 */
  z-index: 4;
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
.terminal-scrollbar-track.is-dragging .thumb-pill,
.terminal-scrollbar-track:active .thumb-pill {
  width: 7px;
  opacity: 1;
  background-color: rgba(209, 213, 219, 0.8);
  box-shadow: 0 0 3px rgba(0, 0, 0, 0.45);
}

/* 桌面 gutter：窄一点，贴着终端右边缘，不遮挡任何字符 */
.terminal-scrollbar-track.is-gutter .terminal-scrollbar-thumb {
  right: 1px;
  width: 8px;
}

.terminal-scrollbar-track.is-gutter .thumb-pill {
  width: 4px;
  background-color: rgba(156, 163, 175, 0.5);
}

.terminal-scrollbar-track.is-gutter.is-dragging .thumb-pill,
.terminal-scrollbar-track.is-gutter:hover .thumb-pill,
.terminal-scrollbar-track.is-gutter:active .thumb-pill {
  width: 6px;
  background-color: rgba(209, 213, 219, 0.85);
}

/* 没有可滚动内容时淡出，但保留列宽，避免终端宽度反复变化 */
.terminal-scrollbar-track.is-gutter.is-idle {
  opacity: 0;
  pointer-events: none;
}

/*
 * 搜索命中标记（小横条）：
 * - 只在 gutter 模式显示。floating 模式轨道宽 24px 但贴右边缘，
 *   横条会和拇指滑块抢视觉位置，且移动端有专门的高亮条更易读。
 * - 绝对定位，右侧对齐，不参与拖拽命中。
 */
.search-marker {
  position: absolute;
  right: 1px;
  width: 4px;
  min-height: 2px;
  border-radius: 1px;
  /* 半透明：它只是位置提示，不能盖住轨道和滑块 */
  background-color: rgba(250, 204, 21, 0.45);
  pointer-events: none;
  z-index: 2;
}

/* 当前聚焦的匹配：更宽更亮（橙红），与"全部匹配"的黄色区分开 */
.search-marker.is-active {
  width: 6px;
  right: 0;
  background-color: rgba(249, 115, 22, 0.7);
  z-index: 3;
}

/* 悬浮模式下标记稍窄一点，避免盖住药丸滑块 */
.terminal-scrollbar-track.is-floating .search-marker {
  right: 9px;
  width: 3px;
}

.terminal-scrollbar-track.is-floating .search-marker.is-active {
  right: 8px;
  width: 5px;
}
</style>
