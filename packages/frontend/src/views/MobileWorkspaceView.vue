<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import TerminalTabBar from '../components/TerminalTabBar.vue';
import CommandInputBar from '../components/CommandInputBar.vue';
import VirtualKeyboard from '../components/VirtualKeyboard.vue';
import LayoutRenderer from '../components/LayoutRenderer.vue';
import { useSessionStore } from '../stores/session.store';
import type { LayoutNode } from '../stores/layout.store';
import type { FileTab } from '../stores/fileEditor.store';
import type { SessionTabInfoWithStatus, SshTerminalInstance } from '../stores/session/types';
import type { ConnectionInfo } from '../stores/connections.store';

const props = defineProps<{
  sessions: SessionTabInfoWithStatus[];
  activeSessionId: string | null;
  layoutLocked: boolean;
  editorTabs: FileTab[];
  activeEditorTabId: string | null;
}>();

const emit = defineEmits<{
  (e: 'open-layout-configurator'): void;
  (e: 'request-add-connection'): void;
  (e: 'request-edit-connection', connection: ConnectionInfo): void;
  (e: 'send-command', command: string): void;
  (e: 'search', term: string): void;
  (e: 'find-next'): void;
  (e: 'find-previous'): void;
  (e: 'close-search'): void;
  (e: 'clear-terminal'): void;
}>();

const { t } = useI18n();
const sessionStore = useSessionStore();

// 移动端专用单终端视口布局节点
const mobileLayoutNodeForTerminal = computed((): LayoutNode | null => {
  return {
    id: 'mobile-main-terminal-pane',
    type: 'pane' as const,
    component: 'terminal' as const,
    size: 100,
  };
});

// 虚拟键盘状态与手势
const isVirtualKeyboardVisible = ref(false);

const toggleVirtualKeyboard = () => {
  isVirtualKeyboardVisible.value = !isVirtualKeyboardVisible.value;
};

const handleVirtualKeyPress = (keySequence: string) => {
  if (!props.activeSessionId) return;
  const currentSession = sessionStore.sessions.get(props.activeSessionId);
  if (!currentSession) return;

  const terminalManager = currentSession.terminalManager as (SshTerminalInstance | undefined);
  if (terminalManager && typeof terminalManager.sendData === 'function') {
    terminalManager.sendData(keySequence);
  }
};

const handleCloseOtherSessions = (targetSessionId: string) => {
  const sessionsToClose = props.sessions
    .filter(tab => tab.sessionId !== targetSessionId)
    .map(tab => tab.sessionId);
  sessionsToClose.forEach(id => sessionStore.closeSession(id));
};

const handleCloseSessionsToRight = (targetSessionId: string) => {
  const targetIndex = props.sessions.findIndex(tab => tab.sessionId === targetSessionId);
  if (targetIndex === -1) return;
  const sessionsToClose = props.sessions
    .slice(targetIndex + 1)
    .map(tab => tab.sessionId);
  sessionsToClose.forEach(id => sessionStore.closeSession(id));
};

const handleCloseSessionsToLeft = (targetSessionId: string) => {
  const targetIndex = props.sessions.findIndex(tab => tab.sessionId === targetSessionId);
  if (targetIndex === -1) return;
  const sessionsToClose = props.sessions
    .slice(0, targetIndex)
    .map(tab => tab.sessionId);
  sessionsToClose.forEach(id => sessionStore.closeSession(id));
};

const handleRequestEditConnectionFromPopup = (conn: ConnectionInfo) => {
  emit('request-edit-connection', conn);
};
</script>

<template>
  <div class="mobile-workspace-view flex flex-col flex-grow overflow-hidden">
    <!-- 移动端终端视口区域 -->
    <div class="mobile-content-area">
      <LayoutRenderer
        v-if="props.activeSessionId && mobileLayoutNodeForTerminal"
        :layout-node="mobileLayoutNodeForTerminal"
        :active-session-id="props.activeSessionId"
        :is-root-renderer="false"
        :layout-locked="props.layoutLocked"
        class="layout-renderer-wrapper flex-grow overflow-auto"
        :editor-tabs="props.editorTabs"
        :active-editor-tab-id="props.activeEditorTabId"
      />
      <div v-else class="pane-placeholder">
        {{ t('workspace.noActiveSession', '没有活动的会话') }}
      </div>
    </div>

    <!-- 移动端会话标签栏：紧贴终端视口下方 -->
    <TerminalTabBar
      :sessions="props.sessions"
      :active-session-id="props.activeSessionId"
      :is-mobile="true"
      @activate-session="sessionStore.activateSession"
      @close-session="sessionStore.closeSession"
      @open-layout-configurator="emit('open-layout-configurator')"
      @request-add-connection-from-popup="emit('request-add-connection')"
      @request-edit-connection-from-popup="handleRequestEditConnectionFromPopup"
      @close-other-sessions="handleCloseOtherSessions"
      @close-sessions-to-right="handleCloseSessionsToRight"
      @close-sessions-to-left="handleCloseSessionsToLeft"
    />

    <!-- 移动端命令工具栏 -->
    <CommandInputBar
      class="mobile-command-bar"
      :is-mobile="true"
      @send-command="(cmd: string) => emit('send-command', cmd)"
      @search="(term: string) => emit('search', term)"
      @find-next="emit('find-next')"
      @find-previous="emit('find-previous')"
      @close-search="emit('close-search')"
      @clear-terminal="emit('clear-terminal')"
      :is-virtual-keyboard-visible="isVirtualKeyboardVisible"
      @toggle-virtual-keyboard="toggleVirtualKeyboard"
    />

    <!-- 移动端软键盘 -->
    <VirtualKeyboard
      v-show="isVirtualKeyboardVisible"
      class="mobile-virtual-keyboard"
      @send-key="handleVirtualKeyPress"
    />
  </div>
</template>

<style scoped>
.mobile-workspace-view {
  width: 100%;
  height: 100%;
}

.mobile-content-area {
  display: flex;
  flex: 1;
  overflow: hidden;
  position: relative;
  width: 100%;
}

.mobile-command-bar {
  flex-shrink: 0;
  width: 100%;
  z-index: 20;
}

.mobile-virtual-keyboard {
  flex-shrink: 0;
  width: 100%;
  z-index: 20;
}

.layout-renderer-wrapper {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.pane-placeholder {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
  width: 100%;
  font-size: 1.1rem;
  color: var(--text-color-secondary, #888);
}
</style>
