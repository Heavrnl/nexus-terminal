<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue';
import MonacoEditor from './MonacoEditor.vue';
import CodeMirrorMobileEditor from './CodeMirrorMobileEditor.vue';
import MarkdownPreview from './MarkdownPreview.vue';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    language?: string;
    fontFamily?: string;
    fontSize?: number;
    viewMode?: 'split' | 'edit' | 'preview';
    syncScroll?: boolean;
    initialScrollTop?: number;
    initialScrollLeft?: number;
    isMobile?: boolean;
  }>(),
  {
    modelValue: '',
    language: 'markdown',
    fontFamily: 'Consolas, "Courier New", monospace',
    fontSize: 14,
    viewMode: 'split',
    syncScroll: true,
    initialScrollTop: 0,
    initialScrollLeft: 0,
    isMobile: false,
  }
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'request-save'): void;
  (e: 'update:fontSize', size: number): void;
  (e: 'update:scrollPosition', pos: { scrollTop: number; scrollLeft: number }): void;
}>();

// 组件引用
const monacoEditorRef = ref<InstanceType<typeof MonacoEditor> | null>(null);
const codeMirrorMobileEditorRef = ref<InstanceType<typeof CodeMirrorMobileEditor> | null>(null);
const markdownPreviewRef = ref<InstanceType<typeof MarkdownPreview> | null>(null);

// 分屏比例拖拽状态 (20% ~ 80%)
const splitRatio = ref(50);
const isResizingSplit = ref(false);

const startSplitResize = (e: MouseEvent) => {
  isResizingSplit.value = true;
  const target = e.currentTarget as HTMLElement;
  const container = target.parentElement;
  if (!container) return;
  const containerRect = container.getBoundingClientRect();
  const containerWidth = containerRect.width;

  const onMouseMove = (moveEvent: MouseEvent) => {
    const offsetX = moveEvent.clientX - containerRect.left;
    let newRatio = (offsetX / containerWidth) * 100;
    newRatio = Math.max(20, Math.min(80, newRatio));
    splitRatio.value = parseFloat(newRatio.toFixed(1));
  };

  const onMouseUp = () => {
    isResizingSplit.value = false;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
};

const resetSplitRatio = () => {
  splitRatio.value = 50;
};

// 双向平滑互斥同步滚动逻辑
type ScrollSyncSource = 'editor' | 'preview' | null;
let currentScrollSyncSource: ScrollSyncSource = null;
let resetScrollSyncTimer: number | null = null;

const scheduleResetSyncSource = () => {
  if (resetScrollSyncTimer) clearTimeout(resetScrollSyncTimer);
  resetScrollSyncTimer = window.setTimeout(() => {
    currentScrollSyncSource = null;
  }, 100);
};

// 左侧编辑器滚动 -> 同步到右侧预览
const handleEditorScroll = (info: { scrollTop: number; scrollLeft: number; scrollHeight?: number; clientHeight?: number }) => {
  emit('update:scrollPosition', { scrollTop: info.scrollTop, scrollLeft: info.scrollLeft });

  if (props.viewMode !== 'split' || !props.syncScroll) return;
  if (currentScrollSyncSource === 'preview') return;

  const previewComp = markdownPreviewRef.value;
  if (!previewComp) return;

  const previewInfo = previewComp.getScrollInfo();
  const editorScrollHeight = info.scrollHeight ?? 0;
  const editorClientHeight = info.clientHeight ?? 0;
  const editorMaxScroll = editorScrollHeight - editorClientHeight;
  const previewMaxScroll = previewInfo.scrollHeight - previewInfo.clientHeight;

  if (editorMaxScroll <= 0 || previewMaxScroll <= 0) return;

  currentScrollSyncSource = 'editor';

  const ratio = info.scrollTop / editorMaxScroll;
  let targetPreviewTop = ratio * previewMaxScroll;
  if (ratio <= 0.005) {
    targetPreviewTop = 0;
  } else if (ratio >= 0.995) {
    targetPreviewTop = previewMaxScroll;
  }

  previewComp.setScrollTop(targetPreviewTop);
  scheduleResetSyncSource();
};

// 右侧预览滚动 -> 同步到左侧编辑器
const handlePreviewScroll = (info: { scrollTop: number; scrollHeight: number; clientHeight: number }) => {
  if (props.viewMode !== 'split' || !props.syncScroll) return;
  if (currentScrollSyncSource === 'editor') return;

  const editorComp = monacoEditorRef.value;
  if (!editorComp) return;

  const editorInfo = editorComp.getScrollInfo();
  const editorMaxScroll = editorInfo.scrollHeight - editorInfo.clientHeight;
  const previewMaxScroll = info.scrollHeight - info.clientHeight;

  if (editorMaxScroll <= 0 || previewMaxScroll <= 0) return;

  currentScrollSyncSource = 'preview';

  const ratio = info.scrollTop / previewMaxScroll;
  let targetEditorTop = ratio * editorMaxScroll;
  if (ratio <= 0.005) {
    targetEditorTop = 0;
  } else if (ratio >= 0.995) {
    targetEditorTop = editorMaxScroll;
  }

  editorComp.setScrollTop(targetEditorTop);
  scheduleResetSyncSource();
};

onBeforeUnmount(() => {
  if (resetScrollSyncTimer) {
    clearTimeout(resetScrollSyncTimer);
    resetScrollSyncTimer = null;
  }
});

defineExpose({
  focus: () => {
    if (monacoEditorRef.value) {
      monacoEditorRef.value.focus();
    }
  },
  setScrollTop: (top: number) => {
    if (monacoEditorRef.value) {
      monacoEditorRef.value.setScrollTop(top);
    }
  },
  getScrollInfo: () => {
    return monacoEditorRef.value?.getScrollInfo() ?? { scrollTop: 0, scrollLeft: 0, scrollHeight: 0, clientHeight: 0 };
  },
});
</script>

<template>
  <div class="markdown-split-editor-root w-full h-full overflow-hidden relative">
    <!-- 1. 仅源码模式 -->
    <template v-if="props.viewMode === 'edit'">
      <MonacoEditor
        v-if="!props.isMobile"
        ref="monacoEditorRef"
        :model-value="props.modelValue"
        :language="props.language"
        :font-family="props.fontFamily"
        :font-size="props.fontSize"
        theme="vs-dark"
        class="editor-instance"
        :initial-scroll-top="props.initialScrollTop"
        :initial-scroll-left="props.initialScrollLeft"
        @update:model-value="(val) => emit('update:modelValue', val)"
        @request-save="emit('request-save')"
        @update:font-size="(size) => emit('update:fontSize', size)"
        @update:scroll-position="handleEditorScroll"
      />
      <CodeMirrorMobileEditor
        v-else
        ref="codeMirrorMobileEditorRef"
        :model-value="props.modelValue"
        :language="props.language"
        class="editor-instance"
        @update:model-value="(val) => emit('update:modelValue', val)"
        @request-save="emit('request-save')"
      />
    </template>

    <!-- 2. 仅预览模式 -->
    <div v-else-if="props.viewMode === 'preview'" class="markdown-full-preview">
      <MarkdownPreview :content="props.modelValue" :font-size="props.fontSize" />
    </div>

    <!-- 3. 双栏分屏模式 (Split View) -->
    <div v-else class="markdown-split-container">
      <div v-if="isResizingSplit" class="resizing-overlay"></div>

      <!-- 左侧编辑器分屏 -->
      <div class="split-pane split-editor-pane" :style="{ width: `${splitRatio}%` }">
        <MonacoEditor
          v-if="!props.isMobile"
          ref="monacoEditorRef"
          :model-value="props.modelValue"
          :language="props.language"
          :font-family="props.fontFamily"
          :font-size="props.fontSize"
          theme="vs-dark"
          class="editor-instance"
          :initial-scroll-top="props.initialScrollTop"
          :initial-scroll-left="props.initialScrollLeft"
          @update:model-value="(val) => emit('update:modelValue', val)"
          @request-save="emit('request-save')"
          @update:font-size="(size) => emit('update:fontSize', size)"
          @update:scroll-position="handleEditorScroll"
        />
        <CodeMirrorMobileEditor
          v-else
          ref="codeMirrorMobileEditorRef"
          :model-value="props.modelValue"
          :language="props.language"
          class="editor-instance"
          @update:model-value="(val) => emit('update:modelValue', val)"
          @request-save="emit('request-save')"
        />
      </div>

      <!-- 可拖拽分割条 -->
      <div
        class="markdown-split-resizer"
        :class="{ active: isResizingSplit }"
        @mousedown.prevent="startSplitResize"
        @dblclick="resetSplitRatio"
        title="拖拽调节宽度，双击复位 50%"
      >
        <div class="resizer-handle"></div>
      </div>

      <!-- 右侧实时渲染预览分屏 -->
      <div class="split-pane split-preview-pane" :style="{ width: `${100 - splitRatio}%` }">
        <MarkdownPreview
          ref="markdownPreviewRef"
          :content="props.modelValue"
          :font-size="props.fontSize"
          @scroll="handlePreviewScroll"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.markdown-split-editor-root {
  display: flex;
  flex-direction: column;
}

.editor-instance {
  flex-grow: 1;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.markdown-full-preview {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.markdown-split-container {
  display: flex;
  flex-direction: row;
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
}

.split-pane {
  height: 100%;
  overflow: hidden;
  position: relative;
  min-width: 15%;
}

.split-editor-pane {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
}

.split-preview-pane {
  flex-grow: 1;
  flex-shrink: 0;
}

.markdown-split-resizer {
  width: 7px;
  cursor: col-resize;
  background-color: #2d2d2d;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  z-index: 10;
  user-select: none;
  transition: background-color 0.15s ease;
  flex-shrink: 0;
}

.markdown-split-resizer:hover,
.markdown-split-resizer.active {
  background-color: var(--color-primary, #3b82f6);
}

.resizer-handle {
  width: 2px;
  height: 24px;
  border-radius: 1px;
  background-color: rgba(255, 255, 255, 0.3);
  transition: background-color 0.15s ease;
}

.markdown-split-resizer:hover .resizer-handle,
.markdown-split-resizer.active .resizer-handle {
  background-color: #ffffff;
}

.resizing-overlay {
  position: absolute;
  inset: 0;
  z-index: 50;
  cursor: col-resize;
  user-select: none;
}
</style>
