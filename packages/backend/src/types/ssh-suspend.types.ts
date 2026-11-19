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
  /** 内存中的输出缓冲（保证挂起与恢复期间 100% 连续无丢失） */
  inMemoryBuffer?: string[];
  /** 内存缓冲当前累计字节数（用于实施上限保护，防止挂起期日志洪流 OOM） */
  inMemoryBytes?: number;
  /** 挂起期间的流式 UTF-8 解码器（跨包拼接多字节中文/Emoji，避免出现 U+FFFD） */
  utf8Decoder?: { write(buf: Buffer): string; end(): string };
  /**
   * `inMemoryBuffer` 里有几块是「挂起那一刻客户端屏幕上已经有了的」历史。
   *
   * 挂起时会把前端传来的 scrollback 作为第 0 块塞进缓冲（见 takeOverMarkedSession），
   * 之后才是断线期间新产生的输出。刷新页面后恢复要回放全部（终端是空的），
   * 但 WebSocket 抖动后**就地接回**时终端里已经有这段历史了，只能补第 1 块往后，
   * 否则同一段输出会在屏幕上出现两遍。
   */
  historyChunks?: number;
  /** 同上，但给「从磁盘日志读回来」的分支用（按字符数裁掉历史部分） */
  historyChars?: number;
  /** 挂起恢复过渡期间暂存的实时数据流队列 */
  pendingResumeBuffer?: Buffer[];
  /** 多终端分屏独立 Shell 通道映射 (用于多终端保活) */
  paneStreams?: Map<string, any>;
  /**
   * 由「第几轮工作区接管」创建（`WorkspaceSyncService.claimLease` 递增）。
   *
   * 只给「新端接管时把旧端会话移交挂起」这条路打标：这样下一次接管才能认出
   * 「这条是上一轮留下的、这一轮已经没人会去 resume 的孤儿」并清掉。
   * 用户手动挂起 / ws 断开自动挂起不带这个值，它们要继续留在挂起面板里。
   */
  takeoverRound?: number;
  /**
   * 是否为「手动挂起」（用户从标签右键菜单主动选「挂起会话」）。
   *
   * 这类会话**只属于挂起池**，和工作区同步彻底无关：
   * 前端恢复工作区时绝不能自动认领它，否则「挂起的标签刷新后又自己回来了」。
   * 而刷新 / 被别的客户端接管产生的挂起是 false（自动挂起），恢复流程照旧认领。
   *
   * 注意：关标签（点 ×、关闭其他/左/右）**不产生挂起**，直接把 SSH 断开。
   */
  manuallySuspended?: boolean;
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
  /** 是否手动挂起（关标签产生）。恢复工作区时必须跳过这类条目。 */
  manuallySuspended?: boolean;
}