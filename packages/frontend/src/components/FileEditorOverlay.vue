<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import SingleEditorPane from './SingleEditorPane.vue';
import type { FileTab } from '../stores/fileEditor.store';
import { useFileEditorStore } from '../stores/fileEditor.store';
import { useSettingsStore } from '../stores/settings.store';
import { useSessionStore } from '../stores/session.store';
import { useAppearanceStore } from '../stores/appearance.store';
import { useOverlayResizable } from '../composables/useOverlayResizable';
import { useSplitEditor, type SplitDirection, type PaneId } from '../composables/useSplitEditor';

const props = defineProps<{
  isMobile?: boolean;
}>();

const { t } = useI18n();
const fileEditorStore = useFileEditorStore();
const settingsStore = useSettingsStore();
const sessionStore = useSessionStore();
const appearanceStore = useAppearanceStore();

// 本地弹窗显示状态
const isVisible = ref(false);

// Store 状态
const {
  popupTrigger,
  popupFileInfo,
  activeTabId: globalActiveTabIdRef,
} = storeToRefs(fileEditorStore);

const { showPopupFileEditorBoolean, shareFileEditorTabsBoolean } = storeToRefs(settingsStore);
const { currentEditorFontSize, currentEditorFontFamily } = storeToRefs(appearanceStore);

// Store Actions (全局模式)
const {
  saveFile: saveGlobalFile,
  closeTab: closeGlobalTab,
  setActiveTab: setGlobalActiveTab,
  updateFileContent: updateGlobalFileContent,
  closeOtherTabs,
  closeTabsToTheRight,
  closeTabsToTheLeft,
  changeEncoding: changeGlobalEncoding,
  updateTabScrollPosition,
} = fileEditorStore;

// Store Actions (会话模式)
const {
  saveFileInSession,
  closeEditorTabInSession,
  setActiveEditorTabInSession,
  updateFileContentInSession,
  closeOtherTabsInSession,
  closeTabsToTheRightInSession,
  closeTabsToTheLeftInSession,
  changeEncodingInSession,
  updateTabScrollPositionInSession,
} = sessionStore;

// 关闭弹窗
const handleCloseContainer = () => {
  isVisible.value = false;
};

// 弹窗拖拽缩放与后端尺寸持久化 (跨设备恢复)
const savedWidthPx = computed(() => {
  const w = settingsStore.settings.fileEditorModalWidth;
  return w ? parseInt(w, 10) : undefined;
});

const savedHeightPx = computed(() => {
  const h = settingsStore.settings.fileEditorModalHeight;
  return h ? parseInt(h, 10) : undefined;
});

const {
  getPopupStyle,
  startResize,
  handleBackdropMouseDown,
  handleBackdropClick,
  setPopupSize,
} = useOverlayResizable({
  initialWidthPx: savedWidthPx.value,
  initialHeightPx: savedHeightPx.value,
  onClose: handleCloseContainer,
  onResizeEnd: (width, height) => {
    // 调整窗口大小完成后自动持久化保存到后端数据库
    settingsStore.setFileEditorModalSize(width, height);
  },
});

// 监听设置从后端拉取完成或跨设备更新，自动同步编辑器尺寸
watch(
  [() => settingsStore.settings.fileEditorModalWidth, () => settingsStore.settings.fileEditorModalHeight],
  ([w, h]) => {
    if (w && h) {
      const parsedW = parseInt(w, 10);
      const parsedH = parseInt(h, 10);
      if (!isNaN(parsedW) && !isNaN(parsedH)) {
        setPopupSize(parsedW, parsedH);
      }
    }
  }
);

const popupStyle = computed(() => getPopupStyle(props.isMobile));

// 会话数据源
const currentSession = computed(() => {
  if (shareFileEditorTabsBoolean.value || !popupFileInfo.value?.sessionId) return null;
  return sessionStore.sessions.get(popupFileInfo.value.sessionId) ?? null;
});

// 当前展示的所有标签页列表
const orderedTabs = computed<FileTab[]>(() => {
  if (shareFileEditorTabsBoolean.value) {
    return Array.from(fileEditorStore.tabs.values());
  }
  return currentSession.value?.editorTabs.value ?? [];
});

// 分屏状态管理
const splitContainerRef = ref<HTMLDivElement | null>(null);
const primaryPaneRef = ref<InstanceType<typeof SingleEditorPane> | null>(null);
const secondaryPaneRef = ref<InstanceType<typeof SingleEditorPane> | null>(null);

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
} = useSplitEditor(orderedTabs, { storagePrefix: 'nexus_overlay_editor' });

// 监听全局/会话 activeTabId 同步到主窗格
const baseActiveTabId = computed(() => {
  if (shareFileEditorTabsBoolean.value) {
    return globalActiveTabIdRef.value;
  }
  return currentSession.value?.activeEditorTabId.value ?? null;
});

watch(
  baseActiveTabId,
  (newId) => {
    if (newId) {
      primaryActiveTabId.value = newId;
    }
  },
  { immediate: true }
);

// 会话名称
const currentSessionName = computed(() => {
  const sessionId = popupFileInfo.value?.sessionId;
  if (!sessionId) return null;
  return sessionStore.sessions.get(sessionId)?.connectionName ?? null;
});

// 标签激活处理
const handleActivateTab = (paneId: PaneId, tabId: string) => {
  if (paneId === 'primary') {
    primaryActiveTabId.value = tabId;
    if (shareFileEditorTabsBoolean.value) {
      setGlobalActiveTab(tabId);
    } else {
      const sessionId = popupFileInfo.value?.sessionId;
      if (sessionId) setActiveEditorTabInSession(sessionId, tabId);
    }
  } else {
    secondaryActiveTabId.value = tabId;
  }
  activePaneId.value = paneId;
};

// 标签关闭
const handleCloseTab = (tabId: string) => {
  syncTabsAfterClose(tabId);
  if (shareFileEditorTabsBoolean.value) {
    closeGlobalTab(tabId);
  } else {
    const sessionId = popupFileInfo.value?.sessionId;
    if (sessionId) closeEditorTabInSession(sessionId, tabId);
  }
};

const handleCloseOtherTabs = (tabId: string) => {
  if (shareFileEditorTabsBoolean.value) {
    closeOtherTabs(tabId);
  } else {
    const sessionId = popupFileInfo.value?.sessionId;
    if (sessionId) closeOtherTabsInSession(sessionId, tabId);
  }
};

const handleCloseTabsToRight = (tabId: string) => {
  if (shareFileEditorTabsBoolean.value) {
    closeTabsToTheRight(tabId);
  } else {
    const sessionId = popupFileInfo.value?.sessionId;
    if (sessionId) closeTabsToTheRightInSession(sessionId, tabId);
  }
};

const handleCloseTabsToLeft = (tabId: string) => {
  if (shareFileEditorTabsBoolean.value) {
    closeTabsToTheLeft(tabId);
  } else {
    const sessionId = popupFileInfo.value?.sessionId;
    if (sessionId) closeTabsToTheLeftInSession(sessionId, tabId);
  }
};

// 内容变更
const handleUpdateContent = ({ tabId, content }: { tabId: string; content: string }) => {
  if (shareFileEditorTabsBoolean.value) {
    updateGlobalFileContent(tabId, content);
  } else {
    const sessionId = popupFileInfo.value?.sessionId;
    if (sessionId) updateFileContentInSession(sessionId, tabId, content);
  }
};

// 保存
const handleSaveTab = (tabId: string) => {
  if (shareFileEditorTabsBoolean.value) {
    saveGlobalFile(tabId);
  } else {
    const sessionId = popupFileInfo.value?.sessionId;
    if (sessionId) saveFileInSession(sessionId, tabId);
  }
};

// 编码切换
const handleChangeEncoding = ({ tabId, encoding }: { tabId: string; encoding: string }) => {
  if (shareFileEditorTabsBoolean.value) {
    changeGlobalEncoding(tabId, encoding);
  } else {
    const sessionId = popupFileInfo.value?.sessionId;
    if (sessionId) changeEncodingInSession(sessionId, tabId, encoding);
  }
};

// 滚动同步
const handleUpdateScroll = ({ tabId, scrollTop, scrollLeft }: { tabId: string; scrollTop: number; scrollLeft: number }) => {
  if (shareFileEditorTabsBoolean.value) {
    updateTabScrollPosition(tabId, scrollTop, scrollLeft);
  } else {
    const sessionId = popupFileInfo.value?.sessionId;
    if (sessionId) updateTabScrollPositionInSession(sessionId, tabId, scrollTop, scrollLeft);
  }
};

// 字号调整
const handleUpdateFontSize = (newSize: number) => {
  appearanceStore.setEditorFontSize(newSize);
};

// 冲突解决
const handleResolveReload = async (tabId: string) => {
  if (shareFileEditorTabsBoolean.value) {
    await fileEditorStore.resolveConflictReload(tabId);
  } else {
    const sessionId = popupFileInfo.value?.sessionId;
    if (sessionId) await sessionStore.resolveConflictReloadInSession(sessionId, tabId);
  }
};

const handleResolveOverwrite = async (tabId: string) => {
  if (shareFileEditorTabsBoolean.value) {
    await fileEditorStore.resolveConflictOverwrite(tabId);
  } else {
    const sessionId = popupFileInfo.value?.sessionId;
    if (sessionId) await sessionStore.resolveConflictOverwriteInSession(sessionId, tabId);
  }
};

const handleResolveIgnore = (tabId: string) => {
  if (shareFileEditorTabsBoolean.value) {
    fileEditorStore.resolveConflictIgnore(tabId);
  } else {
    const sessionId = popupFileInfo.value?.sessionId;
    if (sessionId) sessionStore.resolveConflictIgnoreInSession(sessionId, tabId);
  }
};

// 分屏触发
const handleSplitEditor = (direction: SplitDirection, tabId?: string) => {
  openSplit(direction, tabId);
};

// 拖拽分屏分割线
const handleResizerMouseDown = (e: MouseEvent) => {
  if (splitContainerRef.value) {
    startSplitResize(e, splitContainerRef.value);
  }
};

// 移动端搜索
const handleOpenSearch = () => {
  if (primaryPaneRef.value) {
    primaryPaneRef.value.openSearch();
  }
};

// 监听弹窗触发信号
watch(popupTrigger, () => {
  if (!showPopupFileEditorBoolean.value || !popupFileInfo.value) {
    isVisible.value = false;
    return;
  }
  isVisible.value = true;
});
</script>

<template>
  <div
    v-if="isVisible"
    class="editor-overlay-backdrop"
    @mousedown="handleBackdropMouseDown"
    @click="handleBackdropClick"
  >
    <div class="editor-popup" :style="popupStyle">
      <!-- 内部多窗格分屏容器 -->
      <div
        ref="splitContainerRef"
        class="overlay-split-container"
        :class="[splitDirection, { 'is-split-active': isSplitActive, 'is-resizing': isResizing }]"
      >
        <!-- 主窗格 -->
        <div
          class="overlay-pane-wrapper primary-wrapper"
          :style="primaryPaneStyle"
          @mousedown="activePaneId = 'primary'"
        >
          <SingleEditorPane
            ref="primaryPaneRef"
            pane-id="primary"
            :tabs="orderedTabs"
            :active-tab-id="primaryActiveTabId"
            :is-split-active="isSplitActive"
            :split-direction="splitDirection"
            :is-mobile="props.isMobile"
            :session-name="currentSessionName"
            :font-family="currentEditorFontFamily"
            :fontSize="currentEditorFontSize"
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
            @open-search="handleOpenSearch"
          >
            <template #header-actions>
              <button
                class="action-icon-btn close-editor-btn"
                :class="{ 'is-mobile': props.isMobile }"
                :title="t('fileManager.actions.closeEditor', '关闭编辑器')"
                @click="handleCloseContainer"
              >
                <i v-if="props.isMobile" class="fas fa-times text-xs"></i>
                <template v-else>✖</template>
              </button>
            </template>
          </SingleEditorPane>
        </div>

        <!-- 分割条 -->
        <div
          v-if="isSplitActive"
          class="overlay-split-resizer"
          :class="splitDirection"
          :title="'双击重置为 50% 对等分屏，拖拽调整比例'"
          @mousedown="handleResizerMouseDown"
          @dblclick="resetSplitRatio"
        >
          <div class="resizer-line"></div>
        </div>

        <!-- 次级窗格 -->
        <div
          v-if="isSplitActive"
          class="overlay-pane-wrapper secondary-wrapper"
          :style="secondaryPaneStyle"
          @mousedown="activePaneId = 'secondary'"
        >
          <SingleEditorPane
            ref="secondaryPaneRef"
            pane-id="secondary"
            :tabs="orderedTabs"
            :active-tab-id="secondaryActiveTabId"
            :is-split-active="isSplitActive"
            :split-direction="splitDirection"
            :is-mobile="props.isMobile"
            :session-name="currentSessionName"
            :font-family="currentEditorFontFamily"
            :fontSize="currentEditorFontSize"
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
            @open-search="handleOpenSearch"
          />
        </div>
      </div>

      <!-- 弹窗右下角拖拽拉伸尺寸手柄 (移动端全屏模式隐藏) -->
      <div v-if="!props.isMobile" class="resize-handle" @mousedown.prevent="startResize"></div>
    </div>
  </div>
</template>

<style scoped>
.editor-overlay-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background-color: rgba(0, 0, 0, 0.6);
  z-index: 1000;
  display: flex;
  justify-content: center;
  align-items: center;
}

.editor-popup {
  position: absolute;
  background-color: #1e1e1e;
  border: 1px solid #454545;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
}

.overlay-split-container {
  display: flex;
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
}

.overlay-split-container.horizontal {
  flex-direction: row;
}

.overlay-split-container.vertical {
  flex-direction: column;
}

.overlay-pane-wrapper {
  position: relative;
  overflow: hidden;
  min-width: 80px;
  min-height: 80px;
}

/* 分割条设计 */
.overlay-split-resizer {
  position: relative;
  z-index: 10;
  flex-shrink: 0;
  background-color: #2b2b2b;
  transition: background-color 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.overlay-split-resizer.horizontal {
  width: 5px;
  height: 100%;
  cursor: col-resize;
  border-left: 1px solid #1a1a1a;
  border-right: 1px solid #1a1a1a;
}

.overlay-split-resizer.vertical {
  height: 5px;
  width: 100%;
  cursor: row-resize;
  border-top: 1px solid #1a1a1a;
  border-bottom: 1px solid #1a1a1a;
}

.overlay-split-resizer:hover,
.overlay-split-container.is-resizing .overlay-split-resizer {
  background-color: #007acc;
}

.resizer-line {
  position: absolute;
  pointer-events: none;
}

.overlay-split-resizer.horizontal .resizer-line {
  width: 1px;
  height: 24px;
  background-color: rgba(255, 255, 255, 0.4);
}

.overlay-split-resizer.vertical .resizer-line {
  height: 1px;
  width: 24px;
  background-color: rgba(255, 255, 255, 0.4);
}

.close-editor-btn {
  background: transparent;
  border: none;
  color: #888888;
  font-size: 14px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  transition: all 0.15s;
}

.close-editor-btn:hover {
  background-color: rgba(255, 0, 0, 0.2);
  color: #ff5555;
}

.close-editor-btn.is-mobile {
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 6px;
  background-color: #2c2c2f;
  border: 1px solid #444448;
  color: #a1a1aa;
}

.close-editor-btn.is-mobile:active {
  background-color: #dc262620;
  border-color: #dc262650;
  color: #ef4444;
}

.resize-handle {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 16px;
  height: 16px;
  cursor: se-resize;
  z-index: 1001;
  background: linear-gradient(135deg, transparent 50%, #555 50%);
}
</style>
