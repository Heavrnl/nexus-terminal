<script setup lang="ts">
import { computed, type PropType, ref, watch, defineExpose, onMounted, onBeforeUnmount, toRef } from 'vue';
import { storeToRefs } from 'pinia';
import SingleEditorPane from './SingleEditorPane.vue';
import { useFileEditorStore, type FileTab } from '../stores/fileEditor.store';
import { useFocusSwitcherStore } from '../stores/focusSwitcher.store';
import { useSessionStore } from '../stores/session.store';
import { useSettingsStore } from '../stores/settings.store';
import { useAppearanceStore } from '../stores/appearance.store';
import { useWorkspaceEventEmitter } from '../composables/workspaceEvents';
import { useSplitEditor, type SplitDirection, type PaneId } from '../composables/useSplitEditor';

const props = defineProps({
  tabs: {
    type: Array as PropType<FileTab[]>,
    required: true,
  },
  activeTabId: {
    type: String as PropType<string | null>,
    default: null,
  },
  sessionId: {
    type: String as PropType<string | null>,
    default: null,
  },
});

const emitWorkspaceEvent = useWorkspaceEventEmitter();
const fileEditorStore = useFileEditorStore();
const focusSwitcherStore = useFocusSwitcherStore();
const sessionStore = useSessionStore();
const settingsStore = useSettingsStore();
const appearanceStore = useAppearanceStore();

const { shareFileEditorTabsBoolean } = storeToRefs(settingsStore);
const { currentEditorFontFamily, currentEditorFontSize } = storeToRefs(appearanceStore);

// 主容器 DOM 引用用于分屏拖拽
const containerRef = ref<HTMLDivElement | null>(null);
const primaryPaneRef = ref<InstanceType<typeof SingleEditorPane> | null>(null);
const secondaryPaneRef = ref<InstanceType<typeof SingleEditorPane> | null>(null);

// 初始化分屏状态管理
const tabsRef = toRef(props, 'tabs');
const {
  isSplitActive,
  splitDirection,
  primaryActiveTabId,
  secondaryActiveTabId,
  activePaneId,
  isResizing,
  openSplit,
  closeSplit,
  toggleSplitDirection,
  resetSplitRatio,
  startSplitResize,
  syncTabsAfterClose,
  primaryPaneStyle,
  secondaryPaneStyle,
} = useSplitEditor(tabsRef, { storagePrefix: 'nexus_workspace_editor' });

// 保持 primaryActiveTabId 与 props.activeTabId 同步
watch(
  () => props.activeTabId,
  (newId) => {
    if (newId) {
      primaryActiveTabId.value = newId;
    }
  },
  { immediate: true }
);

// 会话显示名称
const currentSessionName = computed(() => {
  if (!props.sessionId) return null;
  return sessionStore.sessions.get(props.sessionId)?.connectionName ?? null;
});

// 处理主/副窗格的标签激活
const handleActivateTab = (paneId: PaneId, tabId: string) => {
  if (paneId === 'primary') {
    primaryActiveTabId.value = tabId;
    emitWorkspaceEvent('editor:activateTab', { tabId });
  } else {
    secondaryActiveTabId.value = tabId;
  }
  activePaneId.value = paneId;
};

// 标签关闭处理
const handleCloseTab = (tabId: string) => {
  syncTabsAfterClose(tabId);
  emitWorkspaceEvent('editor:closeTab', { tabId });
};

const handleCloseOtherTabs = (tabId: string) => {
  emitWorkspaceEvent('editor:closeOtherTabs', { tabId });
};

const handleCloseTabsToRight = (tabId: string) => {
  emitWorkspaceEvent('editor:closeTabsToRight', { tabId });
};

const handleCloseTabsToLeft = (tabId: string) => {
  emitWorkspaceEvent('editor:closeTabsToLeft', { tabId });
};

// 内容变更通知
const handleUpdateContent = ({ tabId, content }: { tabId: string; content: string }) => {
  emitWorkspaceEvent('editor:updateContent', { tabId, content });
};

// 保存请求
const handleSaveTab = (tabId: string) => {
  emitWorkspaceEvent('editor:saveTab', { tabId });
};

// 编码切换
const handleChangeEncoding = ({ tabId, encoding }: { tabId: string; encoding: string }) => {
  emitWorkspaceEvent('editor:changeEncoding', { tabId, encoding });
};

// 滚动同步
const handleUpdateScroll = ({ tabId, scrollTop, scrollLeft }: { tabId: string; scrollTop: number; scrollLeft: number }) => {
  emitWorkspaceEvent('editor:updateScrollPosition', { tabId, scrollTop, scrollLeft });
};

// 字号调整
const handleUpdateFontSize = (newSize: number) => {
  appearanceStore.setEditorFontSize(newSize);
};

// 外部变动冲突解决
const handleResolveReload = async (tabId: string) => {
  if (!shareFileEditorTabsBoolean.value && props.sessionId) {
    await sessionStore.resolveConflictReloadInSession(props.sessionId, tabId);
  } else {
    await fileEditorStore.resolveConflictReload(tabId);
  }
};

const handleResolveOverwrite = async (tabId: string) => {
  if (!shareFileEditorTabsBoolean.value && props.sessionId) {
    await sessionStore.resolveConflictOverwriteInSession(props.sessionId, tabId);
  } else {
    await fileEditorStore.resolveConflictOverwrite(tabId);
  }
};

const handleResolveIgnore = (tabId: string) => {
  if (!shareFileEditorTabsBoolean.value && props.sessionId) {
    sessionStore.resolveConflictIgnoreInSession(props.sessionId, tabId);
  } else {
    fileEditorStore.resolveConflictIgnore(tabId);
  }
};

// 触发分屏
const handleSplitEditor = (direction: SplitDirection, tabId?: string) => {
  openSplit(direction, tabId);
};

// 拖拽分屏分割线
const handleResizerMouseDown = (e: MouseEvent) => {
  if (containerRef.value) {
    startSplitResize(e, containerRef.value);
  }
};

// 聚焦活动编辑器
const focusActiveEditor = (): boolean => {
  if (activePaneId.value === 'secondary' && secondaryPaneRef.value) {
    return secondaryPaneRef.value.focusActiveEditor();
  }
  if (primaryPaneRef.value) {
    return primaryPaneRef.value.focusActiveEditor();
  }
  return false;
};

defineExpose({ focusActiveEditor });

// 快捷键监听 (Alt+方向键切换标签，Ctrl+\ 分屏)
const handleKeyDown = (event: KeyboardEvent) => {
  // Ctrl+\ 触发向右分屏 / 切换分屏
  if (event.ctrlKey && event.key === '\\') {
    event.preventDefault();
    if (!isSplitActive.value) {
      openSplit('horizontal', primaryActiveTabId.value);
    } else {
      toggleSplitDirection();
    }
    return;
  }

  // Alt + 左右方向键在当前窗格切换标签
  if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    event.stopPropagation();

    if (props.tabs.length <= 1) return;

    const currentTabId = activePaneId.value === 'secondary' ? secondaryActiveTabId.value : primaryActiveTabId.value;
    const currentIndex = props.tabs.findIndex(tab => tab.id === currentTabId);
    if (currentIndex === -1) return;

    let nextIndex: number;
    if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + props.tabs.length) % props.tabs.length;
    } else {
      nextIndex = (currentIndex + 1) % props.tabs.length;
    }

    const nextTabId = props.tabs[nextIndex]?.id;
    if (nextTabId) {
      handleActivateTab(activePaneId.value, nextTabId);
    }
  }
};

let unregisterFocusFn: (() => void) | null = null;

onMounted(() => {
  unregisterFocusFn = focusSwitcherStore.registerFocusAction('fileEditorActive', focusActiveEditor);
  window.addEventListener('keydown', handleKeyDown);
});

onBeforeUnmount(() => {
  if (unregisterFocusFn) unregisterFocusFn();
  window.removeEventListener('keydown', handleKeyDown);
});
</script>

<template>
  <div
    ref="containerRef"
    class="file-editor-container"
    :class="[splitDirection, { 'is-split-mode': isSplitActive, 'is-resizing': isResizing }]"
  >
    <!-- 主窗格 -->
    <div
      class="editor-pane-wrapper primary-wrapper"
      :style="primaryPaneStyle"
      @mousedown="activePaneId = 'primary'"
    >
      <SingleEditorPane
        ref="primaryPaneRef"
        pane-id="primary"
        :tabs="props.tabs"
        :active-tab-id="primaryActiveTabId"
        :is-split-active="isSplitActive"
        :split-direction="splitDirection"
        :session-name="currentSessionName"
        :font-family="currentEditorFontFamily"
        :font-size="currentEditorFontSize"
        @activate-tab="(id: string) => handleActivateTab('primary', id)"
        @close-tab="handleCloseTab"
        @close-other-tabs="handleCloseOtherTabs"
        @close-tabs-to-right="handleCloseTabsToRight"
        @close-tabs-to-left="handleCloseTabsToLeft"
        @update-content="handleUpdateContent"
        @save-tab="handleSaveTab"
        @change-encoding="handleChangeEncoding"
        @update-scroll="handleUpdateScroll"
        @update-font-size="handleUpdateFontSize"
        @resolve-conflict-reload="handleResolveReload"
        @resolve-conflict-overwrite="handleResolveOverwrite"
        @resolve-conflict-ignore="handleResolveIgnore"
        @split-editor="handleSplitEditor"
        @close-split="closeSplit"
        @toggle-split-direction="toggleSplitDirection"
      />
    </div>

    <!-- 可拖拽分割条 (仅在分屏激活时展示) -->
    <div
      v-if="isSplitActive"
      class="editor-split-resizer"
      :class="splitDirection"
      :title="'双击重置为 50% 对等分屏，拖拽调整比例'"
      @mousedown="handleResizerMouseDown"
      @dblclick="resetSplitRatio"
    >
      <div class="resizer-line"></div>
    </div>

    <!-- 次级窗格 (仅在分屏激活时展示) -->
    <div
      v-if="isSplitActive"
      class="editor-pane-wrapper secondary-wrapper"
      :style="secondaryPaneStyle"
      @mousedown="activePaneId = 'secondary'"
    >
      <SingleEditorPane
        ref="secondaryPaneRef"
        pane-id="secondary"
        :tabs="props.tabs"
        :active-tab-id="secondaryActiveTabId"
        :is-split-active="isSplitActive"
        :split-direction="splitDirection"
        :session-name="currentSessionName"
        :font-family="currentEditorFontFamily"
        :font-size="currentEditorFontSize"
        @activate-tab="(id: string) => handleActivateTab('secondary', id)"
        @close-tab="handleCloseTab"
        @close-other-tabs="handleCloseOtherTabs"
        @close-tabs-to-right="handleCloseTabsToRight"
        @close-tabs-to-left="handleCloseTabsToLeft"
        @update-content="handleUpdateContent"
        @save-tab="handleSaveTab"
        @change-encoding="handleChangeEncoding"
        @update-scroll="handleUpdateScroll"
        @update-font-size="handleUpdateFontSize"
        @resolve-conflict-reload="handleResolveReload"
        @resolve-conflict-overwrite="handleResolveOverwrite"
        @resolve-conflict-ignore="handleResolveIgnore"
        @split-editor="handleSplitEditor"
        @close-split="closeSplit"
        @toggle-split-direction="toggleSplitDirection"
      />
    </div>
  </div>
</template>

<style scoped>
.file-editor-container {
  display: flex;
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
  background-color: var(--nexus-bg-primary, #1e1e1e);
}

.file-editor-container.horizontal {
  flex-direction: row;
}

.file-editor-container.vertical {
  flex-direction: column;
}

.editor-pane-wrapper {
  position: relative;
  overflow: hidden;
  min-width: 80px;
  min-height: 80px;
}

/* 分割条设计 */
.editor-split-resizer {
  position: relative;
  z-index: 10;
  flex-shrink: 0;
  background-color: #2b2b2b;
  transition: background-color 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.editor-split-resizer.horizontal {
  width: 5px;
  height: 100%;
  cursor: col-resize;
  border-left: 1px solid #1a1a1a;
  border-right: 1px solid #1a1a1a;
}

.editor-split-resizer.vertical {
  height: 5px;
  width: 100%;
  cursor: row-resize;
  border-top: 1px solid #1a1a1a;
  border-bottom: 1px solid #1a1a1a;
}

.editor-split-resizer:hover,
.file-editor-container.is-resizing .editor-split-resizer {
  background-color: #007acc;
}

.resizer-line {
  position: absolute;
  pointer-events: none;
}

.editor-split-resizer.horizontal .resizer-line {
  width: 1px;
  height: 24px;
  background-color: rgba(255, 255, 255, 0.4);
}

.editor-split-resizer.vertical .resizer-line {
  height: 1px;
  width: 24px;
  background-color: rgba(255, 255, 255, 0.4);
}
</style>
