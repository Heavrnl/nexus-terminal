import WebSocket from 'ws';
import { Client, ClientChannel, SFTPWrapper } from 'ssh2';
import type { BackendTerminalEmulator } from './terminal-emulator';
import type { OutputCoalescer } from './output-coalescer';

// 扩展 WebSocket 类型以包含会话 ID
export interface AuthenticatedWebSocket extends WebSocket {
    isAlive?: boolean;
    userId?: number;
    username?: string;
    sessionId?: string; 
}

// 中心化的客户端状态接口 (统一版本)
export interface ClientState { // 导出以便 Service 可以导入
    ws: AuthenticatedWebSocket;
    sshClient: Client;
    sshShellStream?: ClientChannel;
    dbConnectionId: number;
    connectionName?: string; // 连接名称字段
    sftp?: SFTPWrapper; //  sftp 实例 (由 SftpService 管理)
    /** 这条 SFTP 通道是不是通过 `sudo sftp-server` 开的（读写等同 root） */
    sudoSftp?: boolean;
    activeFileProtocol?: 'sftp' | 'scp'; // 当前会话激活的文件传输协议驱动
    fileProtocolConfig?: 'auto' | 'sftp' | 'scp'; // 数据库中配置的文件传输协议选项
    statusIntervalId?: NodeJS.Timeout; // 状态轮询 ID (由 StatusMonitorService 管理)
    dockerStatusIntervalId?: NodeJS.Timeout; //  Docker 状态轮询 ID
    /**
     * 容器 → 探测到的交互式 shell（bash/ash/sh/powershell/cmd）。
     * 「进入容器」的默认命令要自动探测，探测结果在同一次 SSH 会话里不会变，缓存起来避免每次点击都跑一轮 exec。
     */
    dockerShellCache?: Map<string, string>;
    ipAddress?: string; //  IP 地址字段
    isShellReady?: boolean; // 标记 Shell 是否已准备好处理输入和调整大小
    /**
     * 无终端会话（前端文件管理器绑定别的主机时开的私有 SFTP 通道）。
     *
     * 它不在用户的标签栏里，也不承载任何工作区状态，所以接管工作区时**不参与挂起移交** ——
     * 否则挂起池里就会冒出「我没打开过的连接」。
     */
    isHeadless?: boolean;
    isSuspendedByService?: boolean; // 标记此会话是否已被 SshSuspendService 接管
    isHandingOverToSuspend?: boolean; // 标记此会话正处于异步移交挂起的临界区，防止并发重入
    isMarkedForSuspend?: boolean; // 标记此会话是否已被用户请求挂起（等待断开连接）
    suspendLogPath?: string;      // 如果标记挂起，则存储日志路径 (基于原始 sessionId)
    pendingDimensions?: { cols: number; rows: number }; // 暂存 Shell 就绪前收到的终端尺寸
    isExplicitlyClosed?: boolean; // 标记是否被客户端主动显式关闭（杜绝转入自动挂起）
    closeReason?: string;
    recentOutputBuffer?: string[]; // 内存中维护的最近终端输出缓冲（环形保留，避免断线/刷新丢失未同步数据）
    recentOutputBytes?: number;    // 缓冲累计字节数
    /** 服务端无头终端状态机（Headless VT），工作区同步与挂起恢复时直接序列化纯净屏幕状态 */
    terminalEmulator?: BackendTerminalEmulator;
    /** SSH 输出微批合帧器（首包 0ms 延迟，高频刷屏时合并碎包降低 WS 帧与序列化开销） */
    outputCoalescer?: OutputCoalescer;
    /** 跨在线/挂起/恢复全生命周期接力复用的流式 UTF-8 解码器，杜绝交接瞬间切断多字节字符 */
    outDecoder?: { write(buf: Buffer): string; end(): string };
    // 多终端分屏独立 Shell 通道映射 (key 为 paneId)
    paneStreams?: Map<string, PaneStreamState>;
    // 暂存连接就绪前收到的分屏打开请求
    pendingPaneOpens?: Map<string, { cols: number; rows: number; term: string; paneIndex?: number }>;
}

export interface PaneStreamState {
    paneId: string;
    /** 该分屏在布局树中的稳定先序序号（刷新重编 paneId 后仍可按序号复用） */
    paneIndex?: number;
    stream: ClientChannel;
    isReady: boolean;
    pendingDimensions?: { cols: number; rows: number };
}

export interface PortInfo {
  IP?: string;
  PrivatePort: number;
  PublicPort?: number;
  Type: 'tcp' | 'udp' | string;
}

// --- Docker Interfaces (Ensure this matches frontend and DockerService) ---
// Stats 接口
export interface DockerStats {
    ID: string;       
    Name: string;     
    CPUPerc: string;  
    MemUsage: string; 
    MemPerc: string;  
    NetIO: string;    
    BlockIO: string;  
    PIDs: string;     
}

// Container 接口 (包含 stats)
export interface DockerContainer {
    id: string; // 使用小写 id 以匹配前端期望
    Names: string[];
    Image: string;
    ImageID: string;
    Command: string;
    Created: number;
    State: string;
    Status: string;
    Ports: PortInfo[];
    Labels: Record<string, string>;
    stats?: DockerStats | null; // 可选的 stats 字段
}
// --- SSH Suspend Mode WebSocket Message Types ---

// Client -> Server
export interface SshSuspendStartRequest {
  type: "SSH_SUSPEND_START";
  payload: {
    sessionId: string; // The ID of the active SSH session to be suspended
    initialBuffer?: string; // Optional: content of the terminal buffer at the time of suspend
  };
}

export interface SshSuspendListRequest {
  type: "SSH_SUSPEND_LIST_REQUEST";
}

export interface SshSuspendResumeRequest {
  type: "SSH_SUSPEND_RESUME_REQUEST";
  payload: {
    suspendSessionId: string; // The ID of the suspended session to resume
    newFrontendSessionId: string; // The new frontend session ID for the resumed connection
  };
}

/**
 * 就地接回：WebSocket 因网络抖动断开又自动连上时，把「刚才被后端自动挂起的那个会话」
 * 接回同一个前端会话 id，而不是重新建一条 SSH。
 *
 * 与 SSH_SUSPEND_RESUME_REQUEST 的区别：
 *   - 那个是「挂起面板 / 刷新后恢复工作区」，会新建前端会话、回放全部历史；
 *   - 这个是「原地接回」，前端会话 id 不变、已显示过的历史不再重放。
 */
export interface SshReattachRequest {
  type: "SSH_REATTACH_REQUEST";
  payload: {
    /** 前端会话 id（断开前的那个），后端按它反查 originalSessionId 匹配的挂起条目 */
    sessionId: string;
  };
}

export interface SshReattachResult {
  type: "SSH_REATTACH_RESULT";
  payload: {
    sessionId: string;
    success: boolean;
    /** 失败原因：not_suspended（没有可接回的挂起条目）/ unauthorized / error */
    reason?: string;
    /** 接回时若命中，回传挂起条目上的连接名，便于前端提示 */
    connectionName?: string;
  };
}

export interface SshSuspendTerminateRequest {
  type: "SSH_SUSPEND_TERMINATE_REQUEST";
  payload: {
    suspendSessionId: string; // The ID of the active suspended session to terminate
  };
}

export interface SshSuspendRemoveEntryRequest {
  type: "SSH_SUSPEND_REMOVE_ENTRY";
  payload: {
    suspendSessionId: string; // The ID of the disconnected session entry to remove
  };
}

export interface SshSuspendEditNameRequest {
  type: "SSH_SUSPEND_EDIT_NAME";
  payload: {
    suspendSessionId: string;
    customName: string;
  };
}

export interface SshMarkForSuspendRequest {
  type: "SSH_MARK_FOR_SUSPEND";
  payload: {
    sessionId: string; // The ID of the active SSH session to be marked
    initialBuffer?: string; // +++ 可选的初始屏幕缓冲区内容 +++
  };
}

export interface SshUnmarkForSuspendRequest {
  type: "SSH_UNMARK_FOR_SUSPEND";
  payload: {
    sessionId: string; // The ID of the active SSH session to be unmarked
  };
}

// Server -> Client
export interface SshSuspendStartedResponse {
  type: "SSH_SUSPEND_STARTED";
  payload: {
    frontendSessionId: string; // The original frontend session ID
    suspendSessionId: string;  // The new ID for the suspended session
    success: boolean;
    error?: string;
  };
}

export interface SuspendedSessionInfo {
  suspendSessionId: string;
  connectionName: string; // Original connection name
  connectionId: string; // Original connection ID
  suspendStartTime: string; // ISO string
  customSuspendName?: string;
  backendSshStatus: 'hanging' | 'disconnected_by_backend';
  disconnectionTimestamp?: string; // ISO string, if applicable
}

export interface SshSuspendListResponse {
  type: "SSH_SUSPEND_LIST_RESPONSE";
  payload: {
    suspendSessions: SuspendedSessionInfo[];
  };
}

export interface SshSuspendResumedNotification {
  type: "SSH_SUSPEND_RESUMED_NOTIF"; // 统一为带 _NOTIF 后缀
  payload: {
    suspendSessionId: string;
    newFrontendSessionId: string; // The frontend session ID this resumed session is now associated with
    success: boolean;
    error?: string;
  };
}

export interface SshOutputCachedChunk {
  type: "SSH_OUTPUT_CACHED_CHUNK";
  payload: {
    frontendSessionId: string; // The frontend session ID to send the chunk to
    data: string;
    isLastChunk: boolean;
  };
}

export interface SshSuspendTerminatedResponse {
  type: "SSH_SUSPEND_TERMINATED";
  payload: {
    suspendSessionId: string;
    success: boolean;
    error?: string;
  };
}

export interface SshSuspendEntryRemovedResponse {
  type: "SSH_SUSPEND_ENTRY_REMOVED";
  payload: {
    suspendSessionId: string;
    success: boolean;
    error?: string;
  };
}

export interface SshSuspendNameEditedResponse {
  type: "SSH_SUSPEND_NAME_EDITED";
  payload: {
    suspendSessionId: string;
    success: boolean;
    customName?: string;
    error?: string;
  };
}

export interface SshMarkedForSuspendAck {
  type: "SSH_MARKED_FOR_SUSPEND_ACK";
  payload: {
    sessionId: string; // The ID of the session that was marked
    success: boolean;
    error?: string;
  };
}

export interface SshUnmarkedForSuspendAck { // +++  S2C 类型 +++
  type: "SSH_UNMARKED_FOR_SUSPEND_ACK";
  payload: {
    sessionId: string; // The ID of the session that was unmarked
    success: boolean;
    error?: string;
  };
}

export interface SshSuspendAutoTerminatedNotification {
  type: "SSH_SUSPEND_AUTO_TERMINATED";
  payload: {
    suspendSessionId: string;
    reason: string;
  };
}

// Union type for all client-to-server messages for SSH Suspend
export type SshSuspendClientToServerMessages =
  | SshSuspendStartRequest
  | SshSuspendListRequest
  | SshSuspendResumeRequest
  | SshReattachRequest
  | SshSuspendTerminateRequest
  | SshSuspendRemoveEntryRequest
  | SshSuspendEditNameRequest
  | SshMarkForSuspendRequest
  | SshUnmarkForSuspendRequest; 

// Union type for all server-to-client messages for SSH Suspend
export type SshSuspendServerToClientMessages =
  | SshSuspendStartedResponse
  | SshSuspendListResponse
  | SshSuspendResumedNotification
  | SshReattachResult
  | SshOutputCachedChunk
  | SshSuspendTerminatedResponse
  | SshSuspendEntryRemovedResponse
  | SshSuspendNameEditedResponse
  | SshSuspendAutoTerminatedNotification
  | SshMarkedForSuspendAck
  | SshUnmarkedForSuspendAck; 



// C -> S: Request to compress files/directories
export interface SftpCompressRequestPayload {
    sources: string[]; // Array of source paths (relative to targetDirectory)
    destinationArchiveName: string; // Desired name for the archive file
    format: 'zip' | 'targz' | 'tarbz2'; // Archive format
    targetDirectory: string; // The directory where sources are located and where the archive will be created
    requestId: string;
}

// S -> C: Compression success
export interface SftpCompressSuccessPayload {
    message: string;
    requestId: string;
}

// S -> C: Compression error
export interface SftpCompressErrorPayload {
    error: string;
    details?: string; // Stderr output or specific error details
    requestId: string;
}

// C -> S: Request to decompress an archive
export interface SftpDecompressRequestPayload {
    archivePath: string; // Full path to the archive file
    requestId: string;
}

// S -> C: Decompression success
export interface SftpDecompressSuccessPayload {
    message: string;
    requestId: string;
}

// S -> C: Decompression error
export interface SftpDecompressErrorPayload {
    error: string;
    details?: string; // Stderr output or specific error details
    requestId: string;
}
// S -> C: SFTP Upload Progress (New)
export interface SftpUploadProgressPayload {
    uploadId: string; // To correlate with the specific upload
    bytesWritten: number;
    totalSize: number;
    progress: number; // Calculated percentage (0-100)
}