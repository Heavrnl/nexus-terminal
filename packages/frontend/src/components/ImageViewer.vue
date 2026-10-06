<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FileTab } from '../stores/fileEditor.store';
import { getImageMimeType, getFileExtension, formatFileSize } from '../constants/fileTypes';

const props = defineProps<{
  tab: FileTab;
}>();

const { t } = useI18n();

// 容器与图片 DOM 引用
const containerRef = ref<HTMLDivElement | null>(null);
const imageRef = ref<HTMLImageElement | null>(null);

// 变换状态：缩放、平移、旋转、翻转
const scale = ref<number>(1);
const translateX = ref<number>(0);
const translateY = ref<number>(0);
const rotate = ref<number>(0);
const flipH = ref<boolean>(false);
const flipV = ref<boolean>(false);

// 拖拽平移相关
const isDragging = ref<boolean>(false);
let startMouseX = 0;
let startMouseY = 0;
let startTranslateX = 0;
let startTranslateY = 0;

// 图片加载与元数据状态
const isLoaded = ref<boolean>(false);
const isError = ref<boolean>(false);
const naturalWidth = ref<number>(0);
const naturalHeight = ref<number>(0);

// 计算 Data URL 图片源
const imageSrc = computed<string>(() => {
  if (!props.tab) return '';
  if (props.tab.rawContentBase64) {
    const mime = getImageMimeType(props.tab.filePath);
    return `data:${mime};base64,${props.tab.rawContentBase64}`;
  }
  // SVG 文本回退兼容
  const ext = getFileExtension(props.tab.filePath);
  if (ext === 'svg' && props.tab.content && props.tab.content.trim().startsWith('<svg')) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(props.tab.content)}`;
  }
  return '';
});

// 计算文件格式大写名称
const fileFormatName = computed<string>(() => {
  const ext = getFileExtension(props.tab.filePath);
  return ext ? ext.toUpperCase() : 'IMG';
});

// 计算文件实际大小
const formattedSize = computed<string>(() => {
  if (props.tab.remoteSize && props.tab.remoteSize > 0) {
    return formatFileSize(props.tab.remoteSize);
  }
  if (props.tab.rawContentBase64) {
    const b64 = props.tab.rawContentBase64;
    const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    const bytes = Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
    return formatFileSize(bytes);
  }
  return formatFileSize(0);
});

// 缩放百分比文本
const zoomPercentage = computed<string>(() => {
  return `${Math.round(scale.value * 100)}%`;
});

// 图片变换样式
const imageTransformStyle = computed(() => {
  const scaleX = flipH.value ? -scale.value : scale.value;
  const scaleY = flipV.value ? -scale.value : scale.value;
  return {
    transform: `translate(${translateX.value}px, ${translateY.value}px) rotate(${rotate.value}deg) scale(${scaleX}, ${scaleY})`,
    transition: isDragging.value ? 'none' : 'transform 0.15s cubic-bezier(0.2, 0, 0, 1)',
  };
});

// 重置变换状态
const resetView = () => {
  scale.value = 1;
  translateX.value = 0;
  translateY.value = 0;
  rotate.value = 0;
  flipH.value = false;
  flipV.value = false;
};

// 适应屏幕视口大小
const fitToView = () => {
  if (!containerRef.value || naturalWidth.value === 0 || naturalHeight.value === 0) {
    scale.value = 1;
    translateX.value = 0;
    translateY.value = 0;
    return;
  }
  const rect = containerRef.value.getBoundingClientRect();
  const padding = 48; // 保留边距
  const availW = Math.max(40, rect.width - padding);
  const availH = Math.max(40, rect.height - padding);

  // 考虑旋转 90/270 度时的宽高颠倒
  const isRotated90 = Math.abs(rotate.value % 180) === 90;
  const targetW = isRotated90 ? naturalHeight.value : naturalWidth.value;
  const targetH = isRotated90 ? naturalWidth.value : naturalHeight.value;

  const ratio = Math.min(availW / targetW, availH / targetH, 1);
  scale.value = Math.max(0.05, Math.min(30, ratio));
  translateX.value = 0;
  translateY.value = 0;
};

// 放大
const zoomIn = () => {
  scale.value = Math.min(30, Number((scale.value * 1.25).toFixed(2)));
};

// 缩小
const zoomOut = () => {
  scale.value = Math.max(0.05, Number((scale.value / 1.25).toFixed(2)));
};

// 1:1 实际大小
const setActualSize = () => {
  scale.value = 1;
  translateX.value = 0;
  translateY.value = 0;
};

// 向左旋转 90 度
const rotateLeft = () => {
  rotate.value = (rotate.value - 90) % 360;
};

// 向右旋转 90 度
const rotateRight = () => {
  rotate.value = (rotate.value + 90) % 360;
};

// 水平翻转
const toggleFlipH = () => {
  flipH.value = !flipH.value;
};

// 滚轮缩放处理
const handleWheel = (e: WheelEvent) => {
  e.preventDefault();
  const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const newScale = Math.max(0.05, Math.min(30, scale.value * zoomFactor));

  // 以鼠标指针为中心平滑缩放
  if (containerRef.value) {
    const rect = containerRef.value.getBoundingClientRect();
    const mouseX = e.clientX - rect.left - rect.width / 2;
    const mouseY = e.clientY - rect.top - rect.height / 2;

    const ratio = newScale / scale.value;
    translateX.value = mouseX - (mouseX - translateX.value) * ratio;
    translateY.value = mouseY - (mouseY - translateY.value) * ratio;
  }

  scale.value = Number(newScale.toFixed(3));
};

// 拖拽平移开始
const handleMouseDown = (e: MouseEvent) => {
  if (e.button !== 0) return; // 仅限左键
  isDragging.value = true;
  startMouseX = e.clientX;
  startMouseY = e.clientY;
  startTranslateX = translateX.value;
  startTranslateY = translateY.value;

  window.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('mouseup', handleMouseUp);
};

const handleMouseMove = (e: MouseEvent) => {
  if (!isDragging.value) return;
  translateX.value = startTranslateX + (e.clientX - startMouseX);
  translateY.value = startTranslateY + (e.clientY - startMouseY);
};

const handleMouseUp = () => {
  if (!isDragging.value) return;
  isDragging.value = false;
  window.removeEventListener('mousemove', handleMouseMove);
  window.removeEventListener('mouseup', handleMouseUp);
};

// 双击自适应/复位切换
const handleDoubleClick = () => {
  if (Math.abs(scale.value - 1) < 0.05) {
    fitToView();
  } else {
    setActualSize();
  }
};

// 图片加载成功
const handleImageLoad = (e: Event) => {
  const target = e.target as HTMLImageElement;
  naturalWidth.value = target.naturalWidth;
  naturalHeight.value = target.naturalHeight;
  isLoaded.value = true;
  isError.value = false;
  // 首次载入自适应窗口（若尺寸大于容器）
  fitToView();
};

// 图片加载出错
const handleImageError = () => {
  isLoaded.value = false;
  isError.value = true;
};

// 标签切换或源变化时重置
watch(
  () => props.tab?.id,
  () => {
    resetView();
    isLoaded.value = false;
    isError.value = false;
  }
);

onMounted(() => {
  if (imageRef.value && imageRef.value.complete && imageRef.value.naturalWidth > 0) {
    naturalWidth.value = imageRef.value.naturalWidth;
    naturalHeight.value = imageRef.value.naturalHeight;
    isLoaded.value = true;
    fitToView();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', handleMouseMove);
  window.removeEventListener('mouseup', handleMouseUp);
});
</script>

<template>
  <div
    ref="containerRef"
    class="image-viewer-container"
    @wheel="handleWheel"
    @mousedown="handleMouseDown"
    @dblclick="handleDoubleClick"
  >
    <!-- 顶部半透明悬浮控制胶囊栏 -->
    <div class="image-viewer-toolbar" @mousedown.stop @dblclick.stop>
      <button
        class="toolbar-btn"
        :title="t('imageViewer.zoomOut', '缩小 (滚轮下滚)')"
        @click="zoomOut"
      >
        <i class="fas fa-search-minus"></i>
      </button>

      <button
        class="toolbar-btn zoom-indicator"
        :title="t('imageViewer.actualSize', '恢复 100% 原始大小')"
        @click="setActualSize"
      >
        {{ zoomPercentage }}
      </button>

      <button
        class="toolbar-btn"
        :title="t('imageViewer.zoomIn', '放大 (滚轮上滚)')"
        @click="zoomIn"
      >
        <i class="fas fa-search-plus"></i>
      </button>

      <div class="toolbar-divider"></div>

      <button
        class="toolbar-btn"
        :title="t('imageViewer.fitToView', '自适应视图大小 (双击)')"
        @click="fitToView"
      >
        <i class="fas fa-expand"></i>
      </button>

      <button
        class="toolbar-btn"
        :title="t('imageViewer.rotateLeft', '向左旋转 90°')"
        @click="rotateLeft"
      >
        <i class="fas fa-undo"></i>
      </button>

      <button
        class="toolbar-btn"
        :title="t('imageViewer.rotateRight', '向右旋转 90°')"
        @click="rotateRight"
      >
        <i class="fas fa-redo"></i>
      </button>

      <button
        class="toolbar-btn"
        :class="{ active: flipH }"
        :title="t('imageViewer.flipH', '水平镜像翻转')"
        @click="toggleFlipH"
      >
        <i class="fas fa-arrows-alt-h"></i>
      </button>

      <div class="toolbar-divider"></div>

      <button
        class="toolbar-btn"
        :title="t('imageViewer.reset', '重置所有变换')"
        @click="resetView"
      >
        <i class="fas fa-sync-alt"></i>
      </button>
    </div>

    <!-- 舞台画布区 -->
    <div class="image-stage" :class="{ dragging: isDragging }">
      <!-- 正常渲染的图片对象 -->
      <img
        v-if="imageSrc"
        ref="imageRef"
        :src="imageSrc"
        :alt="props.tab.filename"
        class="rendered-image"
        :style="imageTransformStyle"
        draggable="false"
        @load="handleImageLoad"
        @error="handleImageError"
      />

      <!-- 加载指示器 -->
      <div v-if="props.tab.isLoading || (!isLoaded && !isError && imageSrc)" class="viewer-loading">
        <i class="fas fa-spinner fa-spin"></i>
        <span>{{ t('fileManager.loadingFile', '正在加载图片...') }}</span>
      </div>

      <!-- 错误状态提示 -->
      <div v-else-if="isError || (!imageSrc && !props.tab.isLoading)" class="viewer-error">
        <i class="fas fa-exclamation-triangle"></i>
        <span>{{ t('imageViewer.loadError', '图片加载失败或格式不受支持') }}</span>
      </div>
    </div>

    <!-- 底部暗黑信息状态栏 -->
    <div class="image-viewer-statusbar" @mousedown.stop @dblclick.stop>
      <div class="status-left">
        <span class="format-badge">{{ fileFormatName }}</span>
        <span class="status-filename" :title="props.tab.filePath">{{ props.tab.filename }}</span>
        <span v-if="naturalWidth > 0 && naturalHeight > 0" class="status-dimensions">
          {{ naturalWidth }} × {{ naturalHeight }} px
        </span>
      </div>
      <div class="status-right">
        <span class="status-size">{{ formattedSize }}</span>
        <span class="status-scale">{{ zoomPercentage }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.image-viewer-container {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  user-select: none;
  background-color: #121315;
  /* 经典高对比度专业暗色棋盘格图案，便于检验透明通道 */
  background-image:
    linear-gradient(45deg, #1d1f23 25%, transparent 25%),
    linear-gradient(-45deg, #1d1f23 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #1d1f23 75%),
    linear-gradient(-45deg, transparent 75%, #1d1f23 75%);
  background-size: 20px 20px;
  background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
  display: flex;
  flex-direction: column;
}

/* 顶部悬浮工具栏 */
.image-viewer-toolbar {
  position: absolute;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: rgba(22, 24, 29, 0.88);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 24px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.toolbar-btn {
  background: transparent;
  border: none;
  color: #c9d1d9;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.15s ease;
}

.toolbar-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #58a6ff;
  transform: scale(1.05);
}

.toolbar-btn.active {
  background: rgba(56, 139, 253, 0.25);
  color: #58a6ff;
}

.toolbar-btn.zoom-indicator {
  width: auto;
  min-width: 48px;
  padding: 0 8px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
  font-family: var(--nexus-font-mono, monospace);
  color: #8b949e;
}

.toolbar-btn.zoom-indicator:hover {
  color: #58a6ff;
}

.toolbar-divider {
  width: 1px;
  height: 18px;
  background: rgba(255, 255, 255, 0.12);
  margin: 0 2px;
}

/* 舞台画布区 */
.image-stage {
  flex: 1;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  position: relative;
}

.image-stage.dragging {
  cursor: grabbing;
}

.rendered-image {
  max-width: none;
  max-height: none;
  pointer-events: none;
  transform-origin: center center;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35);
  border-radius: 2px;
  image-rendering: -webkit-optimize-contrast;
}

/* 加载中与错误提示 */
.viewer-loading,
.viewer-error {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  color: #8b949e;
  font-size: 13px;
  pointer-events: none;
}

.viewer-loading i {
  font-size: 24px;
  color: #58a6ff;
}

.viewer-error {
  color: #f85149;
}

.viewer-error i {
  font-size: 28px;
}

/* 底部状态栏 */
.image-viewer-statusbar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 28px;
  background: rgba(18, 19, 22, 0.92);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  font-size: 11px;
  color: #8b949e;
  z-index: 10;
  font-family: var(--nexus-font-mono, monospace);
}

.status-left,
.status-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.format-badge {
  background: rgba(56, 139, 253, 0.15);
  color: #58a6ff;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 700;
  font-size: 10px;
  border: 1px solid rgba(56, 139, 253, 0.3);
}

.status-filename {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #c9d1d9;
}

.status-dimensions {
  color: #7ee787;
}

.status-size,
.status-scale {
  color: #8b949e;
}
</style>
