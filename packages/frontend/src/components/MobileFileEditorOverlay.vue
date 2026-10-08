<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import SingleEditorPane from './SingleEditorPane.vue';
import type { FileTab } from '../stores/fileEditor.store';
import { useFileEditorStore } from '../stores/fileEditor.store';
import { useSettingsStore } from '../stores/settings.store';
import { useSessionStore } from '../stores/session.store';
import { useAppearanceStore } from '../stores/appearance.store';

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const { t } = useI18n();
const fileEditorStore = useFileEditorStore();
const settingsStore = useSettingsStore();
const sessionStore = useSessionStore();
const appearanceStore = useAppearanceStore();

const { popupFileInfo, activeTabId: globalActiveTabIdRef } = storeToRefs(fileEditorStore);
const { shareFileEditorTabsBoolean } = storeToRefs(settingsStore);
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

const activeTabId = computed(() => {
  if (shareFileEditorTabsBoolean.value) {
    return globalActiveTabIdRef.value;
  }
  return currentSession.value?.activeEditorTabId.value ?? null;
});

const currentSessionName = computed(() => {
  const sessionId = popupFileInfo.value?.sessionId;
  if (!sessionId) return null;
  return sessionStore.sessions.get(sessionId)?.connectionName ?? null;
});

// 标签与编辑操作
const handleActivateTab = (tabId: string) => {
  if (shareFileEditorTabsBoolean.value) {
    setGlobalActiveTab(tabId);
  } else {
    const sessionId = popupFileInfo.value?.sessionId;
    if (sessionId) setActiveEditorTabInSession(sessionId, tabId);
  }
};

const handleCloseTab = (tabId: string) => {
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

const handleUpdateContent = ({ tabId, content }: { tabId: string; content: string }) => {
  if (shareFileEditorTabsBoolean.value) {
    updateGlobalFileContent(tabId, content);
  } else {
    const sessionId = popupFileInfo.value?.sessionId;
    if (sessionId) updateFileContentInSession(sessionId, tabId, content);
  }
};

const handleSaveTab = (tabId: string) => {
  if (shareFileEditorTabsBoolean.value) {
    saveGlobalFile(tabId);
  } else {
    const sessionId = popupFileInfo.value?.sessionId;
    if (sessionId) saveFileInSession(sessionId, tabId);
  }
};

const handleChangeEncoding = ({ tabId, encoding }: { tabId: string; encoding: string }) => {
  if (shareFileEditorTabsBoolean.value) {
    changeGlobalEncoding(tabId, encoding);
  } else {
    const sessionId = popupFileInfo.value?.sessionId;
    if (sessionId) changeEncodingInSession(sessionId, tabId, encoding);
  }
};

const handleUpdateScroll = ({ tabId, scrollTop, scrollLeft }: { tabId: string; scrollTop: number; scrollLeft: number }) => {
  if (shareFileEditorTabsBoolean.value) {
    updateTabScrollPosition(tabId, scrollTop, scrollLeft);
  } else {
    const sessionId = popupFileInfo.value?.sessionId;
    if (sessionId) updateTabScrollPositionInSession(sessionId, tabId, scrollTop, scrollLeft);
  }
};

const handleUpdateFontSize = async (newSize: number) => {
  appearanceStore.setEditorFontSize(newSize);
};

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
</script>

<template>
  <div class="mobile-editor-overlay-root fixed inset-0 z-[1000] w-screen h-screen flex flex-col bg-background">
    <SingleEditorPane
      pane-id="primary"
      :tabs="orderedTabs"
      :active-tab-id="activeTabId"
      :is-split-active="false"
      split-direction="horizontal"
      :is-mobile="true"
      :session-name="currentSessionName"
      :font-family="currentEditorFontFamily"
      :font-size="currentEditorFontSize"
      @activate-tab="handleActivateTab"
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
    >
      <template #header-actions>
        <button
          class="mobile-close-btn w-7 h-7 rounded-md flex items-center justify-center text-text-secondary active:text-foreground active:bg-white/10 transition-colors"
          :title="t('fileManager.actions.closeEditor', '关闭编辑器')"
          @click="emit('close')"
        >
          <i class="fas fa-times text-xs"></i>
        </button>
      </template>
    </SingleEditorPane>
  </div>
</template>

<style scoped>
.mobile-editor-overlay-root {
  background-color: var(--nexus-bg-primary, #1e1e1e);
}
</style>
