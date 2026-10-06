// packages/frontend/src/composables/workspaceEvents.ts
import mitt from 'mitt';
import type { ConnectionInfo } from '../stores/connections.store';
import type { Terminal as XtermTerminal } from 'xterm';

// 定义事件载荷类型
export type WorkspaceEventPayloads = {
  // Terminal Events
  'terminal:input': { sessionId: string; data: string };
  'terminal:resize': { sessionId: string; dims: { cols: number; rows: number } };
  'terminal:ready': { sessionId: string; terminal: XtermTerminal; searchAddon: any };
  'terminal:sendCommand': { command: string; sessionId?: string }; // sessionId 可选，用于指定目标，默认为 active
  'terminal:clear': void; // sessionId 可选，默认为 active
  'terminal:scrollToBottomRequest': { sessionId: string };
  'terminal:stabilizedResize': { sessionId: string; width: number; height: number }; // 用于传递稳定后的尺寸


  // Editor Events
  'editor:closeTab': { tabId: string };
  'editor:activateTab': { tabId: string };
  'editor:updateContent': { tabId: string; content: string };
  'editor:saveTab': { tabId: string };
  'editor:changeEncoding': { tabId: string; encoding: string };
  'editor:closeOtherTabs': { tabId: string };
  'editor:closeTabsToRight': { tabId: string };
  'editor:closeTabsToLeft': { tabId: string };
  'editor:updateScrollPosition': { tabId: string; scrollTop: number; scrollLeft: number };
 
  // Connection Events
  'connection:connect': { connectionId: number }; // 来自 WorkspaceConnectionList 或其他地方
  'connection:openNewSession': { connectionId: number }; // 来自 WorkspaceConnectionList
  'connection:requestAdd': void; // 来自 WorkspaceConnectionList 或 TerminalTabBar
  'connection:requestEdit': { connectionInfo: ConnectionInfo }; // 来自 WorkspaceConnectionList 或 TerminalTabBar

  // Search Events (主要由 CommandInputBar 或 PaneTitleBar 发出)
  'search:start': { term: string; sessionId?: string }; // sessionId 可选，用于指定搜索目标终端
  'search:findNext': void;
  'search:findPrevious': void;
  'search:close': void;

  // Session Management Events (主要由 TerminalTabBar 发出)
  'session:activate': { sessionId: string };
  'session:close': { sessionId: string };
  'session:closeOthers': { targetSessionId: string };
  'session:closeToRight': { targetSessionId: string };
  'session:closeToLeft': { targetSessionId: string };

  // UI Interaction Events
  'ui:openLayoutConfigurator': void;
'ui:openTransferProgressModal': void; // 请求打开文件传输进度模态框
  // 'ui:toggleVirtualKeyboard': void; // 如果决定迁移 CommandInputBar 的这个事件
  'fileManager:openModalRequest': { sessionId: string }; // 请求打开文件管理器模态框
  'fileManager:itemsMoved': { sessionId: string; sourceDir: string; targetDir: string }; // 跨窗格/内部文件移动完成通知

  // Suspended SSH Session Events
  'suspendedSession:actionCompleted': void; // Emitted when a resume/remove action is completed

  // Quick Command Events
  'quickCommand:executeProcessed': { command: string; sessionId?: string };
};

// 创建 mitt 事件发射器实例
export const workspaceEmitter = mitt<WorkspaceEventPayloads>();

/**
 * Composable to get the workspace event emitter function.
 * @returns The emit function from the mitt instance.
 */
export function useWorkspaceEventEmitter() {
  return workspaceEmitter.emit;
}

/**
 * Composable to get the workspace event subscriber function.
 * @returns The 'on' function from the mitt instance for subscribing to events.
 */
export function useWorkspaceEventSubscriber() {
  return workspaceEmitter.on;
}

/**
 * Composable to get the workspace event unsubscriber function.
 * @returns The 'off' function from the mitt instance for unsubscribing from events.
 */
export function useWorkspaceEventOff() {
  return workspaceEmitter.off;
}