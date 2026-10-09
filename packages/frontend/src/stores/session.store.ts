

import { defineStore } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useConnectionsStore, type ConnectionInfo } from './connections.store';


import {
  sessions,
  activeSessionId,
  isRdpModalOpen,
  rdpConnectionInfo,
  isVncModalOpen,
  vncConnectionInfo,
  
  suspendedSshSessions,
  isLoadingSuspendedSessions,
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
import * as modalActions from './session/actions/modalActions';
import * as commandInputActions from './session/actions/commandInputActions';
import * as sshSuspendActions from './session/actions/sshSuspendActions'; 


import type { FileInfo } from './fileEditor.store';




export const useSessionStore = defineStore('session', () => {
  // --- 依赖 ---
  const { t } = useI18n();
  const connectionsStore = useConnectionsStore();
  const router = useRouter();

  // --- 包装 Actions 以注入依赖 ---

  // Modal Actions (这些可能被其他 actions 依赖，所以先定义)
  const openRdpModal = (connection: ConnectionInfo) => modalActions.openRdpModal(connection);
  const closeRdpModal = () => modalActions.closeRdpModal();
  const openVncModal = (connection: ConnectionInfo) => modalActions.openVncModal(connection);
  const closeVncModal = () => modalActions.closeVncModal();

  // Session Actions
  const openNewSession = (
    connectionId: number | string,
    existingSessionId?: string,
    shouldActivate: boolean = true
  ) =>
    sessionActions.openNewSession(
      connectionId,
      { connectionsStore, t },
      existingSessionId,
      shouldActivate
    );
  const activateSession = (sessionId: string) => sessionActions.activateSession(sessionId);
  const closeSession = (sessionId: string) => sessionActions.closeSession(sessionId);
  const handleConnectRequest = (connection: ConnectionInfo) =>
    sessionActions.handleConnectRequest(connection, {
      connectionsStore,
      router,
      openRdpModalAction: openRdpModal, // 传递包装后的 action
      openVncModalAction: openVncModal,   // 传递包装后的 action
      t,
    });
  const handleOpenNewSession = (connectionId: number | string) =>
    sessionActions.handleOpenNewSession(connectionId, { connectionsStore, t }); // 移除了 router 和不正确的 registerSshSuspendHandlers
  const cleanupAllSessions = () => sessionActions.cleanupAllSessions();

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
    isRdpModalOpen,
    rdpConnectionInfo,
    isVncModalOpen,
    vncConnectionInfo,
    // SSH Suspend Mode State
    suspendedSshSessions,
    isLoadingSuspendedSessions,

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
    openRdpModal,
    closeRdpModal,
    openVncModal,
    closeVncModal,
    updateSessionCommandInput,

    // SSH Suspend Actions (直接从模块导出，Pinia 会处理)
    ...sshSuspendActions,
  };
});
