import type { LayoutNode, PaneName } from '../../types/layout';

/**
 * 工作区云同步的数据结构（从 workspaceSync.store 抽出）。
 *
 * 这些类型是前后端快照契约的唯一描述，采集与恢复两侧都依赖它们，
 * 单独成文避免 store 与 composable 互相 import 造成循环。
 */

export interface SyncedSessionInfo {
  sessionId: string;
  connectionId: number | string;
  connectionName: string;
  connectionUuid?: string;
  commandInputContent?: string;
  suspendSessionId?: string;
  /** 目标机自托管模式标识（remote-agent / legacy） */
  hostingMode?: 'remote-agent' | 'legacy';
  /** 主终端对应的目标机托管会话 ID（nexus-mux session_id），跨端直接接管用 */
  remoteSessionId?: string;
  /** 分屏副终端对应的目标机托管会话 ID（按 pane#1 / pane#2 稳定序号索引） */
  remotePaneSessionIds?: Record<string, string>;
  /** 上次恢复时因网络不可达处于离线占位态（保留快照元信息绝不抹除） */
  unreachableOnLastRestore?: boolean;
  terminalBuffer?: string;
  /** 多终端分屏各 paneId 独立序列化 buffer */
  terminalPanesBuffer?: Record<string, string>;
  /** 主终端对应的 paneId */
  primaryTerminalPaneId?: string;
  /** 该会话最后聚焦的终端 paneId（多终端分屏时恢复焦点用） */
  focusedTerminalPaneId?: string;
  /** 每个会话自己独立的编辑器标签页（当 shareFileEditorTabs=false 时） */
  editorTabs?: SyncedFileTabInfo[];
  activeEditorTabId?: string | null;
}

export type WorkspaceSyncRuntimeMode =
  | 'web_cloud'
  | 'desktop_cloud_synced'
  | 'desktop_cloud_offline'
  | 'desktop_local_only';

export interface WorkspaceOfflineConflictPayload {
  cloudActiveClientId: string | null;
  cloudUpdatedAt: number;
  localClientId: string | null;
  hasOfflineDirtyChanges: boolean;
}

export interface SyncedFileTabInfo {
  id: string;
  sessionId: string;
  filePath: string;
  filename: string;
  content: string;
  rawContentBase64?: string | null;
  isModified: boolean;
  language: string;
  selectedEncoding: string;
  scrollTop?: number;
  scrollLeft?: number;
}

export interface SyncedFileManagerInfo {
  currentPath: string;
  isSearchActive: boolean;
  searchQuery: string;
  scrollTop?: number;
  scrollRatio?: number;
}

export interface SyncedFileManagerInstanceState {
  instanceId: string;
  sessionId: string;
  currentPath: string;
  isSearchActive: boolean;
  searchQuery: string;
  scrollTop?: number;
  scrollRatio?: number;
}

export interface SyncedMultiLineCommandInfo {
  currentContent: string;
  sessionDrafts: Record<string, string>;
}

export interface SyncedLayoutInfo {
  layoutTree: LayoutNode | null;
  sidebarPanes?: { left: PaneName[]; right: PaneName[] };
}

export interface WorkspaceSnapshot {
  syncEnabled: boolean;
  activeSessionId: string | null;
  sessions: SyncedSessionInfo[];
  /** 会话标签栏排布顺序 */
  sessionOrder?: string[];
  /** 分屏布局与侧边栏配置 */
  layout?: SyncedLayoutInfo;
  fileEditor: {
    /** 弹窗编辑器是否处于打开状态 */
    isOpen?: boolean;
    activeTabId: string | null;
    tabs: SyncedFileTabInfo[];
  };
  /** 兼容单实例旧快照 */
  fileManager: SyncedFileManagerInfo;
  /** 精准适配多实例（key: `${sessionId}:${instanceId}`） */
  fileManagers?: Record<string, SyncedFileManagerInstanceState>;
  multiLineCommandInput: SyncedMultiLineCommandInfo;
  updatedAt: number;
}

/**
 * 文件管理器路径是否值得写进快照。
 *
 * 必须是绝对路径：相对路径（`.`、`./.gemini`）在不同会话下含义不同，
 * 恢复时会把文件管理器带到莫名其妙的地方。
 */
export function isValidFileManagerSyncPath(p?: string | null): boolean {
  if (!p) return false;
  const s = p.trim();
  return s.startsWith('/') && s !== '';
}
