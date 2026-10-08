<script setup lang="ts">
import { computed, type PropType, ref, defineExpose, onMounted, onBeforeUnmount } from 'vue';
import { storeToRefs } from 'pinia';
import SingleEditorPane from './SingleEditorPane.vue';
import { useFileEditorStore, type FileTab } from '../stores/fileEditor.store';
import { useFocusSwitcherStore } from '../stores/focusSwitcher.store';
import { useSessionStore } from '../stores/session.store';
import { useSettingsStore } from '../stores/settings.store';
import { useAppearanceStore } from '../stores/appearance.store';
import { useWorkspaceEventEmitter } from '../composables/workspaceEvents';

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

const editorPaneRef = ref<InstanceType<typeof SingleEditorPane> | null>(null);

// 当前会话名称
const currentSessionName = computed(() => {
  if (!props.sessionId) return null;
  return sessionStore.sessions.get(props.sessionId)?.connectionName ?? null;
});

// 标签激活与关闭处理
const handleActivateTab = (tabId: string) => {
  emitWorkspaceEvent('editor:activateTab', { tabId });
};

const handleCloseTab = (tabId: string) => {
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

// 内容变更
const handleUpdateContent = ({ tabId, content }: { tabId: string; content: string }) => {
  emitWorkspaceEvent('editor:updateContent', { tabId, content });
};

// 保存
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

// 冲突解决
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

// 聚焦
const focusActiveEditor = (): boolean => {
  if (editorPaneRef.value) {
    return editorPaneRef.value.focusActiveEditor();
  }
  return false;
};

defineExpose({ focusActiveEditor });

let unregisterFocusFn: (() => void) | null = null;

onMounted(() => {
  unregisterFocusFn = focusSwitcherStore.registerFocusAction('fileEditorActive', focusActiveEditor);
});

onBeforeUnmount(() => {
  if (unregisterFocusFn) unregisterFocusFn();
});
</script>

<template>
  <div class="mobile-file-editor-container">
    <SingleEditorPane
      ref="editorPaneRef"
      pane-id="primary"
      :tabs="props.tabs"
      :active-tab-id="props.activeTabId"
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
    />
  </div>
</template>

<style scoped>
.mobile-file-editor-container {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
  background-color: var(--nexus-bg-primary, #1e1e1e);
}
</style>
