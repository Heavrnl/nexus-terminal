

import { defineStore } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useConnectionsStore, type ConnectionInfo } from './connections.store';


import {
  sessions,
  activeSessionId,
  suspendedSshSessions,
  isLoadingSuspendedSessions,
  suspendedSshSessionsLoaded,
  sessionOrder,
} from './session/state';
import { useWorkspaceSyncStore } from './workspaceSync.store';


import {
  sessionTabs,
  sessionTabsWithStatus,
  activeSession,
} from './session/getters';


import * as sessionActions from './session/actions/sessionActions';
import * as editorActions from './session/actions/editorActions';
import * as sftpManagerActions from './session/actions/sftpManagerActions';
import * as commandInputActions from './session/actions/commandInputActions';
import * as sshSuspendActions from './session/actions/sshSuspendActions'; 


import type { FileInfo } from './fileEditor.store';




export const useSessionStore = defineStore('session', () => {
  // --- 依赖 ---
  const { t } = useI18n();
  const connectionsStore = useConnectionsStore();
  const router = useRouter();

  // --- 包装 Actions 以注入依赖 ---

  // Session Actions
  const openNewSession = (
    connectionId: number | string,
    existingSessionId?: string,
    shouldActivate: boolean = true,
    options?: {
      headless?: boolean;
      remoteSessionId?: string;
      remotePaneSessionIds?: Record<string, string>;
      attachOnly?: boolean;
    }
  ) =>
    sessionActions.openNewSession(
      connectionId,
      { connectionsStore, t },
      existingSessionId,
      shouldActivate,
      options
    );
  const activateSession = (sessionId: string, opts?: { silent?: boolean }) => sessionActions.activateSession(sessionId, opts);
  // 关闭标签默认「转入后台挂起」而不是断开 SSH，所以要透传 options 并返回 Promise
  // （调用方可能想等挂起交接完成后再做后续动作）。顺手把 t 带进去发提示。
  const closeSession = (
    sessionId: string,
    options?: { recordRemoval?: boolean; suspend?: boolean }
  ) => sessionActions.closeSession(sessionId, options, { t });
  const handleConnectRequest = (connection: ConnectionInfo) =>
    sessionActions.handleConnectRequest(connection, {
      connectionsStore,
      router,
      t,
    });
  const handleOpenNewSession = (connectionId: number | string) =>
    sessionActions.handleOpenNewSession(connectionId, { connectionsStore, t }); // 移除了 router 和不正确的 registerSshSuspendHandlers
  const cleanupAllSessions = () => sessionActions.cleanupAllSessions();
  const disconnectSession = (sessionId: string) => sessionActions.disconnectSession(sessionId);
  const reconnectSession = (sessionId: string) => sessionActions.reconnectSession(sessionId);

  // SFTP Manager Actions
  const getOrCreateSftpManager = (sessionId: string, instanceId: string) =>
    sftpManagerActions.getOrCreateSftpManager(sessionId, instanceId, { t });
  const removeSftpManager = (sessionId: string, instanceId: string) =>
    sftpManagerActions.removeSftpManager(sessionId, instanceId);

  // Editor Actions
  const openFileInSession = (sessionId: string, fileInfo: FileInfo) =>
    editorActions.openFileInSession(sessionId, fileInfo, { getOrCreateSftpManager, t });
  const closeEditorTabInSession = (sessionId: string, tabId: string) =>
    editorActions.closeEditorTabInSession(sessionId, tabId);
  const setActiveEditorTabInSession = (sessionId: string, tabId: string) =>
    editorActions.setActiveEditorTabInSession(sessionId, tabId);
  const updateFileContentInSession = (sessionId: string, tabId: string, newContent: string) =>
    editorActions.updateFileContentInSession(sessionId, tabId, newContent);
  const saveFileInSession = (sessionId: string, tabId: string) =>
    editorActions.saveFileInSession(sessionId, tabId, { getOrCreateSftpManager, t });
  const changeEncodingInSession = (sessionId: string, tabId: string, newEncoding: string) =>
    editorActions.changeEncodingInSession(sessionId, tabId, newEncoding);
  const closeOtherTabsInSession = (sessionId: string, targetTabId: string) =>
    editorActions.closeOtherTabsInSession(sessionId, targetTabId);
  const closeTabsToTheRightInSession = (sessionId: string, targetTabId: string) =>
    editorActions.closeTabsToTheRightInSession(sessionId, targetTabId);
  const closeTabsToTheLeftInSession = (sessionId: string, targetTabId: string) =>
    editorActions.closeTabsToTheLeftInSession(sessionId, targetTabId);
  const updateTabScrollPositionInSession = (sessionId: string, tabId: string, scrollTop: number, scrollLeft: number) =>
    editorActions.updateTabScrollPositionInSession(sessionId, tabId, scrollTop, scrollLeft);

  const reloadFileInSession = (sessionId: string, tabId: string, silent = false) =>
    editorActions.reloadFileInSession(sessionId, tabId, { getOrCreateSftpManager, t }, silent);
  const checkFileExternalChangesInSession = (sessionId: string, tabId: string) =>
    editorActions.checkFileExternalChangesInSession(sessionId, tabId, { getOrCreateSftpManager, t });
  const resolveConflictReloadInSession = (sessionId: string, tabId: string) =>
    editorActions.resolveConflictReloadInSession(sessionId, tabId, { getOrCreateSftpManager, t });
  const resolveConflictOverwriteInSession = (sessionId: string, tabId: string) =>
    editorActions.resolveConflictOverwriteInSession(sessionId, tabId, { getOrCreateSftpManager, t });
  const resolveConflictIgnoreInSession = (sessionId: string, tabId: string) =>
    editorActions.resolveConflictIgnoreInSession(sessionId, tabId);

  // --- 轻量探针调度器 (针对单会话独立标签页) ---
  const pollActiveSessionFile = () => {
    const sId = activeSessionId.value;
    if (!sId) return;
    const session = sessions.value.get(sId);
    const tabId = session?.activeEditorTabId.value;
    if (tabId) {
      checkFileExternalChangesInSession(sId, tabId);
    }
  };

  if (typeof window !== 'undefined') {
    setInterval(pollActiveSessionFile, 1500);
    window.addEventListener('focus', pollActiveSessionFile);
  }

  // Command Input Actions
  const updateSessionCommandInput = (sessionId: string, content: string) =>
    commandInputActions.updateSessionCommandInput(sessionId, content);

  // 会话顺序管理 Action
  const setSessionOrder = (newOrder: string[], triggerSync: boolean = true) => {
    sessionOrder.value = [...newOrder];
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('sessionOrder', JSON.stringify(newOrder));
    }
    if (triggerSync) {
      try {
        const workspaceSyncStore = useWorkspaceSyncStore();
        if (workspaceSyncStore.syncEnabled && !workspaceSyncStore.isRestoring) {
          workspaceSyncStore.triggerDebouncedSave(300);
        }
      } catch (e) {
        // 忽略可能存在的依赖初始化异常
      }
    }
  };

  return {
    // State (直接从 state 模块导出，Pinia 会处理)
    sessions,
    activeSessionId,
    sessionOrder,
    // SSH Suspend Mode State
    suspendedSshSessions,
    isLoadingSuspendedSessions,
    suspendedSshSessionsLoaded,

    // Getters (直接从 getters 模块导出)
    sessionTabs,
    sessionTabsWithStatus,
    activeSession,

    // Wrapped Actions
    setSessionOrder,
    openNewSession,
    activateSession,
    closeSession,
    handleConnectRequest,
    handleOpenNewSession,
    cleanupAllSessions,
    disconnectSession,
    reconnectSession,
    getOrCreateSftpManager,
    removeSftpManager,
    openFileInSession,
    closeEditorTabInSession,
    setActiveEditorTabInSession,
    updateFileContentInSession,
    saveFileInSession,
    reloadFileInSession,
    checkFileExternalChangesInSession,
    resolveConflictReloadInSession,
    resolveConflictOverwriteInSession,
    resolveConflictIgnoreInSession,
    changeEncodingInSession,
    closeOtherTabsInSession,
    closeTabsToTheRightInSession,
    closeTabsToTheLeftInSession,
    updateTabScrollPositionInSession,
    updateSessionCommandInput,

    // SSH Suspend Actions (直接从模块导出，Pinia 会处理)
    ...sshSuspendActions,
  };
});
