<script setup lang="ts">
import { onMounted, onBeforeUnmount, computed, ref, shallowRef, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useLayoutStore, type LayoutNode } from '../stores/layout.store'; // +++ Import LayoutNode +++
import { useDeviceDetection } from '../composables/useDeviceDetection';
import { useConnectionsStore, type ConnectionInfo } from '../stores/connections.store';
import { useTagsStore } from '../stores/tags.store';
import AddConnectionFormComponent from '../components/AddConnectionForm.vue';
import TerminalTabBar from '../components/TerminalTabBar.vue';
import LayoutRenderer from '../components/LayoutRenderer.vue';
import LayoutConfigurator from '../components/LayoutConfigurator.vue';
import Terminal from '../components/Terminal.vue';
import CommandInputBar from '../components/CommandInputBar.vue'; 
import VirtualKeyboard from '../components/VirtualKeyboard.vue';
import FileManager from '../components/FileManager.vue'; 
import { useSessionStore } from '../stores/session.store';
import type { SessionTabInfoWithStatus, SshTerminalInstance } from '../stores/session/types';
import { useSettingsStore } from '../stores/settings.store';
import { useFileEditorStore, type FileTab } from '../stores/fileEditor.store';
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

// +++ Add computed property for mobile terminal layout node +++
const mobileLayoutNodeForTerminal = computed((): LayoutNode | null => {
  return {
    id: 'mobile-main-terminal-pane',
    type: 'pane' as const,
    component: 'terminal' as const,
    size: 100,
  };
});

// --- UI 状态 (保持本地) ---
const showAddEditForm = ref(false);
const connectionToEdit = ref<ConnectionInfo | null>(null);
const showLayoutConfigurator = ref(false); // 控制布局配置器可见性
// 本地 RDP 状态已被移除

// --- 搜索状态 ---
const currentSearchTerm = ref(''); // 当前搜索的关键词
const mobileTerminalRef = ref<InstanceType<typeof Terminal> | null>(null);
const isVirtualKeyboardVisible = ref(false); 

// --- 文件管理器模态框状态 ---
const showFileManagerModal = ref(false);
const fileManagerPropsMap = shallowRef<Map<string, {
  sessionId: string;
  instanceId: string;
  dbConnectionId: string;
  wsDeps: WebSocketDependencies;
}>>(new Map());
const currentFileManagerSessionId = ref<string | null>(null);

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
  subscribeToWorkspaceEvents('fileManager:openModalRequest', handleFileManagerOpenRequest); // +++ 订阅文件管理器打开请求 +++
  subscribeToWorkspaceEvents('quickCommand:executeProcessed', handleQuickCommandExecuteProcessed);
});

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
  unsubscribeFromWorkspaceEvents('fileManager:openModalRequest', handleFileManagerOpenRequest); // +++ 取消订阅文件管理器打开请求 +++
  unsubscribeFromWorkspaceEvents('quickCommand:executeProcessed', handleQuickCommandExecuteProcessed);
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

// +++ 处理虚拟键盘按键事件 +++
const handleVirtualKeyPress = (keySequence: string) => {
 const currentSession = activeSession.value;
 if (!currentSession) {
   console.warn('[WorkspaceView] Cannot send virtual key, no active session.');
   return;
 }
 // 在移动端模式下，我们假设 terminalManager 总是存在的（如果会话活动）
 // 并且直接发送数据，因为虚拟键盘通常用于发送控制字符或特殊序列
 const terminalManager = currentSession.terminalManager as (SshTerminalInstance | undefined);
 if (terminalManager && typeof terminalManager.sendData === 'function') {
   console.log(`[WorkspaceView Mobile] Sending virtual key sequence: ${JSON.stringify(keySequence)}`);
   terminalManager.sendData(keySequence);
 } else {
   console.warn(`[WorkspaceView Mobile] Cannot send virtual key for session ${currentSession.sessionId}, terminal manager or sendData method not available.`);
 }
};

// +++ Function to toggle virtual keyboard visibility +++
const toggleVirtualKeyboard = () => {
 isVirtualKeyboardVisible.value = !isVirtualKeyboardVisible.value;
};

// RDP 事件处理方法已被移除

 // --- 标签页关闭操作处理 ---

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

  // 1. 获取 dbConnectionId
  const dbConnectionId = session.connectionId;
  if (!dbConnectionId) {
    console.error(`[WorkspaceView] Cannot open file manager: Missing dbConnectionId for session ${sessionId}.`);
    // TODO: Show error notification
    return;
  }

  // 2. 获取 wsDeps (从 session.wsManager 获取)
  if (!session.wsManager) {
      console.error(`[WorkspaceView] Cannot open file manager: wsManager not found for session ${sessionId}.`);
      // TODO: Show error notification
      return;
  }
  const wsDeps: WebSocketDependencies = {
      sendMessage: session.wsManager.sendMessage,
      onMessage: session.wsManager.onMessage,
      isConnected: session.wsManager.isConnected,
      isSftpReady: session.wsManager.isSftpReady,
  };

  if (!wsDeps) {
      // 如果 wsDeps 仍然为 null，则无法继续
      console.error(`[WorkspaceView] Cannot open file manager: wsDeps are null after attempting retrieval for session ${sessionId}.`);
      return;
  }

  // 3. 生成或获取 instanceId
  const currentProps = fileManagerPropsMap.value.get(sessionId);
  const instanceId = currentProps ? currentProps.instanceId : `fm-modal-${sessionId}`;

  // 4. 设置 props 并显示模态框
  const newProps = {
    sessionId,
    instanceId,
    dbConnectionId: String(dbConnectionId), // 确保是 string
    wsDeps,
  };
  fileManagerPropsMap.value.set(sessionId, newProps);
  currentFileManagerSessionId.value = sessionId;
  showFileManagerModal.value = true;
  console.log(`[WorkspaceView] Opening FileManager modal with props for session ${sessionId}:`, newProps);
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
    <!-- --- 桌面端布局 --- -->
    <template v-if="!isMobile">
      <TerminalTabBar
        :sessions="sessionTabsWithStatus"
        :active-session-id="activeSessionId"
        :is-mobile="false"
        @activate-session="sessionStore.activateSession"
        @close-session="sessionStore.closeSession"
        @open-layout-configurator="handleOpenLayoutConfigurator"
        @request-add-connection-from-popup="handleRequestAddConnection"
        @request-edit-connection-from-popup="handleRequestEditConnection"
        @close-other-sessions="handleCloseOtherSessions"
        @close-sessions-to-right="handleCloseSessionsToRight"
        @close-sessions-to-left="handleCloseSessionsToLeft"
      />
      <div class="main-content-area">
        <LayoutRenderer
          v-if="layoutTree"
          :is-root-renderer="true"
          :layout-node="layoutTree"
          :active-session-id="activeSessionId"
          :layout-locked="layoutLockedBoolean"
          class="layout-renderer-wrapper"
          :editor-tabs="editorTabs"
          :active-editor-tab-id="activeEditorTabId"
        ></LayoutRenderer>
        <div v-else class="pane-placeholder">
          {{ t('layout.loading', '加载布局中...') }}
        </div>
      </div>
    </template>

    <!-- --- 移动端布局 --- -->
    <template v-else>
      <div class="mobile-content-area">
        <LayoutRenderer
          v-if="activeSessionId && mobileLayoutNodeForTerminal"
          :layout-node="mobileLayoutNodeForTerminal"
          :active-session-id="activeSessionId"
          :is-root-renderer="false"
          :layout-locked="layoutLockedBoolean"
          class="layout-renderer-wrapper flex-grow overflow-auto"
          :editor-tabs="editorTabs"
          :active-editor-tab-id="activeEditorTabId"
        />
        <div v-else class="pane-placeholder">
          {{ t('workspace.noActiveSession', '没有活动的会话') }}
        </div>
      </div>
      <!-- 移动端会话标签栏：自然流位于终端内容区下方、工具栏上方 -->
      <TerminalTabBar
        :sessions="sessionTabsWithStatus"
        :active-session-id="activeSessionId"
        :is-mobile="true"
        @activate-session="sessionStore.activateSession"
        @close-session="sessionStore.closeSession"
        @open-layout-configurator="handleOpenLayoutConfigurator"
        @request-add-connection-from-popup="handleRequestAddConnection"
        @request-edit-connection-from-popup="handleRequestEditConnection"
        @close-other-sessions="handleCloseOtherSessions"
        @close-sessions-to-right="handleCloseSessionsToRight"
        @close-sessions-to-left="handleCloseSessionsToLeft"
      />
      <!-- 移动端命令工具栏：自然流紧随标签栏下方 -->
      <CommandInputBar
        class="mobile-command-bar"
        :is-mobile="isMobile"
        @send-command="handleSendCommand"
        @search="handleSearch"
        @find-next="handleFindNext"
        @find-previous="handleFindPrevious"
        @close-search="handleCloseSearch"
        @clear-terminal="handleClearTerminal"
        :is-virtual-keyboard-visible="isVirtualKeyboardVisible"
        @toggle-virtual-keyboard="toggleVirtualKeyboard"
      />
      <!-- +++ Use v-show for VirtualKeyboard and bind visibility +++ -->
      <VirtualKeyboard
        v-show="isVirtualKeyboardVisible"
        class="mobile-virtual-keyboard"
        @send-key="handleVirtualKeyPress"
      />
    </template>

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

    <!-- FileManager Modal Container -->
    <div v-show="showFileManagerModal && currentFileManagerSessionId && fileManagerPropsMap.get(currentFileManagerSessionId)" class="fixed inset-0 flex items-center justify-center z-50 p-4" :style="{ backgroundColor: 'var(--overlay-bg-color)' }" @click.self="closeFileManagerModal">
      <div class="bg-background rounded-lg shadow-xl w-full max-w-4xl h-[85vh] flex flex-col overflow-hidden border border-border">
        <div class="flex justify-between items-center p-3 border-b border-border flex-shrink-0 bg-header">
          <h2 class="text-lg font-semibold text-foreground">{{ t('fileManager.modalTitle', '文件管理器') }} ({{ currentFileManagerSessionId ? (sessionStore.sessions.get(currentFileManagerSessionId)?.connectionName || currentFileManagerSessionId) : '未知会话' }})</h2>
          <button @click="closeFileManagerModal" class="text-text-secondary hover:text-foreground transition-colors">
            <i class="fas fa-times text-xl"></i>
          </button>
        </div>
        <div class="flex-grow overflow-hidden">
          <template v-for="propsData in fileManagerPropsMap.values()" :key="`${propsData.sessionId}-${isMobile}`">
            <div v-show="propsData.sessionId === currentFileManagerSessionId" class="h-full">
              <FileManager
                :session-id="propsData.sessionId"
                :instance-id="propsData.instanceId"
                :db-connection-id="propsData.dbConnectionId"
                :ws-deps="propsData.wsDeps"
                :is-mobile="isMobile"
                class="h-full"
              />
            </div>
          </template>
        </div>
      </div>
    </div>

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

.main-content-area {
    display: flex;
    flex: 1;
    overflow: hidden; /* Keep overflow hidden */
    border: 1px solid var(--border-color, #ccc); /* Use variable for border */
    border-top: none; /* Remove top border as it's handled by the tab bar */
    border-radius: 0 0 5px 5px; /* Top-left, Top-right, Bottom-right, Bottom-left */
    margin: var(--base-margin, 0.5rem); /* Add some margin around the content area */
    margin-top: 0; /* Remove top margin if tab bar is directly above */
}

.layout-renderer-wrapper {
  flex-grow: 1;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

/* 面板占位符样式 (用于加载或错误状态) */
.pane-placeholder {
    flex-grow: 1;
    display: flex;
    justify-content: center;
    align-items: center;
    text-align: center;
    color: var(--text-color-secondary); /* Use secondary text color variable */
    background-color: var(--header-bg-color); /* Use header background for slight contrast */
    font-size: 0.9em;
    padding: var(--base-padding); /* Use base padding variable */
}


/* --- Mobile Layout Styles --- */
.workspace-view.is-mobile {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}

.workspace-view.is-mobile .main-content-area {
  /* Hide the desktop content area in mobile view */
  display: none;
}

.mobile-content-area {
  display: flex;
  flex-direction: column;
  flex: 1 1 0%;
  min-height: 0;
  overflow: hidden;
  position: relative;
  margin: 0;
  border: none;
  border-radius: 0;
}

.mobile-terminal {
  flex-grow: 1; /* Terminal takes all available space in mobile-content-area */
  width: 100%;
  overflow: hidden;
}

.mobile-command-bar {
  flex-shrink: 0;
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

.mobile-virtual-keyboard {
  flex-shrink: 0; /* 防止虚拟键盘缩小 */
  width: 100%; /* 确保宽度为 100% */
  box-sizing: border-box; /* 边框和内边距包含在宽度内 */
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
</style>
