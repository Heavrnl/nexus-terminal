<script setup lang="ts">
import { computed, ref, watch, nextTick, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import MarkdownSplitEditor from './MarkdownSplitEditor.vue';
import MarkdownViewToggle from './MarkdownViewToggle.vue';
import CodeMirrorMobileEditor from './CodeMirrorMobileEditor.vue';
import ImageViewer from './ImageViewer.vue';
import FileEditorTabs from './FileEditorTabs.vue';
import type { FileTab } from '../stores/fileEditor.store';
import { useSettingsStore } from '../stores/settings.store';
import { FILE_ENCODING_OPTIONS } from '../constants/fileEncodings';
import { isImageFilePath } from '../constants/fileTypes';
import type { PaneId } from '../composables/useSplitEditor';

const props = defineProps({
  paneId: {
    type: String as PropType<PaneId>,
    default: 'primary',
  },
  tabs: {
    type: Array as PropType<FileTab[]>,
    required: true,
  },
  activeTabId: {
    type: String as PropType<string | null>,
    default: null,
  },
  sessionName: {
    type: String as PropType<string | null>,
    default: null,
  },
  fontFamily: {
    type: String,
    default: 'Consolas, "Courier New", monospace',
  },
  fontSize: {
    type: Number,
    default: 14,
  },
});

const emit = defineEmits<{
  (e: 'activate-tab', tabId: string): void;
  (e: 'close-tab', tabId: string): void;
  (e: 'close-other-tabs', tabId: string): void;
  (e: 'close-tabs-to-right', tabId: string): void;
  (e: 'close-tabs-to-left', tabId: string): void;
  (e: 'update-content', payload: { tabId: string; content: string }): void;
  (e: 'save-tab', tabId: string): void;
  (e: 'change-encoding', payload: { tabId: string; encoding: string }): void;
  (e: 'update-scroll', payload: { tabId: string; scrollTop: number; scrollLeft: number }): void;
  (e: 'update-font-size', newSize: number): void;
  (e: 'resolve-conflict-reload', tabId: string): void;
  (e: 'resolve-conflict-overwrite', tabId: string): void;
  (e: 'resolve-conflict-ignore', tabId: string): void;
}>();

const { t } = useI18n();

// 活动标签
const activeTab = computed((): FileTab | null => {
  if (!props.activeTabId) return null;
  return props.tabs.find(tab => tab.id === props.activeTabId) ?? null;
});

// 本地编辑器内容缓冲
const localContent = ref('');
const encodingSelectRef = ref<HTMLSelectElement | null>(null);

// 编辑器引用
const markdownEditorRef = ref<InstanceType<typeof MarkdownSplitEditor> | null>(null);
const codeMirrorMobileEditorRef = ref<InstanceType<typeof CodeMirrorMobileEditor> | null>(null);

// 文件类型判断
const isImageFile = computed(() => isImageFilePath(activeTab.value?.filePath));
const isMarkdownFile = computed(() => {
  if (isImageFile.value || !activeTab.value) return false;
  const path = activeTab.value.filePath || '';
  const ext = path.split('.').pop()?.toLowerCase();
  return ext === 'md' || ext === 'markdown' || ext === 'mdown' || activeTab.value.language === 'markdown';
});

// Markdown 视图设置
const settingsStore = useSettingsStore();
const tabMarkdownViewModeMap = ref<Record<string, 'split' | 'edit' | 'preview'>>({});

const getDefaultMarkdownViewMode = (): 'split' | 'edit' | 'preview' => {
  return settingsStore.markdownDefaultViewModeMobileString;
};

const markdownViewMode = ref<'split' | 'edit' | 'preview'>(getDefaultMarkdownViewMode());
const SYNC_SCROLL_STORAGE_KEY = 'nexus_markdown_sync_scroll_enabled';
const isSyncScrollEnabled = ref<boolean>(localStorage.getItem(SYNC_SCROLL_STORAGE_KEY) !== 'false');

watch(isSyncScrollEnabled, (newVal) => {
  localStorage.setItem(SYNC_SCROLL_STORAGE_KEY, String(newVal));
});

watch(
  [() => activeTab.value?.id, isMarkdownFile],
  ([newTabId, isMd]) => {
    if (!newTabId || !isMd) return;
    if (tabMarkdownViewModeMap.value[newTabId]) {
      markdownViewMode.value = tabMarkdownViewModeMap.value[newTabId];
    } else {
      const defaultMode = getDefaultMarkdownViewMode();
      markdownViewMode.value = defaultMode;
      tabMarkdownViewModeMap.value[newTabId] = defaultMode;
    }
  },
  { immediate: true }
);

watch(markdownViewMode, (newMode) => {
  if (activeTab.value?.id && isMarkdownFile.value) {
    tabMarkdownViewModeMap.value[activeTab.value.id] = newMode;
  }
});

// 编码选项
const encodingOptions = FILE_ENCODING_OPTIONS;
const currentSelectedEncoding = computed(() => activeTab.value?.selectedEncoding ?? 'utf-8');

const updateSelectWidth = () => {
  nextTick(() => {
    if (!encodingSelectRef.value) return;
    const select = encodingSelectRef.value;
    const selectedOption = select.options[select.selectedIndex];
    if (!selectedOption) return;

    const span = document.createElement('span');
    const styles = window.getComputedStyle(select);
    span.style.fontSize = styles.fontSize;
    span.style.fontFamily = styles.fontFamily;
    span.style.fontWeight = styles.fontWeight;
    span.style.visibility = 'hidden';
    span.style.position = 'absolute';
    span.style.whiteSpace = 'nowrap';
    span.textContent = selectedOption.text;
    document.body.appendChild(span);
    const textWidth = span.offsetWidth;
    document.body.removeChild(span);

    select.style.width = `${Math.max(68, textWidth + 22)}px`;
  });
};

watch(
  activeTab,
  (newTab) => {
    localContent.value = newTab?.content ?? '';
    updateSelectWidth();
  },
  { immediate: true }
);

watch(currentSelectedEncoding, () => {
  updateSelectWidth();
});

watch(localContent, (newContent) => {
  if (activeTab.value && newContent !== activeTab.value.content) {
    emit('update-content', { tabId: activeTab.value.id, content: newContent });
  }
});

const handleEncodingChange = (e: Event) => {
  const target = e.target as HTMLSelectElement;
  const newEncoding = target.value;
  if (activeTab.value && newEncoding && newEncoding !== currentSelectedEncoding.value) {
    emit('change-encoding', { tabId: activeTab.value.id, encoding: newEncoding });
  }
};

const handleSave = () => {
  if (activeTab.value) {
    emit('save-tab', activeTab.value.id);
  }
};

const handleEditorScroll = (payload: { scrollTop: number; scrollLeft: number }) => {
  if (activeTab.value) {
    emit('update-scroll', { tabId: activeTab.value.id, ...payload });
  }
};

const handleFontSizeUpdate = (size: number) => {
  emit('update-font-size', size);
};

const focusActiveEditor = (): boolean => {
  if (isMarkdownFile.value && markdownEditorRef.value) {
    markdownEditorRef.value.focus();
    return true;
  }
  if (codeMirrorMobileEditorRef.value) {
    codeMirrorMobileEditorRef.value.focus();
    return true;
  }
  return false;
};

const handleOpenSearch = () => {
  if (isMarkdownFile.value) {
    markdownEditorRef.value?.toggleSearch();
  } else {
    codeMirrorMobileEditorRef.value?.toggleSearch();
  }
};

defineExpose({
  focusActiveEditor,
  openSearch: () => {
    if (isMarkdownFile.value) {
      markdownEditorRef.value?.openSearch();
    } else {
      codeMirrorMobileEditorRef.value?.openSearch();
    }
  },
  toggleSearch: handleOpenSearch,
});
</script>

<template>
  <div class="mobile-single-editor-pane pane-primary flex flex-col w-full h-full overflow-hidden relative">
    <!-- 1. 移动端标签栏 -->
    <FileEditorTabs
      :tabs="props.tabs"
      :active-tab-id="props.activeTabId"
      :is-mobile="true"
      @activate-tab="(id: string) => emit('activate-tab', id)"
      @close-tab="(id: string) => emit('close-tab', id)"
      @close-other-tabs="(id: string) => emit('close-other-tabs', id)"
      @close-tabs-to-right="(id: string) => emit('close-tabs-to-right', id)"
      @close-tabs-to-left="(id: string) => emit('close-tabs-to-left', id)"
    />

    <!-- 2. 移动端特化编辑器工具头部 -->
    <div v-if="activeTab" class="mobile-editor-header">
      <div class="file-info-title">
        <i class="fas fa-file-code text-primary text-xs mr-1.5 shrink-0"></i>
        <span class="file-name-text truncate font-medium text-xs text-foreground" :title="activeTab.filePath">
          {{ activeTab.filename }}
        </span>
        <span
          v-if="activeTab.isModified"
          class="w-2 h-2 rounded-full bg-amber-400 shrink-0 ml-1.5 shadow-xs"
          title="未保存变更"
        ></span>
      </div>

      <div class="mobile-editor-actions">
        <!-- Markdown 视图切换工具栏 -->
        <MarkdownViewToggle
          v-if="isMarkdownFile && !activeTab.isLoading"
          v-model:view-mode="markdownViewMode"
          v-model:sync-scroll="isSyncScrollEnabled"
        />

        <!-- 文本文件编码下拉框 -->
        <template v-if="!isImageFile">
          <div v-if="!activeTab.isLoading" class="encoding-select-wrapper">
            <select
              ref="encodingSelectRef"
              :value="currentSelectedEncoding"
              class="mobile-encoding-select"
              :title="t('fileManager.changeEncodingTooltip', '更改文件编码')"
              @change="handleEncodingChange"
            >
              <option v-for="opt in encodingOptions" :key="opt.value" :value="opt.value">
                {{ opt.text }}
              </option>
            </select>
          </div>
          <span v-else class="encoding-select-placeholder">{{ t('fileManager.loadingEncoding', '加载中...') }}</span>

          <!-- 移动端搜索快捷按钮 -->
          <button
            v-if="!activeTab.isLoading"
            class="mobile-action-icon-btn mobile-search-btn"
            :title="t('fileManager.actions.search', '搜索')"
            @click="handleOpenSearch"
          >
            <i class="fas fa-search text-xs"></i>
          </button>

          <!-- 移动端大触控保存按钮 -->
          <button
            class="mobile-save-btn"
            :class="{ 'has-changes': activeTab.isModified }"
            :disabled="activeTab.isSaving || activeTab.isLoading || !!activeTab.loadingError || !activeTab.isModified"
            @click="handleSave"
          >
            <i v-if="activeTab.saveStatus === 'saving'" class="fas fa-circle-notch fa-spin text-xs"></i>
            <i v-else-if="activeTab.saveStatus === 'success'" class="fas fa-check text-xs text-emerald-400"></i>
            <i v-else class="fas fa-save text-xs mr-1"></i>
            <span>{{ t('fileManager.actions.save') }}</span>
          </button>
        </template>

        <!-- 外部扩展按钮插槽 (例如 Overlay 关闭弹窗) -->
        <slot name="header-actions"></slot>
      </div>
    </div>

    <!-- 无活动标签占位头部 -->
    <div v-else class="mobile-editor-header mobile-editor-header-placeholder">
      <span>{{ t('fileManager.noOpenFile') }}</span>
      <div class="mobile-editor-actions">
        <slot name="header-actions"></slot>
      </div>
    </div>

    <!-- 外部冲突保护横幅 -->
    <div v-if="activeTab?.hasExternalConflict" class="conflict-banner">
      <div class="conflict-message">
        <i class="fas fa-exclamation-triangle"></i>
        <span>{{ t('fileManager.conflictWarning', '文件已在远端修改，本地有未保存内容。') }}</span>
      </div>
      <div class="conflict-actions">
        <button class="conflict-btn reload-btn" @click="emit('resolve-conflict-reload', activeTab.id)">
          {{ t('fileManager.actions.reloadRemote', '以远端内容载入') }}
        </button>
        <button class="conflict-btn overwrite-btn" @click="emit('resolve-conflict-overwrite', activeTab.id)">
          {{ t('fileManager.actions.overwriteRemote', '覆盖保存到远端') }}
        </button>
        <button class="conflict-btn ignore-btn" @click="emit('resolve-conflict-ignore', activeTab.id)">
          {{ t('common.ignore', '忽略') }}
        </button>
      </div>
    </div>

    <!-- 3. 编辑器内容区域 -->
    <div class="editor-content-area">
      <div v-if="activeTab?.isLoading" class="editor-loading">{{ t('fileManager.loadingFile') }}</div>
      <div v-else-if="activeTab?.loadingError" class="editor-error">{{ activeTab.loadingError }}</div>

      <!-- 图片专用视图 -->
      <ImageViewer
        v-else-if="activeTab && isImageFile"
        :key="`img-${activeTab.id}-${props.paneId}`"
        :tab="activeTab"
      />

      <!-- Markdown 移动端专属拆分视图 -->
      <MarkdownSplitEditor
        v-else-if="activeTab && isMarkdownFile"
        ref="markdownEditorRef"
        :key="`md-${activeTab.id}-${props.paneId}`"
        v-model="localContent"
        :language="activeTab.language"
        :font-family="props.fontFamily"
        :font-size="props.fontSize"
        :view-mode="markdownViewMode"
        :sync-scroll="isSyncScrollEnabled"
        :initial-scroll-top="activeTab.scrollTop ?? 0"
        :initial-scroll-left="activeTab.scrollLeft ?? 0"
        :is-mobile="true"
        @request-save="handleSave"
        @update:font-size="handleFontSizeUpdate"
        @update:scroll-position="handleEditorScroll"
      />

      <!-- 移动端纯轻量 CodeMirror 编辑器 -->
      <CodeMirrorMobileEditor
        v-else-if="activeTab"
        ref="codeMirrorMobileEditorRef"
        :key="`cm-${activeTab.id}-${props.paneId}`"
        v-model="localContent"
        :language="activeTab.language"
        class="editor-instance"
        @request-save="handleSave"
      />

      <!-- 空白占位 -->
      <div v-else class="editor-placeholder">{{ t('fileManager.selectFileToEdit') }}</div>
    </div>
  </div>
</template>

<style scoped>
.mobile-single-editor-pane {
  background-color: var(--nexus-bg-primary, #1e1e1e);
}

.mobile-editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 38px;
  height: 38px;
  padding: 0 10px;
  background-color: #202022;
  border-bottom: 1px solid #333336;
  font-size: 12px;
  color: #cccccc;
  flex-shrink: 0;
}

.mobile-editor-header-placeholder {
  color: #888888;
}

.file-info-title {
  display: flex;
  align-items: center;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  max-width: 45%;
  margin-right: 6px;
}

.file-name-text {
  font-size: 12px;
  font-weight: 600;
  color: #e4e4e7;
}

.mobile-editor-actions {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.encoding-select-wrapper {
  display: inline-flex;
  align-items: center;
  vertical-align: middle;
}

.mobile-encoding-select {
  box-sizing: border-box;
  height: 26px;
  min-width: 68px;
  background-color: #2c2c2f;
  color: #d4d4d8;
  border: 1px solid #444448;
  padding: 0 14px 0 6px;
  font-size: 11px;
  border-radius: 6px;
  cursor: pointer;
  line-height: 24px;
  outline: none;
  display: inline-flex;
  align-items: center;
}

.encoding-select-placeholder {
  font-size: 11px;
  color: #888888;
}

.mobile-action-icon-btn.mobile-search-btn {
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 6px;
  background-color: #2c2c2f;
  border: 1px solid #444448;
  color: #a1a1aa;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mobile-action-icon-btn.mobile-search-btn:active {
  background-color: #3f3f46;
  color: #ffffff;
}

.mobile-save-btn {
  box-sizing: border-box;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background-color: #2563eb;
  color: #ffffff;
  border: 1px solid transparent;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border-radius: 6px;
  gap: 4px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  transition: all 0.15s ease;
}

.mobile-save-btn:active:not(:disabled) {
  transform: scale(0.96);
  background-color: #1d4ed8;
}

.mobile-save-btn.has-changes {
  background-color: #2563eb;
}

.mobile-save-btn:disabled {
  background-color: #2e3035;
  color: #71717a;
  cursor: not-allowed;
  box-shadow: none;
}

.conflict-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background-color: #382400;
  border-bottom: 1px solid #7a4f00;
  padding: 4px 10px;
  font-size: 12px;
  color: #ffcc00;
  flex-shrink: 0;
  gap: 8px;
}

.conflict-message {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conflict-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.conflict-btn {
  background: transparent;
  border: 1px solid #7a4f00;
  color: #ffcc00;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.conflict-btn:hover {
  background: #7a4f00;
  color: #ffffff;
}

.editor-content-area {
  flex-grow: 1;
  position: relative;
  overflow: hidden;
  height: 100%;
}

.editor-instance {
  width: 100%;
  height: 100%;
}

.editor-loading,
.editor-error,
.editor-placeholder {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
  color: #888888;
  font-size: 13px;
}

.editor-error {
  color: #f14c4c;
}
</style>
