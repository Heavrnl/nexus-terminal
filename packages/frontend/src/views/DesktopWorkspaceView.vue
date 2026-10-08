<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import TerminalTabBar from '../components/TerminalTabBar.vue';
import LayoutRenderer from '../components/LayoutRenderer.vue';
import { useSessionStore } from '../stores/session.store';
import type { LayoutNode } from '../stores/layout.store';
import type { FileTab } from '../stores/fileEditor.store';
import type { SessionTabInfoWithStatus } from '../stores/session/types';
import type { ConnectionInfo } from '../stores/connections.store';

const props = defineProps<{
  sessions: SessionTabInfoWithStatus[];
  activeSessionId: string | null;
  layoutTree: LayoutNode | null;
  layoutLocked: boolean;
  editorTabs: FileTab[];
  activeEditorTabId: string | null;
}>();

const emit = defineEmits<{
  (e: 'open-layout-configurator'): void;
  (e: 'request-add-connection'): void;
  (e: 'request-edit-connection', connection: ConnectionInfo): void;
}>();

const { t } = useI18n();
const sessionStore = useSessionStore();

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
  <div class="desktop-workspace-view flex flex-col flex-grow overflow-hidden">
    <TerminalTabBar
      :sessions="props.sessions"
      :active-session-id="props.activeSessionId"
      :is-mobile="false"
      @activate-session="sessionStore.activateSession"
      @close-session="sessionStore.closeSession"
      @open-layout-configurator="emit('open-layout-configurator')"
      @request-add-connection-from-popup="emit('request-add-connection')"
      @request-edit-connection-from-popup="handleRequestEditConnectionFromPopup"
      @close-other-sessions="handleCloseOtherSessions"
      @close-sessions-to-right="handleCloseSessionsToRight"
      @close-sessions-to-left="handleCloseSessionsToLeft"
    />
    <div class="main-content-area">
      <LayoutRenderer
        v-if="props.layoutTree"
        :is-root-renderer="true"
        :layout-node="props.layoutTree"
        :active-session-id="props.activeSessionId"
        :layout-locked="props.layoutLocked"
        class="layout-renderer-wrapper"
        :editor-tabs="props.editorTabs"
        :active-editor-tab-id="props.activeEditorTabId"
      />
      <div v-else class="pane-placeholder">
        {{ t('layout.loading', '加载布局中...') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.desktop-workspace-view {
  width: 100%;
  height: 100%;
}

.main-content-area {
  display: flex;
  flex: 1;
  overflow: hidden;
  border: 1px solid var(--border-color, #ccc);
  border-top: none;
  border-radius: 0 0 5px 5px;
  margin: var(--base-margin, 0.5rem);
  margin-top: 0;
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
  font-size: 1.2rem;
  color: var(--text-color-secondary, #888);
}
</style>
