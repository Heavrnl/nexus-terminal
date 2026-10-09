

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

export interface SessionState {
  sessionId: string;
  connectionId: string; // 数据库中的连接 ID
  connectionName: string; // 用于显示
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
  disposables?: (() => void)[]; // 用于存储清理函数，例如取消注册消息处理器
  pendingOutput?: string[]; // 用于暂存恢复会话时，在终端实例准备好之前收到的输出
  shouldActivateOnResume?: boolean; // 标记从挂起恢复就绪后是否激活此会话（默认为 true，若为 false 则保持静默后台恢复）
}

// 为标签栏定义包含状态的类型
export interface SessionTabInfoWithStatus {
  sessionId: string;
  connectionName: string;
  status: WsConnectionStatus; // 添加状态字段
  isMarkedForSuspend?: boolean; // +++ 用于UI指示会话是否已标记待挂起 +++
}