

import type { Ref } from 'vue';
import type { FileTab as OriginalFileTab } from '../fileEditor.store'; 
import type { WsConnectionStatus } from '../../composables/useWebSocketConnection'; 
import type { DockerManagerInstance as OriginalDockerManagerInstance } from '../../composables/useDockerManager'; 

// 导入工厂函数仅用于通过 ReturnType 推导实例类型
// 这些导入仅用于类型推断，不在运行时使用
import type { createWebSocketConnectionManager } from '../../composables/useWebSocketConnection';
import type { createSftpActionsManager } from '../../composables/useSftpActions';
import type { createSshTerminalManager } from '../../composables/useSshTerminal';
import type { createStatusMonitorManager } from '../../composables/useStatusMonitor';


// 使用 ReturnType 定义其他管理器实例类型
export type WsManagerInstance = ReturnType<typeof createWebSocketConnectionManager>;
export type SftpManagerInstance = ReturnType<typeof createSftpActionsManager>;
export type SshTerminalInstance = ReturnType<typeof createSshTerminalManager>;
export type StatusMonitorInstance = ReturnType<typeof createStatusMonitorManager>;

// 为 DockerManagerInstance 创建一个本地类型别名，并导出它
export type DockerManagerInstance = OriginalDockerManagerInstance;

// 重新导出 FileTab 类型，使其可用于其他模块
export type FileTab = OriginalFileTab;

/**
 * 会话类型。
 *
 * ssh 走终端（WebSocket + xterm）；rdp / vnc 是浏览器内直接跑的远程桌面，
 * 不建立任何 SSH 通道，画面由 RemoteSessionPane 占满整个工作区。
 */
export type SessionKind = 'ssh' | 'rdp' | 'vnc';

/** 远程画面自己的连接状态（SSH 会话用 wsManager.connectionStatus，远程会话用这个） */
export type RemoteLinkStatus = 'connecting' | 'connected' | 'error' | 'disconnected';

export interface SessionState {
  sessionId: string;
  connectionId: string; // 数据库中的连接 ID
  connectionName: string; // 用于显示
  kind: SessionKind;
  /**
   * rdp / vnc 专用：标签栏指示灯读这里。
   *
   * 远程会话也照常创建 wsManager / terminalManager 等骨架（不 connect()），
   * 这样 closeSession、标签栏、文件管理器清理这些既有流程全都不用特判；
   * 但它们的 wsManager 永远停在 disconnected，不能用来显示状态。
   */
  remoteStatus?: Ref<RemoteLinkStatus>;
  wsManager: WsManagerInstance;
  sftpManagers: Map<string, SftpManagerInstance>; // 使用 Map 管理多个实例
  terminalManager: SshTerminalInstance;
  statusMonitorManager: StatusMonitorInstance;
  dockerManager: DockerManagerInstance; // 现在应该可以找到 DockerManagerInstance
  // --- 独立编辑器状态 ---
  editorTabs: Ref<FileTab[]>; // 编辑器标签页列表
  activeEditorTabId: Ref<string | null>; // 当前活动的编辑器标签页 ID
  // --- 命令输入框内容 ---
  commandInputContent: Ref<string>; // 当前会话的命令输入框内容
  isResuming?: boolean; // 标记会话是否正在从挂起状态恢复
  isMarkedForSuspend?: boolean; // +++ 标记会话是否已被用户请求标记为待挂起 +++
  createdAt: number; // 记录会话创建的时间戳，用于排序
  /**
   * 无终端会话：为「文件管理器想看某台主机、但那台主机没有开终端」而生。
   *
   * 它照样建 wsManager / terminalManager，只是**不激活、不进标签栏、不进 sessionOrder**，
   * 由创建它的文件管理器 pane 负责关闭。别让它出现在任何"用户可见的会话列表"里。
   */
  headless?: boolean;
  disposables?: (() => void)[]; // 用于存储清理函数，例如取消注册消息处理器
  pendingOutput?: string[]; // 用于暂存恢复会话时，在终端实例准备好之前收到的输出
  shouldActivateOnResume?: boolean; // 标记从挂起恢复就绪后是否激活此会话（默认为 true，若为 false 则保持静默后台恢复）
  /**
   * 用户在这个会话里最后聚焦的终端 pane。
   * 多终端分屏时，切回该会话 / 从云端恢复后直接聚焦到这里，而不是默认的第一个。
   * paneId 是结构序号（terminal-0/terminal-1），跨刷新稳定。
   */
  focusedTerminalPaneId?: string;
  /** 目标机自托管模式元数据 */
  hostingMode?: 'remote-agent' | 'legacy';
  /** 主终端对应的目标机托管会话 ID（nexus-mux session_id） */
  remoteSessionId?: string;
  /** 分屏副终端对应的目标机托管会话 ID 映射（paneId 或稳定键 pane#1 -> remotePaneSessionId） */
  remotePaneSessionIds?: Record<string, string>;
  /** 目标机托管通道最后收到的字节流序号（弱网 delta 续传游标） */
  lastMuxSeq?: number;
  /** 目标机后台保活降级风险提示（例如无 root 无法开启 systemd linger） */
  persistenceWarning?: string;
  /** Split-Horizon 网络不可达时的离线占位标记（保留标签与快照，绝不抹除） */
  isUnreachablePlaceholder?: boolean;
  /** 离线占位态最近一次建连错误信息 */
  unreachableError?: string;
}

// 为标签栏定义包含状态的类型
export interface SessionTabInfoWithStatus {
  sessionId: string;
  connectionName: string;
  status: WsConnectionStatus; // 添加状态字段
  isMarkedForSuspend?: boolean; // +++ 用于UI指示会话是否已标记待挂起 +++
  kind: SessionKind; // 会话类型：标签栏据此决定渲染终端还是远程画面
  hostingMode?: 'remote-agent' | 'legacy';
  isUnreachablePlaceholder?: boolean;
}