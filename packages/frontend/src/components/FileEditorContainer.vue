<script setup lang="ts">
import { computed, type PropType, ref, watch, defineExpose, onMounted, onBeforeUnmount, nextTick } from 'vue'; // 添加 nextTick
import { useI18n } from 'vue-i18n';
import MonacoEditor from './MonacoEditor.vue'; 
import MarkdownSplitEditor from './MarkdownSplitEditor.vue';
import MarkdownViewToggle from './MarkdownViewToggle.vue';
import ImageViewer from './ImageViewer.vue';
import FileEditorTabs from './FileEditorTabs.vue';
import { useFileEditorStore, type FileTab } from '../stores/fileEditor.store'; 
import { useFocusSwitcherStore } from '../stores/focusSwitcher.store';
import { useSessionStore } from '../stores/session.store';
import { useSettingsStore } from '../stores/settings.store';
import { useAppearanceStore } from '../stores/appearance.store'; // +++ 导入外观 Store +++
import { storeToRefs } from 'pinia';
import { useWorkspaceEventEmitter } from '../composables/workspaceEvents';
import { FILE_ENCODING_OPTIONS } from '../constants/fileEncodings';
import { isImageFilePath } from '../constants/fileTypes';

const { t } = useI18n();
const emitWorkspaceEvent = useWorkspaceEventEmitter(); // +++ 获取事件发射器 +++
const fileEditorStore = useFileEditorStore(); // +++ 实例化文件编辑器 Store +++
const focusSwitcherStore = useFocusSwitcherStore(); // +++ 实例化焦点切换 Store +++
const sessionStore = useSessionStore(); // +++ 实例化会话 Store +++
const settingsStore = useSettingsStore(); // +++ 实例化设置 Store +++
const appearanceStore = useAppearanceStore(); // +++ 实例化外观 Store +++
const { shareFileEditorTabsBoolean } = storeToRefs(settingsStore); // +++ 获取共享设置 +++
const { currentEditorFontFamily, currentEditorFontSize } = storeToRefs(appearanceStore);

// 外部冲突解决动作
const handleResolveReload = async () => {
  if (!activeTab.value) return;
  const tabId = activeTab.value.id;
  if (!shareFileEditorTabsBoolean.value && props.sessionId) {
    await sessionStore.resolveConflictReloadInSession(props.sessionId, tabId);
    if (activeTab.value) {
      localEditorContent.value = activeTab.value.content;
    }
  } else {
    await fileEditorStore.resolveConflictReload(tabId);
    if (activeTab.value) {
      localEditorContent.value = activeTab.value.content;
    }
  }
};

const handleResolveOverwrite = async () => {
  if (!activeTab.value) return;
  const tabId = activeTab.value.id;
  if (!shareFileEditorTabsBoolean.value && props.sessionId) {
    await sessionStore.resolveConflictOverwriteInSession(props.sessionId, tabId);
  } else {
    await fileEditorStore.resolveConflictOverwrite(tabId);
  }
};

const handleResolveIgnore = () => {
  if (!activeTab.value) return;
  const tabId = activeTab.value.id;
  if (!shareFileEditorTabsBoolean.value && props.sessionId) {
    sessionStore.resolveConflictIgnoreInSession(props.sessionId, tabId);
  } else {
    fileEditorStore.resolveConflictIgnore(tabId);
  }
};
 
// --- Props ---
const props = defineProps({
  tabs: {
    type: Array as PropType<FileTab[]>,
    required: true,
  },
  activeTabId: {
    type: String as PropType<string | null>,
    default: null,
  },
  sessionId: { // 需要 sessionId 来区分保存请求等 (虽然 tabs 里也有)
    type: String as PropType<string | null>,
    default: null,
  },
});




// --- 计算属性，用于模板绑定 ---
const activeTab = computed((): FileTab | null => {
  if (!props.activeTabId) return null;
  return props.tabs.find(tab => tab.id === props.activeTabId) ?? null;
});

// Monaco Editor 的 v-model 处理
const localEditorContent = ref('');
const encodingSelectRef = ref<HTMLSelectElement | null>(null); // Ref for the select element

// Function to calculate and set the select width
const updateSelectWidth = () => {
  nextTick(() => { // Ensure DOM is updated before measuring
    if (!encodingSelectRef.value) return;

    const selectElement = encodingSelectRef.value;
    const selectedOption = selectElement.options[selectElement.selectedIndex];

    if (!selectedOption) return;

    // Create a temporary span to measure text width
    const tempSpan = document.createElement('span');
    // Copy relevant styles (adjust as needed for accurate measurement)
    const styles = window.getComputedStyle(selectElement);
    tempSpan.style.fontSize = styles.fontSize;
    tempSpan.style.fontFamily = styles.fontFamily;
    tempSpan.style.fontWeight = styles.fontWeight;
    tempSpan.style.letterSpacing = styles.letterSpacing;
    tempSpan.style.paddingLeft = styles.paddingLeft; // Include padding for accuracy
    tempSpan.style.paddingRight = styles.paddingRight;
    // tempSpan.style.borderLeftWidth = styles.borderLeftWidth; // Border might not be needed for width calc
    // tempSpan.style.borderRightWidth = styles.borderRightWidth;
    tempSpan.style.visibility = 'hidden'; // Make it invisible
    tempSpan.style.position = 'absolute'; // Prevent layout shift
    tempSpan.style.whiteSpace = 'nowrap'; // Prevent wrapping
    tempSpan.style.left = '-9999px'; // Move off-screen

    tempSpan.textContent = selectedOption.text;
    document.body.appendChild(tempSpan);

    const textWidth = tempSpan.offsetWidth;
    document.body.removeChild(tempSpan);

    // Set the select width (add extra space for dropdown arrow, adjust as needed)
    const arrowPadding = 25; // Increased padding for arrow and visual spacing
    selectElement.style.width = `${textWidth + arrowPadding}px`;
    // console.log(`[EditorContainer] Setting select width for "${selectedOption.text}" to ${textWidth + arrowPadding}px`);
  });
};


// 监听 activeTab 的变化，重置 localEditorContent 并更新 select 宽度
watch(activeTab, (newTab) => {
    // console.log('[EditorContainer] Active tab changed, updating local content.');
    localEditorContent.value = newTab?.content ?? '';
    updateSelectWidth(); // Update select width when tab changes
}, { immediate: true }); // immediate: true ensures it runs on initial load too

// 移除用于调试的 watch 函数
// 当本地编辑器内容变化时，通知父组件 (WorkspaceView)
watch(localEditorContent, (newContent) => {
    // console.log('[EditorContainer] Local content changed, checking if emit needed.');
    if (activeTab.value && newContent !== activeTab.value.content) {
        // console.log(`[EditorContainer] Emitting update:content for tab ${activeTab.value.id}`);
        // 只有当内容实际改变时才发出事件
        emitWorkspaceEvent('editor:updateContent', { tabId: activeTab.value.id, content: newContent });
        // 注意：isModified 状态应该由 Store 根据 content 和 originalContent 计算
    }
});

// orderedTabs 直接使用 props
const orderedTabs = computed(() => props.tabs);


const currentTabIsLoading = computed(() => activeTab.value?.isLoading ?? false);
const currentTabLoadingError = computed(() => activeTab.value?.loadingError ?? null);
const currentTabIsSaving = computed(() => activeTab.value?.isSaving ?? false);
const currentTabSaveStatus = computed(() => activeTab.value?.saveStatus ?? 'idle');
const currentTabSaveError = computed(() => activeTab.value?.saveError ?? null);
const currentTabLanguage = computed(() => activeTab.value?.language ?? 'plaintext');
const currentTabFilePath = computed(() => activeTab.value?.filePath ?? '');
const currentTabIsModified = computed(() => activeTab.value?.isModified ?? false); // 用于显示修改状态
const currentSelectedEncoding = computed(() => activeTab.value?.selectedEncoding ?? 'utf-8');
const currentTabSessionName = computed(() => {
  const sessionId = activeTab.value?.sessionId;
  if (!sessionId) return null;
  return sessionStore.sessions.get(sessionId)?.connectionName ?? null;
});

// --- 图片文件判断 ---
const isImageFile = computed(() => {
  return isImageFilePath(activeTab.value?.filePath);
});

// --- Markdown 预览逻辑 ---
const isMarkdownFile = computed(() => {
  if (isImageFile.value) return false;
  if (!activeTab.value) return false;
  const path = activeTab.value.filePath || '';
  const ext = path.split('.').pop()?.toLowerCase();
  return ext === 'md' || ext === 'markdown' || ext === 'mdown' || currentTabLanguage.value === 'markdown';
});

// Markdown 视图模式: 'split' (双栏分屏) | 'edit' (仅源码) | 'preview' (仅渲染)
const markdownViewMode = ref<'split' | 'edit' | 'preview'>('split');
const SYNC_SCROLL_STORAGE_KEY = 'nexus_markdown_sync_scroll_enabled';
const isSyncScrollEnabled = ref<boolean>(localStorage.getItem(SYNC_SCROLL_STORAGE_KEY) !== 'false');

watch(isSyncScrollEnabled, (newVal) => {
  localStorage.setItem(SYNC_SCROLL_STORAGE_KEY, String(newVal));
});

// Watch for changes in the selected encoding to update width
watch(currentSelectedEncoding, () => {
  updateSelectWidth();
});

// 编码选项 (使用公共常量)
const encodingOptions = FILE_ENCODING_OPTIONS;


// --- 事件处理 ---
const handleSaveRequest = () => {
  if (activeTab.value) {
    emitWorkspaceEvent('editor:saveTab', { tabId: activeTab.value.id }); // 发出保存请求事件
  }
};

// +++ 处理编码更改事件 +++
const handleEncodingChange = (event: Event) => {
  const target = event.target as HTMLSelectElement;
  const newEncoding = target.value;
  if (activeTab.value && newEncoding && newEncoding !== currentSelectedEncoding.value) {
    console.log(`[EditorContainer] Encoding changed to ${newEncoding} for tab ${activeTab.value.id}`);
    emitWorkspaceEvent('editor:changeEncoding', { tabId: activeTab.value.id, encoding: newEncoding });
  }
};

// +++ 处理编辑器滚动事件 +++
const handleEditorScroll = ({ scrollTop, scrollLeft }: { scrollTop: number; scrollLeft: number }) => {
  if (activeTab.value) {
    emitWorkspaceEvent('editor:updateScrollPosition', {
      tabId: activeTab.value.id,
      scrollTop,
      scrollLeft,
    });
  }
};

// +++ 处理编辑器字体大小更新事件 +++
const handleEditorFontSizeUpdate = (newSize: number) => {
    appearanceStore.setEditorFontSize(newSize);
};


// 注意：关闭/最小化按钮现在应该在 WorkspaceView 控制 Pane，而不是这里
// const handleCloseContainer = () => { ... };
// const handleMinimizeContainer = () => { ... };

// 编辑器组件的引用 (支持普通 MonacoEditor 与 MarkdownSplitEditor)
const monacoEditorRef = ref<InstanceType<typeof MonacoEditor> | InstanceType<typeof MarkdownSplitEditor> | null>(null);

// 聚焦活动编辑器的方法
const focusActiveEditor = (): boolean => {
  if (monacoEditorRef.value) {
    monacoEditorRef.value.focus();
    return true; // 聚焦成功
  }
  return false; // 聚焦失败
};

// 暴露聚焦方法
defineExpose({ focusActiveEditor });

// +++ 注册/注销自定义聚焦动作 +++
let unregisterFocusFn: (() => void) | null = null; // 保存注销函数

onMounted(() => {
  // 注册动作并保存返回的注销函数
  unregisterFocusFn = focusSwitcherStore.registerFocusAction('fileEditorActive', focusActiveEditor);
  // +++ 键盘事件监听器 +++
  window.addEventListener('keydown', handleKeyDown);
});

onBeforeUnmount(() => {
  // 调用保存的注销函数（如果存在）
  if (unregisterFocusFn) {
    unregisterFocusFn();
  }
  // +++ 移除键盘事件监听器 +++
  window.removeEventListener('keydown', handleKeyDown);
});

// +++ 处理键盘事件以切换标签 +++
const handleKeyDown = (event: KeyboardEvent) => {
  // 检查是否在编辑器内部或其容器内触发（避免全局冲突）
  // 这里简化处理，假设只要此组件挂载就监听，更精确的判断可能需要检查 event.target
  if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    event.stopPropagation();

    if (!props.activeTabId || props.tabs.length <= 1) {
      return; // 没有活动标签或只有一个标签，无需切换
    }

    const currentIndex = props.tabs.findIndex(tab => tab.id === props.activeTabId);
    if (currentIndex === -1) {
      return; // 未找到当前标签索引
    }

    let nextIndex: number;
    if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + props.tabs.length) % props.tabs.length;
    } else { // ArrowRight
      nextIndex = (currentIndex + 1) % props.tabs.length;
    }

    const nextTabId = props.tabs[nextIndex]?.id;
    if (nextTabId) {
      emitWorkspaceEvent('editor:activateTab', { tabId: nextTabId });
    }
  }
};
</script>

<template>
  <!-- 这个容器不再控制自己的显示/隐藏，由 WorkspaceView 的 Pane 控制 -->
  <div class="file-editor-container">

      <!-- 1. 标签栏 -->
      <FileEditorTabs
        :tabs="orderedTabs"
        :active-tab-id="props.activeTabId"
        @activate-tab="(tabId: string) => emitWorkspaceEvent('editor:activateTab', { tabId })"
        @close-tab="(tabId: string) => emitWorkspaceEvent('editor:closeTab', { tabId })"
        @close-other-tabs="(tabId: string) => emitWorkspaceEvent('editor:closeOtherTabs', { tabId })"
        @close-tabs-to-right="(tabId: string) => emitWorkspaceEvent('editor:closeTabsToRight', { tabId })"
        @close-tabs-to-left="(tabId: string) => emitWorkspaceEvent('editor:closeTabsToLeft', { tabId })"
      />

      <!-- 2. 编辑器头部 (显示当前激活标签信息) -->
      <!-- 移除关闭/最小化按钮，这些由 WorkspaceView 控制 -->
      <div v-if="activeTab" class="editor-header">
        <span>
          {{ t('fileManager.editingFile') }}<template v-if="shareFileEditorTabsBoolean && currentTabSessionName">({{ currentTabSessionName }})</template>: {{ currentTabFilePath }}
          <span v-if="currentTabIsModified" class="modified-indicator">*</span>
        </span>
        <div class="editor-actions">
          <!-- Markdown 视图切换与同步滚动按钮组 -->
          <MarkdownViewToggle
            v-if="isMarkdownFile && !currentTabIsLoading"
            v-model:view-mode="markdownViewMode"
            v-model:sync-scroll="isSyncScrollEnabled"
          />

          <!-- +++ 编码选择下拉菜单 (仅文本文件展示) +++ -->
          <template v-if="!isImageFile">
            <div class="encoding-select-wrapper" v-if="activeTab && !currentTabIsLoading">
              <select
                ref="encodingSelectRef"
                :value="currentSelectedEncoding"
                @change="handleEncodingChange"
                class="encoding-select"
                :title="t('fileManager.changeEncodingTooltip', '更改文件编码')"
              >
                <option v-for="option in encodingOptions" :key="option.value" :value="option.value">
                  {{ option.text }}
                </option>
              </select>
            </div>
            <span v-else-if="activeTab" class="encoding-select-placeholder">{{ t('fileManager.loadingEncoding', '加载中...') }}</span>

            <span v-if="currentTabSaveStatus === 'saving'" class="save-status saving">{{ t('fileManager.saving') }}...</span>
            <span v-if="currentTabSaveStatus === 'success'" class="save-status success">✅ {{ t('fileManager.saveSuccess') }}</span>
            <span v-if="currentTabSaveStatus === 'error'" class="save-status error">❌ {{ t('fileManager.saveError') }}: {{ currentTabSaveError }}</span>
            <button @click="handleSaveRequest" :disabled="currentTabIsSaving || currentTabIsLoading || !!currentTabLoadingError || !activeTab || !currentTabIsModified" class="save-btn">
              {{ t('fileManager.actions.save') }}
            </button>
          </template>
        </div>
      </div>
      <!-- 如果没有活动标签页，显示简化头部 -->
      <div v-else class="editor-header editor-header-placeholder">
        <span>{{ t('fileManager.noOpenFile') }}</span>
        <!-- 动作区域留空或只显示通用按钮 -->
      </div>

      <!-- 外部修改冲突保护横幅 -->
      <div v-if="activeTab?.hasExternalConflict" class="conflict-banner">
        <div class="conflict-message">
          <i class="fas fa-exclamation-triangle"></i>
          <span>{{ t('fileManager.conflictWarning', '文件已在终端或远端被修改，本地有未保存内容。') }}</span>
        </div>
        <div class="conflict-actions">
          <button @click="handleResolveReload" class="conflict-btn reload-btn" :title="t('fileManager.conflictReloadTooltip', '放弃本地未保存更改，拉取远端最新内容')">
            {{ t('fileManager.actions.reloadRemote', '以远端内容载入') }}
          </button>
          <button @click="handleResolveOverwrite" class="conflict-btn overwrite-btn" :title="t('fileManager.conflictOverwriteTooltip', '将本地修改强制保存并覆盖远端')">
            {{ t('fileManager.actions.overwriteRemote', '覆盖保存到远端') }}
          </button>
          <button @click="handleResolveIgnore" class="conflict-btn ignore-btn" :title="t('fileManager.conflictIgnoreTooltip', '保留本地更改，暂不提示')">
            {{ t('common.ignore', '忽略') }}
          </button>
        </div>
      </div>

      <!-- 3. 编辑器内容区域 -->
      <div class="editor-content-area">
        <div v-if="currentTabIsLoading" class="editor-loading">{{ t('fileManager.loadingFile') }}</div>
        <div v-else-if="currentTabLoadingError" class="editor-error">{{ currentTabLoadingError }}</div>

        <!-- 图片专用视图 -->
        <ImageViewer
          v-else-if="activeTab && isImageFile"
          :key="`img-${activeTab.id}`"
          :tab="activeTab"
        />

        <!-- Markdown 专用视图 (内聚三种视图模式与平滑同步滚动) -->
        <MarkdownSplitEditor
          v-else-if="activeTab && isMarkdownFile"
          ref="monacoEditorRef"
          :key="`md-${activeTab.id}`"
          v-model="localEditorContent"
          :language="currentTabLanguage"
          :font-family="currentEditorFontFamily"
          :font-size="currentEditorFontSize"
          :view-mode="markdownViewMode"
          :sync-scroll="isSyncScrollEnabled"
          :initial-scroll-top="activeTab?.scrollTop ?? 0"
          :initial-scroll-left="activeTab?.scrollLeft ?? 0"
          @request-save="handleSaveRequest"
          @update:font-size="handleEditorFontSizeUpdate"
          @update:scroll-position="handleEditorScroll"
        />

        <!-- 普通非 Markdown 文件视图 -->
        <MonacoEditor
          v-else-if="activeTab"
          ref="monacoEditorRef"
          :key="activeTab.id"
          v-model="localEditorContent"
          :language="currentTabLanguage"
          :font-family="currentEditorFontFamily"
          :font-size="currentEditorFontSize"
          theme="vs-dark"
          class="editor-instance"
          @request-save="handleSaveRequest"
          @update:fontSize="handleEditorFontSizeUpdate"
          :initialScrollTop="activeTab?.scrollTop ?? 0"
          :initialScrollLeft="activeTab?.scrollLeft ?? 0"
          @update:scrollPosition="handleEditorScroll"
        />
        <div v-else class="editor-placeholder">{{ t('fileManager.selectFileToEdit') }}</div>
      </div>

  </div>
</template>

<style scoped>
/* 样式与 FileEditorOverlay 类似，但移除 backdrop 和 popup 结构 */
.file-editor-container {
  width: 100%;
  height: 100%; /* 填充父级 Pane */
  background-color: #2d2d2d; /* 编辑器背景 */
  display: flex;
  flex-direction: column;
  color: #f0f0f0;
  overflow: hidden; /* 重要：防止内容溢出 */
}

/* 标签栏区域 */
/* FileEditorTabs 组件自带样式 */

.editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem 1rem;
  background-color: #333;
  border-bottom: 1px solid #555;
  font-size: 0.9em;
  flex-shrink: 0;
}
.editor-header-placeholder {
    justify-content: flex-start; /* 左对齐提示文本 */
    color: #888;
}

.modified-indicator {
    color: #ffeb3b;
    margin-left: 4px;
    font-weight: bold;
}

/* 编辑器内容区域 */
.editor-content-area {
    flex-grow: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
}

.editor-loading, .editor-error, .editor-placeholder {
  padding: 2rem;
  text-align: center;
  font-size: 1.1em;
  flex-grow: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #888;
}
.editor-error { color: #ff8a8a; }
.editor-placeholder { color: #666; }

.editor-actions {
    display: flex;
    align-items: center;
    gap: 0.8rem;
}
/* 移动端响应式调整 */
@media (max-width: 768px) {
  .editor-header {
    flex-direction: column; 
    align-items: flex-start;
  }

  .editor-header > span:first-of-type {
    margin-bottom: 0.5rem; 
  }

  .editor-actions {
    width: 100%; 
    justify-content: flex-start; 
  }

}

.save-btn {
    background-color: #4CAF50;
    color: white;
    border: none;
    padding: 0.4rem 0.8rem;
    cursor: pointer;
    border-radius: 3px;
    font-size: 0.9em;
}
.save-btn:disabled { background-color: #aaa; cursor: not-allowed; }
.save-btn:hover:not(:disabled) { background-color: #45a049; }

.save-status {
    font-size: 0.9em;
    padding: 0.2rem 0.5rem;
    border-radius: 3px;
    white-space: nowrap;
}
.save-status.saving { color: #888; }
.save-status.success { color: #4CAF50; background-color: #e8f5e9; }
.save-status.error { color: #f44336; background-color: #ffebee; }

.editor-instance {
  flex-grow: 1;
  min-height: 0;
}
</style>

<style scoped> /* Add new styles below existing scoped styles */
.encoding-select-wrapper {
  display: inline-block; /* 让 wrapper 包裹内容 */
  vertical-align: middle; /* 垂直居中对齐 */
}

.encoding-select {
  background-color: #444;
  color: #f0f0f0;
  border: 1px solid #666;
  padding: 0.3rem 0.5rem; /* 恢复内边距 */
  border-radius: 3px;
  font-size: 0.85em;
  cursor: pointer;
  outline: none;
  /* width: auto; */ /* JS will control width via style property */
  /* 移除 flex-shrink */
  /* 确保没有其他样式覆盖，例如内联样式或更高优先级的选择器 */
}

.encoding-select:hover {
  background-color: #555;
}

.encoding-select:focus {
  border-color: #888;
}

.encoding-select-placeholder {
    font-size: 0.85em;
    color: #888;
    padding: 0.3rem 0.5rem;
    display: inline-block;
    min-width: 80px; /* 与 select 大致对齐 */
    text-align: center;
}

.conflict-banner {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.4rem 0.8rem;
  background-color: rgba(245, 158, 11, 0.15);
  border-bottom: 1px solid rgba(245, 158, 11, 0.35);
  color: #fcd34d;
  font-size: 0.8rem;
  flex-shrink: 0;
  gap: 0.5rem;
}
.conflict-message {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.conflict-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.conflict-btn {
  padding: 0.2rem 0.6rem;
  border-radius: 3px;
  font-size: 0.75rem;
  cursor: pointer;
  border: none;
  transition: all 0.15s;
}
.conflict-btn.reload-btn {
  background-color: rgba(245, 158, 11, 0.25);
  color: #fef3c7;
  border: 1px solid rgba(245, 158, 11, 0.4);
}
.conflict-btn.reload-btn:hover {
  background-color: rgba(245, 158, 11, 0.4);
}
.conflict-btn.overwrite-btn {
  background-color: var(--primary-color, #3b82f6);
  color: #fff;
}
.conflict-btn.overwrite-btn:hover {
  background-color: var(--primary-color-dark, #2563eb);
}
.conflict-btn.ignore-btn {
  background: transparent;
  color: #fbbf24;
}
.conflict-btn.ignore-btn:hover {
  color: #fff;
}

</style>

