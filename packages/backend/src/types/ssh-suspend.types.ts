import { Client, Channel, ClientChannel } from 'ssh2';

/**
 * 后端 SSH 会话状态
 * 'hanging': 会话正在挂起，SSH 连接活跃。
 * 'disconnected_by_backend': 后端检测到 SSH 连接意外断开。
 */
export type BackendSshStatus = 'hanging' | 'disconnected_by_backend';

/**
 * 挂起会话的详细信息接口
 */
export interface SuspendSessionDetails {
  /** SSH 客户端实例 */
  sshClient: Client;
  /** SSH 通道实例 */
  channel: ClientChannel; // 使用更具体的 ClientChannel 类型
  /** 临时日志文件路径 */
  tempLogPath: string;
  /** 连接名称 */
  connectionName: string;
  /** 连接 ID */
  connectionId: string;
  /** 挂起开始时间 (ISO 格式字符串) */
  suspendStartTime: string;
  /** 用户自定义的挂起会话名称 */
  customSuspendName?: string;
  /** 后端 SSH 会话状态 */
  backendSshStatus: BackendSshStatus;
  /** 断开连接的时间戳 (ISO 格式字符串)，仅当 backendSshStatus 为 'disconnected_by_backend' 时存在 */
  disconnectionTimestamp?: string;
  /** 原始会话ID */
  originalSessionId: string;
  /** 用户ID */
  userId: number;
}

/**
 * 用于存储在内存中的挂起会话映射
 * Key: userId
 * Value: Map<suspendSessionId, SuspendSessionDetails>
 */
export type SuspendedSessionsMap = Map<number, Map<string, SuspendSessionDetails>>;

/**
 * 用于API响应的挂起会话信息子集
 */
export interface SuspendedSessionInfo {
  suspendSessionId: string;
  connectionName: string;
  connectionId: string;
  suspendStartTime: string;
  customSuspendName?: string;
  backendSshStatus: BackendSshStatus;
  disconnectionTimestamp?: string;
  originalSessionId?: string;
}