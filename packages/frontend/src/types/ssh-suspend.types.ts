/**
 * 表示从后端获取的单个挂起 SSH 会话的详细信息。
 */
export interface SuspendedSshSession {
  /** 挂起会话的唯一ID。 */
  suspendSessionId: string;
  /** 原始连接的名称，通常是主机名或用户定义的连接别名。 */
  connectionName: string;
  /** 原始连接的ID。 */
  connectionId: string;
  /** 会话挂起的开始时间，ISO 格式的日期字符串。 */
  suspendStartTime: string;
  /** 用户为该挂起会话自定义的名称。 */
  customSuspendName?: string;
  /**
   * 后端 SSH 连接的当前状态。
   * - 'hanging': SSH 连接仍在后端保持活跃。
   * - 'disconnected_by_backend': SSH 连接已从后端意外断开。
   */
  backendSshStatus: 'hanging' | 'disconnected_by_backend';
  /**
   * 如果连接已从后端断开 (backendSshStatus === 'disconnected_by_backend')，
   * 则此字段表示断开连接的时间戳，ISO 格式的日期字符串。
   */
  disconnectionTimestamp?: string;
  /**
   * 是否为「手动挂起」——用户主动关掉标签产生的挂起。
   *
   * 这类会话属于挂起池专属资产，**不参与工作区同步**：
   * 刷新页面 / 换端恢复都不会自动把它变回标签，只能在这里手动恢复。
   */
  manuallySuspended?: boolean;
  /** 产生该挂起条目的原始会话 ID（后端用于对账，UI 不展示）。 */
  originalSessionId?: string;
  /** 跨端对齐用的主机连接 UUID */
  connectionUuid?: string;
  /** 托管模式：目标机代理托管或传统后端内存托管 */
  hostingMode?: 'remote-agent' | 'legacy';
  /** 目标机托管会话 ID（nexus-mux session_id） */
  remoteSessionId?: string;
  /** 目标机进程自然退出后的退出码 */
  exitCode?: number | null;
}

/**
 * SSH_SUSPEND_LIST_RESPONSE 消息的载荷结构。
 */
export interface SshSuspendListResponsePayload {
  suspendSessions: SuspendedSshSession[];
}