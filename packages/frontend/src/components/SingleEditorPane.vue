<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch, defineExpose, nextTick, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import MarkdownViewToggle from './MarkdownViewToggle.vue';
import FileEditorTabs from './FileEditorTabs.vue';
import type { FileTab } from '../stores/fileEditor.store';
import { useSessionStore } from '../stores/session.store';
import { useSettingsStore } from '../stores/settings.store';
import { FILE_ENCODING_OPTIONS } from '../constants/fileEncodings';
import { isImageFilePath } from '../constants/fileTypes';
import type { SplitDirection, PaneId } from '../composables/useSplitEditor';

// 重型编辑器组件按需异步加载：未打开任何文件时不下载、不解析 3.7MB Monaco / CodeMirror / Markdown 引擎
const MonacoEditor = defineAsyncComponent(() => import('./MonacoEditor.vue'));
const MarkdownSplitEditor = defineAsyncComponent(() => import('./MarkdownSplitEditor.vue'));
const MobileSingleEditorPane = defineAsyncComponent(() => import('./MobileSingleEditorPane.vue'));
const ImageViewer = defineAsyncComponent(() => import('./ImageViewer.vue'));

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
  isSplitActive: {
    type: Boolean,
    default: false,
  },
  splitDirection: {
    type: String as PropType<SplitDirection>,
    default: 'horizontal',
  },
  isMobile: {
    type: Boolean,
    default: false,
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
  /**
   * 宿主会话当前是否处于可见激活态。
   * 多会话工作区用 v-show 常驻多个 LayoutRenderer，当后台隐藏会话收到共享编辑器标签时，
   * 绝不应在后台重复创建 N 份 MonacoEditor 与 Web Worker。
   */
  isHostActive: {
    type: Boolean,
    default: true,
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
  (e: 'split-editor', direction: SplitDirection, tabId?: string): void;
  (e: 'close-split', paneId: PaneId): void;
  (e: 'toggle-split-direction'): void;
}>();

const { t } = useI18n();
const sessionStore = useSessionStore();

// 活动标签
const activeTab = computed((): FileTab | null => {
  if (!props.activeTabId) return null;
  return props.tabs.find(tab => tab.id === props.activeTabId) ?? null;
});

// 当前活动标签所属会话的显示名称（避免切换终端会话时误显示新会话的主机名）
const activeTabSessionName = computed(() => {
  const tab = activeTab.value;
  if (tab?.sessionId) {
    const liveName = sessionStore.sessions.get(tab.sessionId)?.connectionName;
    if (liveName) return liveName;
  }
  return tab?.sessionName || props.sessionName || null;
});

// 读取进度百分比（只在大文件读取时出现，total 未知则不显示）
const loadPercent = computed(() => {
  const p = activeTab.value?.loadProgress;
  if (!p || !p.total || p.total <= 0) return null;
  return Math.min(100, Math.round((p.loaded / p.total) * 100));
});

// 本地编辑器内容缓冲
const localContent = ref('');
const encodingSelectRef = ref<HTMLSelectElement | null>(null);

// 编辑器引用
const monacoEditorRef = ref<any>(null);
const mobileSingleEditorPaneRef = ref<any>(null);

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
  return props.isMobile
    ? settingsStore.markdownDefaultViewModeMobileString
    : settingsStore.markdownDefaultViewModeString;
};

const markdownViewMode = ref<'split' | 'edit' | 'preview'>(getDefaultMarkdownViewMode());
const SYNC_SCROLL_STORAGE_KEY = 'nexus_markdown_sync_scroll_enabled';
const isSyncScrollEnabled = ref<boolean>(localStorage.getItem(SYNC_SCROLL_STORAGE_KEY) !== 'false');

watch(isSyncScrollEnabled, (newVal) => {
  localStorage.setItem(SYNC_SCROLL_STORAGE_KEY, String(newVal));
});

// 当切换或打开 tab 时，如果是 Markdown 文件，应用该 tab 的视图模式（若未记录则赋予默认模式）
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

// 用户手动切换视图模式时，记住当前 tab 的偏好
watch(markdownViewMode, (newMode) => {
  if (activeTab.value?.id && isMarkdownFile.value) {
    tabMarkdownViewModeMap.value[activeTab.value.id] = newMode;
  }
});

// 编码选项
const encodingOptions = FILE_ENCODING_OPTIONS;
const currentSelectedEncoding = computed(() => activeTab.value?.selectedEncoding ?? 'utf-8');

// 动态测量编码下拉框宽度
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

    // 加大宽度并确保有舒适的呼吸空间与箭头空位 (移动端自适应紧凑宽度)
    const minW = props.isMobile ? 68 : 86;
    const paddingW = props.isMobile ? 22 : 36;
    select.style.width = `${Math.max(minW, textWidth + paddingW)}px`;
  });
};

// 侦听 activeTab 变化同步内容与编码
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

// 侦听本地内容变动通知父层
watch(localContent, (newContent) => {
  if (activeTab.value && newContent !== activeTab.value.content) {
    emit('update-content', { tabId: activeTab.value.id, content: newContent });
  }
});

// 事件处理
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

// 聚焦当前活动编辑器
const focusActiveEditor = (): boolean => {
  if (props.isMobile) {
    return mobileSingleEditorPaneRef.value?.focusActiveEditor() ?? false;
  }
  if (monacoEditorRef.value) {
    monacoEditorRef.value.focus();
    return true;
  }
  return false;
};

defineExpose({
  focusActiveEditor,
  openSearch: () => {
    if (props.isMobile) {
      mobileSingleEditorPaneRef.value?.openSearch();
    } else if (isMarkdownFile.value) {
      (monacoEditorRef.value as any)?.openSearch?.();
    }
  },
  toggleSearch: () => {
    if (props.isMobile) {
      mobileSingleEditorPaneRef.value?.toggleSearch();
    } else if (isMarkdownFile.value) {
      (monacoEditorRef.value as any)?.toggleSearch?.();
    }
  },
});
</script>

<template>
  <!-- 移动端专属拆分单文件编辑器面板组件 -->
  <MobileSingleEditorPane
    v-if="props.isMobile"
    ref="mobileSingleEditorPaneRef"
    :pane-id="props.paneId"
    :tabs="props.tabs"
    :active-tab-id="props.activeTabId"
    :session-name="props.sessionName"
    :font-family="props.fontFamily"
    :font-size="props.fontSize"
    @activate-tab="(id: string) => emit('activate-tab', id)"
    @close-tab="(id: string) => emit('close-tab', id)"
    @close-other-tabs="(id: string) => emit('close-other-tabs', id)"
    @close-tabs-to-right="(id: string) => emit('close-tabs-to-right', id)"
    @close-tabs-to-left="(id: string) => emit('close-tabs-to-left', id)"
    @update-content="(payload) => emit('update-content', payload)"
    @save-tab="(id: string) => emit('save-tab', id)"
    @change-encoding="(payload) => emit('change-encoding', payload)"
    @update-scroll="(payload) => emit('update-scroll', payload)"
    @update-font-size="(size) => emit('update-font-size', size)"
    @resolve-conflict-reload="(id: string) => emit('resolve-conflict-reload', id)"
    @resolve-conflict-overwrite="(id: string) => emit('resolve-conflict-overwrite', id)"
    @resolve-conflict-ignore="(id: string) => emit('resolve-conflict-ignore', id)"
  >
    <template #header-actions>
      <slot name="header-actions"></slot>
    </template>
  </MobileSingleEditorPane>

  <!-- 桌面端全功能单文件编辑器面板 -->
  <div v-else class="single-editor-pane" :class="[`pane-${props.paneId}`, { 'is-split-child': props.isSplitActive }]">
    <!-- 1. 标签栏 -->
    <FileEditorTabs
      :tabs="props.tabs"
      :active-tab-id="props.activeTabId"
      :is-mobile="false"
      @activate-tab="(id: string) => emit('activate-tab', id)"
      @close-tab="(id: string) => emit('close-tab', id)"
      @close-other-tabs="(id: string) => emit('close-other-tabs', id)"
      @close-tabs-to-right="(id: string) => emit('close-tabs-to-right', id)"
      @close-tabs-to-left="(id: string) => emit('close-tabs-to-left', id)"
      @split-right="(id: string) => emit('split-editor', 'horizontal', id)"
      @split-down="(id: string) => emit('split-editor', 'vertical', id)"
    />

    <!-- 2. 编辑器工具头部 -->
    <div v-if="activeTab" class="editor-header">
      <div class="file-info-title">
        <span class="file-path-text" :title="activeTab.filePath">
          {{ t('fileManager.editingFile') }}<template v-if="activeTabSessionName">({{ activeTabSessionName }})</template>: {{ activeTab.filePath }}
        </span>
        <span v-if="activeTab.isModified" class="modified-indicator">*</span>
      </div>

      <div class="editor-actions">
        <!-- Markdown 工具栏 -->
        <MarkdownViewToggle
          v-if="isMarkdownFile && !activeTab.isLoading"
          v-model:view-mode="markdownViewMode"
          v-model:sync-scroll="isSyncScrollEnabled"
        />

        <!-- 编码下拉框与保存按钮 (文本文件专用) -->
        <template v-if="!isImageFile">
          <div v-if="!activeTab.isLoading" class="encoding-select-wrapper">
            <select
              ref="encodingSelectRef"
              :value="currentSelectedEncoding"
              class="encoding-select"
              :title="t('fileManager.changeEncodingTooltip', '更改文件编码')"
              @change="handleEncodingChange"
            >
              <option v-for="opt in encodingOptions" :key="opt.value" :value="opt.value">
                {{ opt.text }}
              </option>
            </select>
          </div>
          <span v-else class="encoding-select-placeholder">{{ t('fileManager.loadingEncoding', '加载中...') }}</span>

          <!-- 保存状态反馈 (桌面端展示文本) -->
          <span v-if="activeTab.saveStatus === 'saving'" class="save-status saving">{{ t('fileManager.saving') }}...</span>
          <span v-if="activeTab.saveStatus === 'success'" class="save-status success">✅ {{ t('fileManager.saveSuccess') }}</span>
          <span v-if="activeTab.saveStatus === 'error'" class="save-status error">❌ {{ t('fileManager.saveError') }}: {{ activeTab.saveError }}</span>

          <!-- 保存按钮 -->
          <button
            class="save-btn"
            :disabled="activeTab.isSaving || activeTab.isLoading || !!activeTab.loadingError || !activeTab.isModified"
            @click="handleSave"
          >
            <span>{{ t('fileManager.actions.save') }}</span>
          </button>
        </template>

        <!-- VSCode 风格的分屏操作按钮组 -->
        <div class="split-controls-group">
          <!-- 未分屏时：展示向右拆分与向下拆分按钮 -->
          <template v-if="!props.isSplitActive">
            <button
              class="action-icon-btn split-btn"
              :title="t('editor.splitRight', '向右拆分编辑器 (Split Editor Right)')"
              @click="emit('split-editor', 'horizontal', activeTab?.id)"
            >
              <svg class="split-icon" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2">
                <rect x="1.5" y="2" width="13" height="12" rx="1.5" />
                <line x1="8" y1="2" x2="8" y2="14" />
              </svg>
            </button>
            <button
              class="action-icon-btn split-btn"
              :title="t('editor.splitDown', '向下拆分编辑器 (Split Editor Down)')"
              @click="emit('split-editor', 'vertical', activeTab?.id)"
            >
              <svg class="split-icon" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2">
                <rect x="1.5" y="2" width="13" height="12" rx="1.5" />
                <line x1="1.5" y1="8" x2="14.5" y2="8" />
              </svg>
            </button>
          </template>

          <!-- 分屏开启时：展示切换拆分方向与关闭分屏按钮 -->
          <template v-else>
            <button
              class="action-icon-btn split-btn"
              :title="t('editor.toggleSplitDirection', '切换水平/垂直拆分方向')"
              @click="emit('toggle-split-direction')"
            >
              <i class="fas fa-sync-alt"></i>
            </button>
            <button
              class="action-icon-btn close-split-btn"
              :title="t('editor.closeSplit', '关闭此拆分窗格')"
              @click="emit('close-split', props.paneId)"
            >
              <i class="fas fa-times"></i>
            </button>
          </template>
        </div>

        <!-- 外部扩展按钮插槽 (例如 Overlay 关闭弹窗) -->
        <slot name="header-actions"></slot>
      </div>
    </div>

    <!-- 无活动标签占位头部 -->
    <div v-else class="editor-header editor-header-placeholder">
      <span>{{ t('fileManager.noOpenFile') }}</span>
      <div class="editor-actions">
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
      <div v-if="activeTab?.isLoading" class="editor-loading">
        {{ t('fileManager.loadingFile') }}
        <span v-if="loadPercent !== null" class="ml-1 opacity-70">({{ loadPercent }}%)</span>
      </div>
      <div v-else-if="activeTab?.loadingError" class="editor-error">{{ activeTab.loadingError }}</div>

      <!-- 图片专用视图 -->
      <ImageViewer
        v-else-if="props.isHostActive && activeTab && isImageFile"
        :key="`img-${activeTab.id}-${props.paneId}`"
        :tab="activeTab"
      />

      <!-- Markdown 视图 (含分屏预览) -->
      <MarkdownSplitEditor
        v-else-if="props.isHostActive && activeTab && isMarkdownFile"
        ref="monacoEditorRef"
        :key="`md-${activeTab.id}-${props.paneId}`"
        v-model="localContent"
        :language="activeTab.language"
        :font-family="props.fontFamily"
        :font-size="props.fontSize"
        :view-mode="markdownViewMode"
        :sync-scroll="isSyncScrollEnabled"
        :initial-scroll-top="activeTab.scrollTop ?? 0"
        :initial-scroll-left="activeTab.scrollLeft ?? 0"
        :is-mobile="false"
        @request-save="handleSave"
        @update:font-size="handleFontSizeUpdate"
        @update:scroll-position="handleEditorScroll"
      />

      <!-- 桌面端 Monaco Editor（仅当前可见会话实例化，防止多会话叠加创建 N 份 Monaco + Worker） -->
      <MonacoEditor
        v-else-if="props.isHostActive && activeTab"
        ref="monacoEditorRef"
        :key="`monaco-${activeTab.id}-${props.paneId}`"
        v-model="localContent"
        :language="activeTab.language"
        :font-family="props.fontFamily"
        :font-size="props.fontSize"
        theme="vs-dark"
        class="editor-instance"
        :initial-scroll-top="activeTab.scrollTop ?? 0"
        :initial-scroll-left="activeTab.scrollLeft ?? 0"
        @request-save="handleSave"
        @update:font-size="handleFontSizeUpdate"
        @update:scroll-position="handleEditorScroll"
      />

      <!-- 后台隐藏态轻量占位（保持 DOM 结构零重排，不占 Monaco 内存） -->
      <div v-else-if="activeTab" class="editor-placeholder"></div>

      <!-- 空白占位 -->
      <div v-else class="editor-placeholder">{{ t('fileManager.selectFileToEdit') }}</div>
    </div>
  </div>
</template>

<style scoped>
.single-editor-pane {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
  background-color: var(--nexus-bg-primary, #1e1e1e);
}

.editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 10px;
  background-color: #252526;
  border-bottom: 1px solid #333333;
  font-size: 12px;
  color: #cccccc;
  flex-shrink: 0;
  min-height: 32px;
}

.file-info-title {
  display: flex;
  align-items: center;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  margin-right: 8px;
}

.file-path-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.modified-indicator {
  color: #e2b340;
  margin-left: 4px;
  font-weight: bold;
}

.editor-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.split-controls-group {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-left: 2px;
  padding-left: 4px;
  border-left: 1px solid #3c3c3c;
}

.action-icon-btn {
  background: transparent;
  border: 1px solid transparent;
  color: #858585;
  cursor: pointer;
  padding: 3px 6px;
  font-size: 12px;
  line-height: 1;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}

.action-icon-btn:hover {
  background-color: rgba(255, 255, 255, 0.1);
  color: #ffffff;
}

.action-icon-btn.split-btn:hover {
  color: #58a6ff;
}

.action-icon-btn.close-split-btn:hover {
  color: #f85149;
}

.split-icon {
  display: block;
  pointer-events: none;
}

.encoding-select-wrapper {
  display: inline-flex;
  align-items: center;
  vertical-align: middle;
}

.encoding-select {
  box-sizing: border-box;
  height: 22px;
  min-width: 86px;
  background-color: #3c3c3c;
  color: #cccccc;
  border: 1px solid #555555;
  padding: 0 16px 0 8px;
  font-size: 11px;
  border-radius: 3px;
  cursor: pointer;
  line-height: 20px;
  outline: none;
  display: inline-flex;
  align-items: center;
  transition: border-color 0.15s ease;
}

.encoding-select:focus {
  border-color: #007acc;
}

.encoding-select-placeholder {
  font-size: 11px;
  color: #888888;
}

.save-status {
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 2px;
}

.save-status.saving {
  color: #e2b340;
}

.save-status.success {
  color: #89d185;
}

.save-status.error {
  color: #f14c4c;
}

.save-btn {
  box-sizing: border-box;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background-color: #0e639c;
  color: white;
  border: 1px solid transparent;
  padding: 0 10px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  border-radius: 3px;
  line-height: 20px;
  transition: background-color 0.15s, border-color 0.15s;
}

.save-btn:hover:not(:disabled) {
  background-color: #1177bb;
}

.save-btn:disabled {
  background-color: #3a3d41;
  color: #6a6a6a;
  cursor: not-allowed;
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
