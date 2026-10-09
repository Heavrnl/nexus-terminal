<script setup lang="ts">
import { onMounted, onBeforeUnmount, computed, ref, shallowRef, watch, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useLayoutStore, type LayoutNode } from '../stores/layout.store'; // +++ Import LayoutNode +++
import { useDeviceDetection } from '../composables/useDeviceDetection';
import { useConnectionsStore, type ConnectionInfo } from '../stores/connections.store';
import { useTagsStore } from '../stores/tags.store';
import AddConnectionFormComponent from '../components/AddConnectionForm.vue';
import DesktopWorkspaceView from './DesktopWorkspaceView.vue';
import MobileWorkspaceView from './MobileWorkspaceView.vue';
import LayoutConfigurator from '../components/LayoutConfigurator.vue';
import FileManagerModal from '../components/FileManagerModal.vue'; 
import TransferProgressModal from '../components/TransferProgressModal.vue';
import AddEditQuickCommandForm from '../components/AddEditQuickCommandForm.vue';
import WorkspaceTakeoverOverlay from '../components/WorkspaceTakeoverOverlay.vue';
import type { QuickCommandFE } from '../stores/quickCommands.store';
import { useSessionStore } from '../stores/session.store';
import type { SessionTabInfoWithStatus, SshTerminalInstance } from '../stores/session/types';
import { useSettingsStore } from '../stores/settings.store';
import { useFileEditorStore, type FileTab } from '../stores/fileEditor.store';
import { useWorkspaceSyncStore } from '../stores/workspaceSync.store';
import { useCommandHistoryStore } from '../stores/commandHistory.store';
import type { Terminal as XtermTerminal } from 'xterm';
import type { ISearchOptions } from '@xterm/addon-search';
import {
  useWorkspaceEventSubscriber,
  useWorkspaceEventOff,
  type WorkspaceEventPayloads
} from '../composables/workspaceEvents';
import type { WebSocketDependencies } from '../composables/useSftpActions'; 

// --- Setup ---
const { t } = useI18n();
const sessionStore = useSessionStore();
const settingsStore = useSettingsStore(); // Keep settingsStore instance
const fileEditorStore = useFileEditorStore();
const workspaceSyncStore = useWorkspaceSyncStore();
const layoutStore = useLayoutStore();
const commandHistoryStore = useCommandHistoryStore();
const connectionsStore = useConnectionsStore(); 
const tagsStore = useTagsStore();
const { isHeaderVisible } = storeToRefs(layoutStore);
const { isMobile } = useDeviceDetection();

// --- 从 Store 获取响应式状态和 Getters ---
const { sessionTabsWithStatus, activeSessionId, activeSession, isRdpModalOpen, rdpConnectionInfo, isVncModalOpen, vncConnectionInfo } = storeToRefs(sessionStore); // 使用 storeToRefs 获取 RDP 和 VNC 状态
const { shareFileEditorTabsBoolean, layoutLockedBoolean } = storeToRefs(settingsStore); // +++ Add layoutLockedBoolean +++
const { orderedTabs: globalEditorTabs, activeTabId: globalActiveEditorTabId } = storeToRefs(fileEditorStore);
const { layoutTree } = storeToRefs(layoutStore); // 只获取布局树

// --- 计算属性 (用于动态绑定编辑器 Props) ---
// 这些计算属性现在需要传递给 LayoutRenderer
const editorTabs = computed((): FileTab[] => { // Ensure return type is FileTab[]
  if (shareFileEditorTabsBoolean.value) {
    return globalEditorTabs.value;
  } else {
    return activeSession.value?.editorTabs.value ?? [];
  }
});

const activeEditorTabId = computed(() => {
  if (shareFileEditorTabsBoolean.value) {
    return globalActiveEditorTabId.value;
  } else {
    return activeSession.value?.activeEditorTabId.value ?? null;
  }
});

// --- UI 状态 (保持本地) ---
const showAddEditForm = ref(false);
const connectionToEdit = ref<ConnectionInfo | null>(null);
const showLayoutConfigurator = ref(false); // 控制布局配置器可见性

// --- 搜索状态 ---
const currentSearchTerm = ref(''); // 当前搜索的关键词 

// --- 文件管理器模态框与后台预加载状态 ---
const showFileManagerModal = ref(false);
const fileManagerPropsMap = shallowRef<Map<string, {
  sessionId: string;
  instanceId: string;
  dbConnectionId: string;
  wsDeps: WebSocketDependencies;
}>>(new Map());
const currentFileManagerSessionId = ref<string | null>(null);

// 是否应当在后台静默预加载文件管理器 (移动端全量预加载，桌面端开启弹窗管理器时预加载)
const shouldPreloadFileManager = computed(() => {
  return isMobile.value || settingsStore.showPopupFileManagerBoolean;
});

// 保持 currentFileManagerSessionId 默认自动跟随激活的会话
watch(activeSessionId, (newId) => {
  if (newId) {
    currentFileManagerSessionId.value = newId;
    if (shouldPreloadFileManager.value) {
      syncFileManagerProps();
    }
  }
}, { immediate: true });

// 保持 fileManagerPropsMap 与活跃 sessions 严格双向同步并预加载
const syncFileManagerProps = () => {
  if (!shouldPreloadFileManager.value) {
    return;
  }

  const currentMap = fileManagerPropsMap.value;
  const nextMap = new Map(currentMap);
  let hasChanged = false;

  // 1. 收集当前所有有效的会话 ID 集合
  const activeSessionIds = new Set<string>();

  // 遍历所有存在的会话
  const candidateSessionIds = new Set<string>([
    ...sessionTabsWithStatus.value.map(tab => tab.sessionId),
    ...sessionStore.sessions.keys(),
  ]);

  for (const sId of candidateSessionIds) {
    const session = sessionStore.sessions.get(sId);
    if (!session || !session.connectionId || !session.wsManager) {
      continue;
    }
    activeSessionIds.add(sId);

    // 检查是否已有条目（匹配 sessionId 或匹配相同的底层 wsManager 引用）
    let existingKey = nextMap.has(sId) ? sId : null;
    if (!existingKey) {
      for (const [k, v] of nextMap.entries()) {
        if (v.wsDeps.sendMessage === session.wsManager.sendMessage) {
          existingKey = k;
          break;
        }
      }
    }

    if (!existingKey) {
      const instanceId = `fm-modal-${sId}`;
      const wsDeps: WebSocketDependencies = {
        sendMessage: session.wsManager.sendMessage,
        onMessage: session.wsManager.onMessage,
        isConnected: session.wsManager.isConnected,
        isSftpReady: session.wsManager.isSftpReady,
      };
      nextMap.set(sId, {
        sessionId: sId,
        instanceId,
        dbConnectionId: String(session.connectionId),
        wsDeps,
      });
      hasChanged = true;
      console.log(`%c[WorkspaceView] 移动端/弹窗后台自动预加载 SFTP 文件管理器: ${sId} (${session.connectionName})`, 'color: #3b82f6;');
    } else if (existingKey !== sId) {
      // 键控替换（如 matchedKey 变为 backendSID），平滑迁移原有 props
      const existingProps = nextMap.get(existingKey)!;
      nextMap.delete(existingKey);
      nextMap.set(sId, {
        ...existingProps,
        sessionId: sId,
        dbConnectionId: String(session.connectionId),
      });
      hasChanged = true;
      console.log(`%c[WorkspaceView] 键控迁移: SFTP 文件管理器预加载实例已从 ${existingKey} 平滑切换至 ${sId}`, 'color: #3b82f6;');
    } else {
      const existingProps = nextMap.get(sId)!;
      // 依赖已更新（如重连/实例更新），刷新 props
      if (existingProps.dbConnectionId !== String(session.connectionId) || existingProps.wsDeps.sendMessage !== session.wsManager.sendMessage) {
        const wsDeps: WebSocketDependencies = {
          sendMessage: session.wsManager.sendMessage,
          onMessage: session.wsManager.onMessage,
          isConnected: session.wsManager.isConnected,
          isSftpReady: session.wsManager.isSftpReady,
        };
        nextMap.set(sId, {
          sessionId: sId,
          instanceId: existingProps.instanceId || `fm-modal-${sId}`,
          dbConnectionId: String(session.connectionId),
          wsDeps,
        });
        hasChanged = true;
        console.log(`%c[WorkspaceView] 更新会话 ${sId} 的移动端/弹窗 SFTP 文件管理器依赖`, 'color: #3b82f6;');
      }
    }
  }

  // 2. 清理已完全关闭或销毁的会话
  for (const sId of nextMap.keys()) {
    if (!activeSessionIds.has(sId)) {
      nextMap.delete(sId);
      hasChanged = true;
      console.log(`%c[WorkspaceView] 卸载已关闭会话的 FileManager 预加载实例: ${sId}`, 'color: #94a3b8;');
    }
  }

  if (hasChanged) {
    fileManagerPropsMap.value = nextMap;
  }
};

// 监听会话列表变化、活跃会话数量与预加载开关状态
watch(
  () => sessionTabsWithStatus.value,
  () => {
    syncFileManagerProps();
  },
  { deep: true }
);

watch(
  () => sessionStore.sessions.size,
  () => {
    syncFileManagerProps();
  }
);

watch(shouldPreloadFileManager, (shouldPreload) => {
  if (shouldPreload) {
    syncFileManagerProps();
  }
});

// --- 文件传输进度模态框状态 ---
const showTransferProgressModal = ref(false);
const handleOpenTransferProgressModal = () => {
  showTransferProgressModal.value = true;
};

// --- 快捷指令添加模态框状态 (响应终端等全局添加请求) ---
const showQuickCommandAddModal = ref(false);
const initialQuickCommandText = ref('');
const quickCommandToAddOrEdit = ref<QuickCommandFE | null>(null);

const handleRequestAddQuickCommand = (payload?: { initialCommand?: string }) => {
  quickCommandToAddOrEdit.value = null;
  initialQuickCommandText.value = payload?.initialCommand || '';
  showQuickCommandAddModal.value = true;
};

// --- 处理全局键盘事件 ---
const handleGlobalKeyDown = (event: KeyboardEvent) => {
  // 检查是否按下了 Alt 键以及上/下箭头键
  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    event.preventDefault(); // 阻止默认行为 (例如页面滚动)

    const tabs = sessionTabsWithStatus.value;
    const currentId = activeSessionId.value;

    if (!tabs || tabs.length <= 1 || !currentId) {
      // 如果没有标签页、只有一个标签页或没有活动标签页，则不执行任何操作
      return;
    }

    const currentIndex = tabs.findIndex(tab => tab.sessionId === currentId);
    if (currentIndex === -1) {
      // 如果找不到当前活动标签页 (理论上不应发生)，则不执行任何操作
      return;
    }

    let nextIndex: number;
    if (event.key === 'ArrowDown') {
      // Alt + 下箭头：切换到下一个标签页
      nextIndex = (currentIndex + 1) % tabs.length;
    } else {
      // Alt + 上箭头：切换到上一个标签页
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    }

    const nextSessionId = tabs[nextIndex].sessionId;
    if (nextSessionId !== currentId) {
      console.log(`[WorkspaceView] Alt+${event.key} detected. Switching to session: ${nextSessionId}`);
      sessionStore.activateSession(nextSessionId);
    }
  }
};

// --- 生命周期钩子 ---
onMounted(() => {
  console.log('[工作区视图] 组件已挂载。');
  // 添加键盘事件监听器
  window.addEventListener('keydown', handleGlobalKeyDown);
  // 确保布局已初始化 (layoutStore 内部会处理)

  // 保证多端与隐藏侧边栏场景下，连接与标签数据全量就绪
  connectionsStore.fetchConnections().catch((err) => console.error('[工作区] 加载连接列表失败:', err));
  tagsStore.fetchTags().catch((err) => console.error('[工作区] 加载标签列表失败:', err));

  // +++ 订阅工作区事件 +++
  subscribeToWorkspaceEvents('terminal:sendCommand', (payload) => handleSendCommand(payload.command, payload.sessionId));
  subscribeToWorkspaceEvents('terminal:input', handleTerminalInput);
  subscribeToWorkspaceEvents('terminal:resize', handleTerminalResize);
  subscribeToWorkspaceEvents('terminal:ready', handleTerminalReady);
  subscribeToWorkspaceEvents('terminal:clear', handleClearTerminal);
  subscribeToWorkspaceEvents('terminal:scrollToBottomRequest', handleScrollToBottomRequest);

  subscribeToWorkspaceEvents('editor:closeTab', (payload) => handleCloseEditorTab(payload.tabId));
  subscribeToWorkspaceEvents('editor:activateTab', (payload) => handleActivateEditorTab(payload.tabId));
  subscribeToWorkspaceEvents('editor:updateContent', handleUpdateEditorContent);
  subscribeToWorkspaceEvents('editor:saveTab', (payload) => handleSaveEditorTab(payload.tabId));
  subscribeToWorkspaceEvents('editor:changeEncoding', handleChangeEncoding);
  subscribeToWorkspaceEvents('editor:closeOtherTabs', (payload) => handleCloseOtherEditorTabs(payload.tabId));
  subscribeToWorkspaceEvents('editor:closeTabsToRight', (payload) => handleCloseEditorTabsToRight(payload.tabId));
  subscribeToWorkspaceEvents('editor:closeTabsToLeft', (payload) => handleCloseEditorTabsToLeft(payload.tabId));
  subscribeToWorkspaceEvents('editor:updateScrollPosition', handleEditorScrollPositionUpdate); // +++ 订阅滚动位置更新事件 +++
 
  // 移除对 connection:connect 事件的监听，以避免重复创建会话
  // subscribeToWorkspaceEvents('connection:connect', (payload) => handleConnectRequest(payload.connectionId));
  subscribeToWorkspaceEvents('connection:openNewSession', (payload) => handleOpenNewSession(payload.connectionId));
  subscribeToWorkspaceEvents('connection:requestAdd', handleRequestAddConnection);
  subscribeToWorkspaceEvents('connection:requestEdit', (payload) => handleRequestEditConnection(payload.connectionInfo));

  subscribeToWorkspaceEvents('search:start', (payload) => handleSearch(payload.term));
  subscribeToWorkspaceEvents('search:findNext', handleFindNext);
  subscribeToWorkspaceEvents('search:findPrevious', handleFindPrevious);
  subscribeToWorkspaceEvents('search:close', handleCloseSearch);

  // 来自 TerminalTabBar 的事件
  subscribeToWorkspaceEvents('session:activate', (payload) => sessionStore.activateSession(payload.sessionId));
  subscribeToWorkspaceEvents('session:close', (payload) => sessionStore.closeSession(payload.sessionId));
  subscribeToWorkspaceEvents('session:closeOthers', (payload) => handleCloseOtherSessions(payload.targetSessionId));
  subscribeToWorkspaceEvents('session:closeToRight', (payload) => handleCloseSessionsToRight(payload.targetSessionId));
  subscribeToWorkspaceEvents('session:closeToLeft', (payload) => handleCloseSessionsToLeft(payload.targetSessionId));
  subscribeToWorkspaceEvents('ui:openLayoutConfigurator', handleOpenLayoutConfigurator);
  subscribeToWorkspaceEvents('ui:openTransferProgressModal', handleOpenTransferProgressModal);
  subscribeToWorkspaceEvents('fileManager:openModalRequest', handleFileManagerOpenRequest); // +++ 订阅文件管理器打开请求 +++
  subscribeToWorkspaceEvents('quickCommand:executeProcessed', handleQuickCommandExecuteProcessed);
  subscribeToWorkspaceEvents('quickCommand:requestAdd', handleRequestAddQuickCommand);

  // 初始化工作区实时云端同步与多端互斥租约
  workspaceSyncStore.initSync();
  subscribeToWorkspaceEvents('workspace:takeoverKickout', (payload) => {
    workspaceSyncStore.handleTakeoverKickout(payload.activeClientId);
  });
  subscribeToWorkspaceEvents('workspace:requestStateSave', () => {
    workspaceSyncStore.triggerDebouncedSave();
  });
});

// 监听会话、共享编辑器与所有会话独立编辑器的变化，自动向云端保存工作区
const sessionEditorTabsSignature = computed(() => {
  return Array.from(sessionStore.sessions.entries()).map(([id, s]) => {
    const tabsCount = s.editorTabs?.value?.length || 0;
    const activeTab = s.activeEditorTabId?.value || '';
    const tabsKey = (s.editorTabs?.value || []).map(t => `${t.id}:${t.isModified}`).join('|');
    return `${id}:${tabsCount}:${activeTab}:${tabsKey}`;
  }).join(';');
});

watch(
  [
    activeSessionId,
    () => sessionStore.sessions.size,
    () => fileEditorStore.orderedTabs.length,
    () => fileEditorStore.activeTabId,
    sessionEditorTabsSignature,
  ],
  () => {
    if (workspaceSyncStore.syncEnabled && !workspaceSyncStore.isRestoring && !workspaceSyncStore.isTakenOver) {
      workspaceSyncStore.triggerDebouncedSave();
    }
  }
);

onBeforeUnmount(() => {
  console.log('[工作区视图] 组件即将卸载，清理所有会话...');
  // 移除键盘事件监听器
  window.removeEventListener('keydown', handleGlobalKeyDown);
  sessionStore.cleanupAllSessions();

  // +++ 取消订阅工作区事件 +++
  unsubscribeFromWorkspaceEvents('terminal:sendCommand', (payload) => handleSendCommand(payload.command, payload.sessionId));
  unsubscribeFromWorkspaceEvents('terminal:input', handleTerminalInput);
  unsubscribeFromWorkspaceEvents('terminal:resize', handleTerminalResize);
  unsubscribeFromWorkspaceEvents('terminal:ready', handleTerminalReady);
  unsubscribeFromWorkspaceEvents('terminal:clear', handleClearTerminal);
  unsubscribeFromWorkspaceEvents('terminal:scrollToBottomRequest', handleScrollToBottomRequest);

  unsubscribeFromWorkspaceEvents('editor:closeTab', (payload) => handleCloseEditorTab(payload.tabId));
  unsubscribeFromWorkspaceEvents('editor:activateTab', (payload) => handleActivateEditorTab(payload.tabId));
  unsubscribeFromWorkspaceEvents('editor:updateContent', handleUpdateEditorContent);
  unsubscribeFromWorkspaceEvents('editor:saveTab', (payload) => handleSaveEditorTab(payload.tabId));
  unsubscribeFromWorkspaceEvents('editor:changeEncoding', handleChangeEncoding);
  unsubscribeFromWorkspaceEvents('editor:closeOtherTabs', (payload) => handleCloseOtherEditorTabs(payload.tabId));
  unsubscribeFromWorkspaceEvents('editor:closeTabsToRight', (payload) => handleCloseEditorTabsToRight(payload.tabId));
  unsubscribeFromWorkspaceEvents('editor:closeTabsToLeft', (payload) => handleCloseEditorTabsToLeft(payload.tabId));
  unsubscribeFromWorkspaceEvents('editor:updateScrollPosition', handleEditorScrollPositionUpdate); // +++ 取消订阅滚动位置更新事件 +++
 
  // 移除对 connection:connect 事件的监听，以避免重复创建会话
  // unsubscribeFromWorkspaceEvents('connection:connect', (payload) => handleConnectRequest(payload.connectionId));
  unsubscribeFromWorkspaceEvents('connection:openNewSession', (payload) => handleOpenNewSession(payload.connectionId));
  unsubscribeFromWorkspaceEvents('connection:requestAdd', handleRequestAddConnection);
  unsubscribeFromWorkspaceEvents('connection:requestEdit', (payload) => handleRequestEditConnection(payload.connectionInfo));

  unsubscribeFromWorkspaceEvents('search:start', (payload) => handleSearch(payload.term));
  unsubscribeFromWorkspaceEvents('search:findNext', handleFindNext);
  unsubscribeFromWorkspaceEvents('search:findPrevious', handleFindPrevious);
  unsubscribeFromWorkspaceEvents('search:close', handleCloseSearch);

  unsubscribeFromWorkspaceEvents('session:activate', (payload) => sessionStore.activateSession(payload.sessionId));
  unsubscribeFromWorkspaceEvents('session:close', (payload) => sessionStore.closeSession(payload.sessionId));
  unsubscribeFromWorkspaceEvents('session:closeOthers', (payload) => handleCloseOtherSessions(payload.targetSessionId));
  unsubscribeFromWorkspaceEvents('session:closeToRight', (payload) => handleCloseSessionsToRight(payload.targetSessionId));
  unsubscribeFromWorkspaceEvents('session:closeToLeft', (payload) => handleCloseSessionsToLeft(payload.targetSessionId));
  unsubscribeFromWorkspaceEvents('ui:openLayoutConfigurator', handleOpenLayoutConfigurator);
  unsubscribeFromWorkspaceEvents('ui:openTransferProgressModal', handleOpenTransferProgressModal);
  unsubscribeFromWorkspaceEvents('fileManager:openModalRequest', handleFileManagerOpenRequest); // +++ 取消订阅文件管理器打开请求 +++
  unsubscribeFromWorkspaceEvents('quickCommand:executeProcessed', handleQuickCommandExecuteProcessed);
  unsubscribeFromWorkspaceEvents('quickCommand:requestAdd', handleRequestAddQuickCommand);
  unsubscribeFromWorkspaceEvents('workspace:takeoverKickout', (payload) => {
    workspaceSyncStore.handleTakeoverKickout(payload.activeClientId);
  });
  unsubscribeFromWorkspaceEvents('workspace:requestStateSave', () => {
    workspaceSyncStore.triggerDebouncedSave();
  });
});

const subscribeToWorkspaceEvents = useWorkspaceEventSubscriber(); // +++ 定义订阅和取消订阅函数 +++
const unsubscribeFromWorkspaceEvents = useWorkspaceEventOff();

 // --- 本地方法 (仅处理 UI 状态) ---
 const handleRequestAddConnection = () => {
   console.log('[WorkspaceView] handleRequestAddConnection 被调用！');
   connectionToEdit.value = null;
   showAddEditForm.value = true;
 };

 const handleRequestEditConnection = (connection: ConnectionInfo) => {
   connectionToEdit.value = connection;
   showAddEditForm.value = true;
 };

 const handleFormClose = () => {
   showAddEditForm.value = false;
   connectionToEdit.value = null;
 };

 const handleConnectionAdded = () => {
   console.log('[工作区视图] 连接已添加');
   handleFormClose();
 };

 const handleConnectionUpdated = () => {
   console.log('[工作区视图] 连接已更新');
   handleFormClose();
 };

 // 处理打开和关闭布局配置器
 const handleOpenLayoutConfigurator = () => {
   showLayoutConfigurator.value = true;
 };
 const handleCloseLayoutConfigurator = () => {
   showLayoutConfigurator.value = false;
 };

 // --- 事件处理 (传递给 LayoutRenderer 或直接使用) ---

 // 处理命令发送 (用于 CommandBar, CommandHistory, QuickCommands)
 const handleSendCommand = (command: string, targetSessionId?: string) => {
   const sessionToCommand = targetSessionId ? sessionStore.sessions.get(targetSessionId) : activeSession.value;

   if (!sessionToCommand) {
     const idForLog = targetSessionId || 'active (none found)';
     console.warn(`[WorkspaceView] Cannot send command, no session found for ID: ${idForLog}.`);
     return;
   }
   const terminalManager = sessionToCommand.terminalManager as (SshTerminalInstance | undefined);

   if (terminalManager?.isSshConnected && !terminalManager.isSshConnected.value && command.trim() === '') {
     console.log(`[WorkspaceView] Command bar Enter detected in disconnected session ${sessionToCommand.sessionId}, attempting reconnect...`);
     if (terminalManager.terminalInstance?.value) {
         terminalManager.terminalInstance.value.writeln(`\r\n\x1b[33m${t('workspace.terminal.reconnectingMsg')}\x1b[0m`);
     }
     const connectionInfo = connectionsStore.connections.find(c => c.id === Number(sessionToCommand.connectionId));
     if (connectionInfo) {
       sessionStore.handleConnectRequest(connectionInfo);
     } else {
       console.error(`[WorkspaceView] handleSendCommand: 未找到 ID 为 ${sessionToCommand.connectionId} 的连接信息。`);
     }
     return;
   }

   if (terminalManager && typeof terminalManager.sendData === 'function') {
     const commandToSend = command.trim(); // Keep trimmed for history
     console.log(`[WorkspaceView] Sending command/data to session ${sessionToCommand.sessionId}: ${JSON.stringify(command)}`); // Log raw command
     // Only append '\r' for regular commands, not for control characters like Ctrl+C (\x03)
     // Send the raw command as received by the function for control characters
     const dataToSend = command === '\x03' ? command : command + '\r';
     terminalManager.sendData(dataToSend);

     // Add to history only if it's a user-typed command (not just Enter or control chars)
     // And only if the command is being sent to the active session (to avoid polluting history from "send to all")
     if (commandToSend.length > 0 && command !== '\x03' && sessionToCommand.sessionId === activeSessionId.value) {
       commandHistoryStore.addCommand(commandToSend);
     }
     workspaceSyncStore.triggerDebouncedSave(1500);
   } else {
     console.warn(`[WorkspaceView] Cannot send command for session ${sessionToCommand.sessionId}, terminal manager or sendData method not available.`);
   }
 };

 // 处理终端输入 (用于 Terminal)
 // 注意：LayoutRenderer 内部的 Terminal 组件需要 emit('terminal-input', sessionId, data)
 const handleTerminalInput = (payload: { sessionId: string; data: string }) => {
   const { sessionId, data } = payload; // 解构 payload
   const session = sessionStore.sessions.get(sessionId);
   const manager = session?.terminalManager as (SshTerminalInstance | undefined);
   if (!session || !manager) {
     console.warn(`[WorkspaceView] handleTerminalInput: 未找到会话 ${sessionId} 或其 terminalManager`);
     return;
   }
   if (data === '\r' && manager.isSshConnected && !manager.isSshConnected.value) {
     console.log(`[WorkspaceView] 检测到在断开的会话 ${sessionId} 中按下回车，尝试重连...`);
     if (manager.terminalInstance?.value) {
         manager.terminalInstance.value.writeln(`\r\n\x1b[33m${t('workspace.terminal.reconnectingMsg')}\x1b[0m`);
     } else {
         console.warn(`[WorkspaceView] 无法写入重连提示，terminalInstance 不可用。`);
     }
     // +++ 修复：传递 ConnectionInfo 而不是 ID +++
     const connectionInfo = connectionsStore.connections.find(c => c.id === Number(session.connectionId));
     if (connectionInfo) {
       sessionStore.handleConnectRequest(connectionInfo);
     } else {
       console.error(`[WorkspaceView] handleTerminalInput: 未找到 ID 为 ${session.connectionId} 的连接信息。`);
     }
   } else {
     manager.handleTerminalData(data);
   }
 };

 // 处理终端大小调整 (用于 Terminal)
 // 注意：LayoutRenderer 内部的 Terminal 组件需要 emit('terminal-resize', sessionId, dims)
 const handleTerminalResize = (payload: { sessionId: string; dims: { cols: number; rows: number } }) => {
    sessionStore.sessions.get(payload.sessionId)?.terminalManager.handleTerminalResize(payload.dims);
 };

 // 处理终端就绪 (用于 Terminal)
 // 注意：LayoutRenderer 内部的 Terminal 组件需要 emit('terminal-ready', payload)
 // *** 修正：更新 payload 类型以包含 searchAddon ***
 const handleTerminalReady = (payload: { sessionId: string; terminal: XtermTerminal; searchAddon: any | null }) => { // --- 使用重命名的 XtermTerminal ---
    console.log(`[工作区视图 ${payload.sessionId}] 收到 terminal-ready 事件。Payload:`, payload); // *** 添加 Payload 日志 ***
    // *** 检查 payload 中 searchAddon 是否存在 ***
    if (payload && payload.searchAddon) {
        console.log(`[工作区视图 ${payload.sessionId}] Payload 包含 searchAddon 实例。`);
    } else {
        console.warn(`[工作区视图 ${payload.sessionId}] Payload 未包含 searchAddon 实例！ Payload:`, payload);
    }
    // *** 修正：传递包含 terminal 和 searchAddon 的完整 payload ***
    sessionStore.sessions.get(payload.sessionId)?.terminalManager.handleTerminalReady(payload);
};

// --- 搜索事件处理 ---
const handleSearch = (term: string) => { // +++ 修改 +++
  currentSearchTerm.value = term;
  if (!term) {
    // 如果搜索词为空，清除搜索
    handleCloseSearch();
    return;
  }
  console.log(`[WorkspaceView] Received search event: "${term}"`);
  // 默认向前搜索
  // 触发 findNext
  handleFindNext(); // 保持调用 findNext，内部会处理 isMobile
};

const handleFindNext = () => {
  const manager = activeSession.value?.terminalManager;
  if (manager && currentSearchTerm.value) {
    const mode = isMobile.value ? 'Mobile' : 'Desktop';
    console.log(`[WorkspaceView ${mode}] Calling findNext for term: "${currentSearchTerm.value}"`);
    const found = manager.searchNext(currentSearchTerm.value, { incremental: true });
    console.log(`[WorkspaceView ${mode}] findNext returned: ${found}`);
    if (!found) {
      console.log(`[WorkspaceView ${mode}] findNext: No more results for "${currentSearchTerm.value}"`);
    }
  } else {
    const mode = isMobile.value ? 'Mobile' : 'Desktop';
    console.warn(`[WorkspaceView ${mode}] Cannot findNext, no active session manager or search term.`);
  }
};

const handleFindPrevious = () => {
  const manager = activeSession.value?.terminalManager;
  if (manager && currentSearchTerm.value) {
    const mode = isMobile.value ? 'Mobile' : 'Desktop';
    console.log(`[WorkspaceView ${mode}] Calling findPrevious for term: "${currentSearchTerm.value}"`);
    const found = manager.searchPrevious(currentSearchTerm.value, { incremental: true });
    console.log(`[WorkspaceView ${mode}] findPrevious returned: ${found}`);
    if (!found) {
      console.log(`[WorkspaceView ${mode}] findPrevious: No previous results for "${currentSearchTerm.value}"`);
    }
  } else {
    const mode = isMobile.value ? 'Mobile' : 'Desktop';
    console.warn(`[WorkspaceView ${mode}] Cannot findPrevious, no active session manager or search term.`);
  }
};

const handleCloseSearch = () => {
  console.log(`[WorkspaceView] Received close-search event.`);
  currentSearchTerm.value = ''; // 清空搜索词
  const manager = activeSession.value?.terminalManager;
  const mode = isMobile.value ? 'Mobile' : 'Desktop';
  if (manager) {
    manager.clearTerminalSearch();
    console.log(`[WorkspaceView ${mode}] Search cleared.`);
  } else {
    console.warn(`[WorkspaceView ${mode}] Cannot clear search, no active session manager.`);
  }
};

// +++ 处理清空终端事件 +++
const handleClearTerminal = () => {
  const currentSession = activeSession.value;
  if (!currentSession) {
    console.warn('[WorkspaceView] Cannot clear terminal, no active session.');
    return;
  }
  const terminalManager = currentSession.terminalManager as (SshTerminalInstance | undefined);
  const mode = isMobile.value ? 'Mobile' : 'Desktop';

  if (terminalManager && terminalManager.terminalInstance?.value && typeof terminalManager.terminalInstance.value.clear === 'function') {
    console.log(`[WorkspaceView ${mode}] Clearing terminal for active session ${currentSession.sessionId}`);
    terminalManager.terminalInstance.value.clear();
    // 立即触发云端同步保存，保存清空后的空终端缓冲区 (200ms 防抖)
    workspaceSyncStore.triggerDebouncedSave(200);
  } else {
    console.warn(`[WorkspaceView ${mode}] Cannot clear terminal for session ${currentSession.sessionId}, terminal manager, instance, or clear method not available.`);
  }
};

// +++ 处理滚动到底部请求 +++
const handleScrollToBottomRequest = (payload: { sessionId: string }) => {
  const session = sessionStore.sessions.get(payload.sessionId);
  const terminalManager = session?.terminalManager as (SshTerminalInstance | undefined);
  if (terminalManager?.terminalInstance?.value) {
    console.log(`[WorkspaceView] Scrolling to bottom for session ${payload.sessionId}`);
    terminalManager.terminalInstance.value.scrollToBottom();
  } else {
    console.warn(`[WorkspaceView] Cannot scroll to bottom for session ${payload.sessionId}, terminal instance not found.`);
  }
};

// Removed computed properties for search results, will pass manager directly
// --- 编辑器操作处理 (用于 FileEditorContainer) ---
const handleCloseEditorTab = (tabId: string) => {
   const isShared = shareFileEditorTabsBoolean.value;
   console.log(`[WorkspaceView] handleCloseEditorTab: ${tabId}, Shared mode: ${isShared}`);
   if (isShared) {
     fileEditorStore.closeTab(tabId);
   } else {
     const currentActiveSessionId = activeSessionId.value;
     if (currentActiveSessionId) {
       sessionStore.closeEditorTabInSession(currentActiveSessionId, tabId);
     } else {
       console.warn('[WorkspaceView] Cannot close editor tab: No active session in independent mode.');
     }
   }
   workspaceSyncStore.triggerDebouncedSave();
 };

 const handleActivateEditorTab = (tabId: string) => {
   const isShared = shareFileEditorTabsBoolean.value;
   console.log(`[WorkspaceView] handleActivateEditorTab: ${tabId}, Shared mode: ${isShared}`);
   if (isShared) {
     fileEditorStore.setActiveTab(tabId);
   } else {
     const currentActiveSessionId = activeSessionId.value;
     if (currentActiveSessionId) {
       sessionStore.setActiveEditorTabInSession(currentActiveSessionId, tabId);
     } else {
       console.warn('[WorkspaceView] Cannot activate editor tab: No active session in independent mode.');
     }
   }
   workspaceSyncStore.triggerDebouncedSave();
 };

 const handleUpdateEditorContent = (payload: { tabId: string; content: string }) => {
   const isShared = shareFileEditorTabsBoolean.value;
   console.log(`[WorkspaceView] handleUpdateEditorContent for tab ${payload.tabId}, Shared mode: ${isShared}`);
   if (isShared) {
     fileEditorStore.updateFileContent(payload.tabId, payload.content);
   } else {
     const currentActiveSessionId = activeSessionId.value;
     if (currentActiveSessionId) {
       sessionStore.updateFileContentInSession(currentActiveSessionId, payload.tabId, payload.content);
     } else {
       console.warn('[WorkspaceView] Cannot update editor content: No active session in independent mode.');
     }
   }
   workspaceSyncStore.triggerDebouncedSave();
 };

 const handleSaveEditorTab = (tabId: string) => {
   const isShared = shareFileEditorTabsBoolean.value;
   console.log(`[WorkspaceView] handleSaveEditorTab: ${tabId}, Shared mode: ${isShared}`);
   if (isShared) {
     fileEditorStore.saveFile(tabId);
   } else {
     const currentActiveSessionId = activeSessionId.value;
     if (currentActiveSessionId) {
       sessionStore.saveFileInSession(currentActiveSessionId, tabId);
     } else {
       console.warn('[WorkspaceView] Cannot save editor tab: No active session in independent mode.');
     }
   }
   workspaceSyncStore.triggerDebouncedSave();
 };

 // +++ 处理编辑器编码更改事件 +++
 const handleChangeEncoding = (payload: { tabId: string; encoding: string }) => {
   const isShared = shareFileEditorTabsBoolean.value;
   console.log(`[WorkspaceView] handleChangeEncoding for tab ${payload.tabId} to ${payload.encoding}, Shared mode: ${isShared}`);
   if (isShared) {
     fileEditorStore.changeEncoding(payload.tabId, payload.encoding);
   } else {
     const currentActiveSessionId = activeSessionId.value;
     if (currentActiveSessionId) {
       // 假设 sessionStore 有一个 changeEncodingInSession 方法
       sessionStore.changeEncodingInSession(currentActiveSessionId, payload.tabId, payload.encoding);
     } else {
       console.warn('[WorkspaceView] Cannot change editor encoding: No active session in independent mode.');
     }
   }
   workspaceSyncStore.triggerDebouncedSave();
 };
 
 // +++ 处理编辑器滚动位置更新事件 (由 FileEditorContainer 发出) +++
 const handleEditorScrollPositionUpdate = (payload: { tabId: string; scrollTop: number; scrollLeft: number }) => {
   const { tabId, scrollTop, scrollLeft } = payload;
   if (shareFileEditorTabsBoolean.value) {
     fileEditorStore.updateTabScrollPosition(tabId, scrollTop, scrollLeft);
   } else {
     const currentActiveSession = activeSession.value;
     if (currentActiveSession) {
       // 假设 tabId 在当前活动会话的编辑器标签中是唯一的
       sessionStore.updateTabScrollPositionInSession(currentActiveSession.sessionId, tabId, scrollTop, scrollLeft);
     } else {
       console.warn('[WorkspaceView] Cannot update editor scroll position: No active session in independent mode for tab:', tabId);
     }
   }
   workspaceSyncStore.triggerDebouncedSave();
 };

 // --- 连接列表操作处理 (用于 WorkspaceConnectionList) ---
 const handleConnectRequest = (id: number) => {
   const connectionInfo = connectionsStore.connections.find(c => c.id === id);
   // console.log(`[WorkspaceView] Received 'connect-request' event for ID: ${id}`); // 保留原始日志或移除
   if (connectionInfo) {
     sessionStore.handleConnectRequest(connectionInfo);
   } else {
     console.error(`[WorkspaceView] handleConnectRequest: Connection info not found for ID ${id}.`); // 保留错误日志
   }
 };
 const handleOpenNewSession = (id: number) => {
    console.log(`[WorkspaceView] Received 'open-new-session' event for ID: ${id}`);
    sessionStore.handleOpenNewSession(id);
 };

 // --- 会话标签页关闭操作处理 (由事件总线或子组件调用) ---
 const handleCloseOtherSessions = (targetSessionId: string) => {
   const sessionsToClose = sessionTabsWithStatus.value
     .filter(tab => tab.sessionId !== targetSessionId)
     .map(tab => tab.sessionId);
   sessionsToClose.forEach(id => sessionStore.closeSession(id));
 };

 const handleCloseSessionsToRight = (targetSessionId: string) => {
   const targetIndex = sessionTabsWithStatus.value.findIndex(tab => tab.sessionId === targetSessionId);
   if (targetIndex === -1) return;
   const sessionsToClose = sessionTabsWithStatus.value
     .slice(targetIndex + 1)
     .map(tab => tab.sessionId);
   sessionsToClose.forEach(id => sessionStore.closeSession(id));
 };

 const handleCloseSessionsToLeft = (targetSessionId: string) => {
   const targetIndex = sessionTabsWithStatus.value.findIndex(tab => tab.sessionId === targetSessionId);
   if (targetIndex === -1) return;
   const sessionsToClose = sessionTabsWithStatus.value
     .slice(0, targetIndex)
     .map(tab => tab.sessionId);
   sessionsToClose.forEach(id => sessionStore.closeSession(id));
 };

 const handleCloseOtherEditorTabs = (targetTabId: string) => {
   const tabsToClose = editorTabs.value
     .filter(tab => tab.id !== targetTabId)
     .map(tab => tab.id);
   tabsToClose.forEach(id => handleCloseEditorTab(id)); // Reuse existing close logic
 };

 const handleCloseEditorTabsToRight = (targetTabId: string) => {
   const targetIndex = editorTabs.value.findIndex(tab => tab.id === targetTabId);
   if (targetIndex === -1) return;
   const tabsToClose = editorTabs.value
     .slice(targetIndex + 1)
     .map(tab => tab.id);
   tabsToClose.forEach(id => handleCloseEditorTab(id));
 };

 const handleCloseEditorTabsToLeft = (targetTabId: string) => {
   const targetIndex = editorTabs.value.findIndex(tab => tab.id === targetTabId);
   if (targetIndex === -1) return;
   const tabsToClose = editorTabs.value
     .slice(0, targetIndex)
     .map(tab => tab.id);
   tabsToClose.forEach(id => handleCloseEditorTab(id));
 };

// --- 文件管理器模态框处理 ---
const handleFileManagerOpenRequest = (payload: { sessionId: string }) => {
  const { sessionId } = payload;
  const session = sessionStore.sessions.get(sessionId);
  if (!session) {
    console.error(`[WorkspaceView] Cannot open file manager: Session ${sessionId} not found.`);
    // TODO: Show error notification
    return;
  }

  // 1. 获取或复用预加载好的 props
  let currentProps = fileManagerPropsMap.value.get(sessionId);
  if (!currentProps) {
    const dbConnectionId = session.connectionId;
    if (!dbConnectionId) {
      console.error(`[WorkspaceView] Cannot open file manager: Missing dbConnectionId for session ${sessionId}.`);
      return;
    }

    if (!session.wsManager) {
      console.error(`[WorkspaceView] Cannot open file manager: wsManager not found for session ${sessionId}.`);
      return;
    }
    const wsDeps: WebSocketDependencies = {
      sendMessage: session.wsManager.sendMessage,
      onMessage: session.wsManager.onMessage,
      isConnected: session.wsManager.isConnected,
      isSftpReady: session.wsManager.isSftpReady,
    };
    const instanceId = `fm-modal-${sessionId}`;
    currentProps = {
      sessionId,
      instanceId,
      dbConnectionId: String(dbConnectionId),
      wsDeps,
    };
    const nextMap = new Map(fileManagerPropsMap.value);
    nextMap.set(sessionId, currentProps);
    fileManagerPropsMap.value = nextMap;
  }

  currentFileManagerSessionId.value = sessionId;
  showFileManagerModal.value = true;
  console.log(`[WorkspaceView] Opening FileManager modal for session ${sessionId}:`, currentProps);
};

// --- 处理 quickCommand:executeProcessed 事件 ---
const handleQuickCommandExecuteProcessed = (payload: WorkspaceEventPayloads['quickCommand:executeProcessed']) => {
  const { command, sessionId: targetSessionId } = payload;
  console.log(`[WorkspaceView] Received quickCommand:executeProcessed event. Command: "${command}", TargetSessionID: ${targetSessionId}`);

  // 使用现有的 handleSendCommand 逻辑来发送指令
  // handleSendCommand 会处理 sessionId 未定义时使用 activeSessionId 的情况
  handleSendCommand(command, targetSessionId);
};

const closeFileManagerModal = () => {
  showFileManagerModal.value = false;
  console.log('[WorkspaceView] FileManager modal hidden (kept alive).');
};

</script>

<template>
  <!-- *** 动态 class 绑定，添加 is-mobile 类 *** -->
  <div :class="['workspace-view', { 'with-header': isHeaderVisible, 'is-mobile': isMobile }]">
    <!-- 桌面端工作区独立解耦视图 -->
    <DesktopWorkspaceView
      v-if="!isMobile"
      :sessions="sessionTabsWithStatus"
      :active-session-id="activeSessionId"
      :layout-tree="layoutTree"
      :layout-locked="layoutLockedBoolean"
      :editor-tabs="editorTabs"
      :active-editor-tab-id="activeEditorTabId"
      @open-layout-configurator="handleOpenLayoutConfigurator"
      @request-add-connection="handleRequestAddConnection"
      @request-edit-connection="handleRequestEditConnection"
    />

    <!-- 移动端工作区独立解耦视图 -->
    <MobileWorkspaceView
      v-else
      :sessions="sessionTabsWithStatus"
      :active-session-id="activeSessionId"
      :layout-locked="layoutLockedBoolean"
      :editor-tabs="editorTabs"
      :active-editor-tab-id="activeEditorTabId"
      @open-layout-configurator="handleOpenLayoutConfigurator"
      @request-add-connection="handleRequestAddConnection"
      @request-edit-connection="handleRequestEditConnection"
      @send-command="handleSendCommand"
      @search="handleSearch"
      @find-next="handleFindNext"
      @find-previous="handleFindPrevious"
      @close-search="handleCloseSearch"
      @clear-terminal="handleClearTerminal"
    />

    <!-- Modals 保持不变，应在布局之外 -->
    <AddConnectionFormComponent
      v-if="showAddEditForm"
      :connection-to-edit="connectionToEdit"
      :is-mobile="isMobile"
      @close="handleFormClose"
      @connection-added="handleConnectionAdded"
      @connection-updated="handleConnectionUpdated"
    />

    <LayoutConfigurator
      :is-visible="showLayoutConfigurator"
      @close="handleCloseLayoutConfigurator"
    />

    <!-- RDP Modal is now rendered in App.vue -->
    <!-- VNC Modal is now rendered in App.vue -->

    <!-- FileManager Modal (包含桌面端居中弹窗与移动端 Bottom Sheet 抽屉) -->
    <FileManagerModal
      :visible="showFileManagerModal"
      :session-id="currentFileManagerSessionId"
      :session-name="currentFileManagerSessionId ? (sessionStore.sessions.get(currentFileManagerSessionId)?.connectionName || currentFileManagerSessionId) : null"
      :file-manager-props-map="fileManagerPropsMap"
      :is-mobile="isMobile"
      @close="closeFileManagerModal"
    />

    <!-- Transfer Progress Modal (包含桌面端居中弹窗与移动端 Bottom Sheet 抽屉) -->
    <TransferProgressModal
      v-model:visible="showTransferProgressModal"
      :is-mobile="isMobile"
    />

    <!-- Quick Command Add Modal -->
    <AddEditQuickCommandForm
      v-if="showQuickCommandAddModal"
      :command-to-edit="quickCommandToAddOrEdit"
      :initial-command="initialQuickCommandText"
      @close="() => { showQuickCommandAddModal = false; quickCommandToAddOrEdit = null; initialQuickCommandText = ''; }"
    />

    <!-- 工作区多端/多标签互斥接管全局遮罩 -->
    <WorkspaceTakeoverOverlay />

  </div>
</template>

<style scoped>
.workspace-view {
  display: flex;
  background-color: transparent;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.workspace-view.is-mobile {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}
</style>
