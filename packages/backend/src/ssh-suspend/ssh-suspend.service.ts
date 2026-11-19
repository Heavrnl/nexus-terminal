import { Client, Channel, ClientChannel } from 'ssh2';
import { EventEmitter } from 'events';
import { StringDecoder } from 'node:string_decoder';
import { v4 as uuidv4 } from 'uuid';
import {
  SuspendSessionDetails,
  SuspendedSessionsMap,
  BackendSshStatus,
  SuspendedSessionInfo,
} from '../types/ssh-suspend.types';
import { temporaryLogStorageService, TemporaryLogStorageService } from './temporary-log-storage.service';
import { ClientState } from '../websocket/types';
import { shouldPruneTakeoverSuspend } from '../workspace-sync/workspace-sync.pure';

/** 挂起态单会话内存缓冲上限（4MB），防止后台日志洪流导致后端 OOM */
const MAX_SUSPEND_MEMORY_BYTES = 4 * 1024 * 1024;

/**
 * 将一段文本追加到挂起会话的内存环形缓冲，并在超出上限时按块从头部安全淘汰。
 * 淘汰同时维护 `historyChunks` 计数，保证就地接回（delta 模式）的切片索引始终准确。
 */
function appendToSuspendMemory(details: SuspendSessionDetails, text: string): void {
  if (!text) return;
  if (!details.inMemoryBuffer) {
    details.inMemoryBuffer = [];
    details.inMemoryBytes = 0;
  }
  const chunkBytes = Buffer.byteLength(text, 'utf8');
  details.inMemoryBuffer.push(text);
  details.inMemoryBytes = (details.inMemoryBytes || 0) + chunkBytes;

  while (details.inMemoryBytes > MAX_SUSPEND_MEMORY_BYTES && details.inMemoryBuffer.length > 1) {
    const shifted = details.inMemoryBuffer.shift();
    if (shifted) {
      details.inMemoryBytes -= Buffer.byteLength(shifted, 'utf8');
    }
    if (details.historyChunks && details.historyChunks > 0) {
      details.historyChunks--;
    }
  }

  // 单块本身超过上限的极端情况：保留尾部并尽量对齐到换行符后，再补 SGR 重置避免残缺转义序列
  if (details.inMemoryBytes > MAX_SUSPEND_MEMORY_BYTES && details.inMemoryBuffer.length === 1) {
    const single = details.inMemoryBuffer[0];
    const cutStart = Math.max(0, single.length - MAX_SUSPEND_MEMORY_BYTES);
    const nextNl = single.indexOf('\n', cutStart);
    const trimmed = nextNl !== -1 && nextNl + 1 < single.length
      ? `\x1b[0m${single.slice(nextNl + 1)}`
      : `\x1b[0m${single.slice(cutStart)}`;
    details.inMemoryBuffer[0] = trimmed;
    details.inMemoryBytes = Buffer.byteLength(trimmed, 'utf8');
    if (details.historyChunks && details.historyChunks > 0) {
      details.historyChunks = 0;
    }
  }
}
// clientStates 的直接访问已移除，因为takeOverMarkedSession现在从调用者接收所需信息

/**
 * SshSuspendService 负责管理所有用户的挂起 SSH 会话的生命周期。
 */
export class SshSuspendService extends EventEmitter {
  private suspendedSessions: SuspendedSessionsMap = new Map();
  private readonly logStorageService: TemporaryLogStorageService;

  constructor(logStorage?: TemporaryLogStorageService) {
    super(); // 调用 EventEmitter 的构造函数
    this.logStorageService = logStorage || temporaryLogStorageService;
    // TODO: 考虑在服务启动时从日志目录加载持久化的 'disconnected_by_backend' 会话信息。
    // 这需要日志文件本身包含可解析的元数据。
  }

  /**
   * 获取用户特定的会话映射，如果不存在则创建。
   * @param userId 用户ID。
   * @returns 该用户的 Map<suspendSessionId, SuspendSessionDetails>。
   */
  private getUserSessions(userId: number): Map<string, SuspendSessionDetails> { // userId: string -> number
    if (!this.suspendedSessions.has(userId)) {
      this.suspendedSessions.set(userId, new Map<string, SuspendSessionDetails>());
    }
    return this.suspendedSessions.get(userId)!;
  }

  /**
   * 当一个被标记为待挂起的会话的 WebSocket 连接断开时，由此方法接管 SSH 资源。
   * @param details 包含接管所需的所有会话详细信息。
   * @returns Promise<string | null> 返回新生成的 suspendSessionId，如果无法接管则返回 null。
   */
  async takeOverMarkedSession(details: {
    userId: number;
    originalSessionId: string;
    sshClient: Client;
    channel: ClientChannel;
    connectionName: string;
    connectionId: string;
    logIdentifier: string;
    /** 断线/接管前前端已经展示过的历史内容（就地接回 delta 模式会跳过它） */
    initialBuffer?: string;
    /** 断线后、异步移交完成前这段窗口内新到达的远端输出（delta 模式必须回放它） */
    deltaBuffer?: string;
    /** 从在线态接力传入的 UTF-8 流式解码器，避免交接瞬间切断跨包多字节字符 */
    utf8Decoder?: { write(buf: Buffer): string; end(): string };
    customSuspendName?: string;
    paneStreams?: Map<string, any>;
    /** 手动挂起（用户关标签）标记，见 SuspendSessionDetails.manuallySuspended */
    manuallySuspended?: boolean;
    /** 由第几轮工作区接管创建，见 SuspendSessionDetails.takeoverRound */
    takeoverRound?: number;
  }): Promise<string | null> {
    const {
      userId,
      originalSessionId,
      sshClient,
      channel,
      connectionName,
      connectionId,
      logIdentifier,
      initialBuffer,
      deltaBuffer,
      utf8Decoder: inheritedDecoder,
      customSuspendName,
      paneStreams,
      manuallySuspended,
      takeoverRound,
    } = details;
    console.log(`[SshSuspendService DEBUG] takeOverMarkedSession: Called for userId=${userId}, originalSessionId=${originalSessionId}`);

    // 检查 SSH client 和 channel 是否仍然可用
    console.log(`[SshSuspendService DEBUG] takeOverMarkedSession: Checking channel for originalSessionId=${originalSessionId}. Readable: ${channel?.readable}, Writable: ${channel?.writable}`);
    if (!channel || !channel.readable || !channel.writable) {
        console.warn(`[SshSuspendService WARN] takeOverMarkedSession: userId=${userId}, originalSessionId=${originalSessionId}. SSH channel is not usable. readable=${channel?.readable}, writable=${channel?.writable}. Cannot take over.`);
        try { channel?.end(); } catch (e) { /* ignore */ }
        try { sshClient?.end(); } catch (e) { /* ignore */ }
        return null; // 无法接管
    }

    const suspendSessionId = uuidv4();
    const userSessions = this.getUserSessions(userId);

    channel.removeAllListeners('data');
    channel.removeAllListeners('close');
    channel.removeAllListeners('error');
    channel.removeAllListeners('end');
    channel.removeAllListeners('exit');

    sshClient.removeAllListeners('error');
    // 处理多分屏 Shell 通道：移除旧 WebSocket 绑定的监听器，并在挂起期间安全保活
    if (paneStreams && paneStreams.size > 0) {
      console.log(`[SshSuspendService INFO] 接管会话 ${originalSessionId} 的 ${paneStreams.size} 个分屏 Shell 通道以供断线/刷新保活`);
      for (const [, pState] of paneStreams.entries()) {
        if (pState && pState.stream) {
          pState.stream.removeAllListeners('data');
          pState.stream.removeAllListeners('error');
        }
      }
    }

    const utf8Decoder = inheritedDecoder || new StringDecoder('utf8');
    const sessionDetails: SuspendSessionDetails = {
      sshClient,
      channel,
      tempLogPath: logIdentifier, // 使用传入的日志标识符 (基于 originalSessionId)
      connectionName,
      connectionId,
      suspendStartTime: new Date().toISOString(),
      customSuspendName,
      backendSshStatus: 'hanging',
      originalSessionId,
      userId,
      inMemoryBuffer: [],
      inMemoryBytes: 0,
      utf8Decoder,
      // 第 0 块是前端已经显示过的历史；就地接回时不能重放它
      historyChunks: 0,
      historyChars: initialBuffer ? initialBuffer.length : 0,
      pendingResumeBuffer: undefined,
      paneStreams: paneStreams && paneStreams.size > 0 ? new Map(paneStreams) : undefined,
      manuallySuspended: manuallySuspended === true,
      takeoverRound,
    };

    if (initialBuffer) {
      appendToSuspendMemory(sessionDetails, initialBuffer);
      sessionDetails.historyChunks = sessionDetails.inMemoryBuffer?.length || 0;
    }
    if (deltaBuffer) {
      // 断线后、异步写盘期间新到达的输出属于 delta，必须排在 historyChunks 之后
      appendToSuspendMemory(sessionDetails, deltaBuffer);
    }

    /**
     * 同一条前端会话被挂起两次（工作区接管 与 ws 断开清理抢跑）会留下两份条目，
     * 挂起面板里就是同一个连接出现两行、点哪个都不对。这里先收掉旧的那份（含它的 SSH 通道）。
     */
    for (const [existingId, existing] of Array.from(userSessions.entries())) {
      if (
        existingId !== suspendSessionId &&
        existing.originalSessionId === originalSessionId &&
        existing.backendSshStatus === 'hanging' &&
        // 同一条通道不能自己收自己（极端竞态下两次接管拿到的可能是同一份引用）
        existing.channel !== channel
      ) {
        console.warn(
          `[SshSuspendService WARN] 会话 ${originalSessionId} 已有挂起条目 ${existingId}，先终止旧条目再登记新的 ${suspendSessionId}`
        );
        await this.terminateSuspendedSession(userId, existingId);
        break;
      }
    }

    userSessions.set(suspendSessionId, sessionDetails);
    console.log(`[SshSuspendService INFO] takeOverMarkedSession: userId=${userId}, originalSessionId=${originalSessionId} taken over. New suspendSessionId=${suspendSessionId}, initial status=${sessionDetails.backendSshStatus}. Log identifier=${logIdentifier}, initialBufferLength=${initialBuffer ? initialBuffer.length : 0}`);

    await this.logStorageService.ensureLogDirectoryExists();
    
    console.log(`[SshSuspendService DEBUG] takeOverMarkedSession: Setting up channel 'data' listener for suspendSessionId=${suspendSessionId}`);
    channel.on('data', (data: Buffer) => {
      const currentDetails = userSessions.get(suspendSessionId);
      if (currentDetails?.backendSshStatus === 'hanging') {
        // 如果正在恢复过渡，暂存原始 Buffer 到 pendingResumeBuffer 绝不丢弃
        if (currentDetails.pendingResumeBuffer) {
          currentDetails.pendingResumeBuffer.push(data);
        } else {
          // 必须走 StringDecoder 跨包拼接多字节 UTF-8（中文/Emoji），绝不能逐块 data.toString('utf-8')
          const str = currentDetails.utf8Decoder ? currentDetails.utf8Decoder.write(data) : data.toString('utf8');
          if (str) {
            appendToSuspendMemory(currentDetails, str);
            // 异步写入磁盘日志作为双轨保底（底层按 suspendSessionId 串行队列落盘）
            this.logStorageService.writeToLog(logIdentifier, str).catch(err => {
              console.error(`[SshSuspendService ERROR] channel.on('data') for suspendSessionId=${suspendSessionId}, log=${logIdentifier}: Failed to write to log:`, err);
            });
          }
        }
      }
    });

    const handleSessionTermination = (reasonSuffix: string) => {
      const currentSession = userSessions.get(suspendSessionId);
      console.log(`[SshSuspendService DEBUG] handleSessionTermination: Called for suspendSessionId=${suspendSessionId}, reasonSuffix='${reasonSuffix}'. Session found: ${!!currentSession}. Current status: ${currentSession?.backendSshStatus}`);
      if (currentSession && currentSession.backendSshStatus === 'hanging') {
        const reason = `SSH connection ${reasonSuffix}.`;
        console.warn(`[SshSuspendService WARN] handleSessionTermination: userId=${currentSession.userId}, suspendSessionId=${suspendSessionId}. SSH connection terminated during suspension. Reason: ${reason}`);
        currentSession.backendSshStatus = 'disconnected_by_backend';
        currentSession.disconnectionTimestamp = new Date().toISOString();
        
        this.removeChannelListeners(channel, sshClient);
        console.log(`[SshSuspendService DEBUG] handleSessionTermination: Listeners removed for suspendSessionId=${suspendSessionId}.`);

        this.emit('sessionAutoTerminated', {
          userId: currentSession.userId,
          suspendSessionId,
          reason
        });
        console.log(`[SshSuspendService INFO] handleSessionTermination: Emitted 'sessionAutoTerminated' for suspendSessionId=${suspendSessionId}, userId=${currentSession.userId}.`);
      } else if (currentSession) {
        console.log(`[SshSuspendService DEBUG] handleSessionTermination: Condition not met for suspendSessionId=${suspendSessionId}. Status was '${currentSession.backendSshStatus}', not 'hanging'. No action taken.`);
      } else {
        console.warn(`[SshSuspendService WARN] handleSessionTermination: Session not found for suspendSessionId=${suspendSessionId} when event '${reasonSuffix}' occurred.`);
      }
    };
    
    console.log(`[SshSuspendService DEBUG] takeOverMarkedSession: Setting up channel/client event listeners for suspendSessionId=${suspendSessionId}`);
    channel.on('close', () => {
      console.log(`[SshSuspendService DEBUG] channel.on('close') triggered for suspendSessionId=${suspendSessionId}`);
      handleSessionTermination('channel closed');
    });
    channel.on('error', (err: Error) => {
      console.error(`[SshSuspendService ERROR] channel.on('error') for suspendSessionId=${suspendSessionId}:`, err);
      handleSessionTermination('channel errored');
    });
    channel.on('end', () => {
      console.log(`[SshSuspendService DEBUG] channel.on('end') triggered for suspendSessionId=${suspendSessionId}`);
      handleSessionTermination('channel ended');
    });
    channel.on('exit', (code: number | null, signalName: string | null) => {
      console.log(`[SshSuspendService DEBUG] channel.on('exit') triggered for suspendSessionId=${suspendSessionId}. Code: ${code}, Signal: ${signalName}`);
      handleSessionTermination(`channel exited with code ${code}, signal ${signalName}`);
    });
  
    sshClient.on('error', (err: Error) => {
      console.error(`[SshSuspendService ERROR] sshClient.on('error') for suspendSessionId=${suspendSessionId}:`, err);
      handleSessionTermination('client errored');
    });
    sshClient.on('end', () => {
      console.log(`[SshSuspendService DEBUG] sshClient.on('end') triggered for suspendSessionId=${suspendSessionId}`);
      handleSessionTermination('client ended');
    });

    return suspendSessionId;
  }
  
  private removeChannelListeners(channel: Channel, sshClient: Client): void {
    channel.removeAllListeners('data');
    channel.removeAllListeners('close');
    channel.removeAllListeners('error');
    channel.removeAllListeners('end');
    channel.removeAllListeners('exit');
    sshClient.removeAllListeners('error');
    sshClient.removeAllListeners('end');
  }

  /**
   * 列出指定用户的所有挂起会话（包括活跃和已断开的）。
   * 目前主要从内存中获取信息。
   * @param userId 用户ID。
   * @returns Promise<SuspendedSessionInfo[]> 挂起会话信息的数组。
   */
  async listSuspendedSessions(userId: number): Promise<SuspendedSessionInfo[]> {
    const userSessions = this.getUserSessions(userId);
    const sessionsInfo: SuspendedSessionInfo[] = [];

    for (const [suspendSessionId, details] of userSessions.entries()) {
      sessionsInfo.push({
        suspendSessionId,
        connectionName: details.connectionName,
        connectionId: details.connectionId,
        suspendStartTime: details.suspendStartTime,
        customSuspendName: details.customSuspendName,
        backendSshStatus: details.backendSshStatus,
        disconnectionTimestamp: details.disconnectionTimestamp,
        originalSessionId: details.originalSessionId,
        manuallySuspended: details.manuallySuspended === true,
      });
    }
    // TODO: 增强此方法以从日志目录恢复 'disconnected_by_backend' 的会话状态，
    // 这需要日志文件包含元数据。
    return sessionsInfo;
  }

  /**
   * 找出「这个前端会话断开时被自动挂起」的那条记录，用于 WebSocket 抖动后**就地接回**。
   *
   * 只认 `backendSshStatus === 'hanging'`（SSH 连接还活着）且不是手动挂起的条目：
   *   - `disconnected_by_backend`：远端已经断了（reboot / 进程被杀），谈不上接回，只能新建；
   *   - `manuallySuspended`：用户自己关掉的标签，接回等于把用户关掉的东西复活。
   */
  findReattachableSession(
    userId: number,
    originalSessionId: string
  ): { suspendSessionId: string; connectionName: string } | null {
    if (!originalSessionId) return null;
    const userSessions = this.getUserSessions(userId);
    for (const [suspendSessionId, details] of userSessions.entries()) {
      if (
        details.originalSessionId === originalSessionId &&
        details.backendSshStatus === 'hanging' &&
        details.manuallySuspended !== true
      ) {
        return { suspendSessionId, connectionName: details.connectionName };
      }
    }
    return null;
  }

  /**
   * 清掉「上一轮工作区接管留下的、这一轮不会再有人认领」的自动挂起条目。
   *
   * 判定见 `shouldPruneTakeoverSuspend`：只动「接管产生的 + 不是本轮 + 云端快照里已经没有」的。
   * 调用方是 `WorkspaceSyncService.claimLease`，在把旧端会话移交过来之后立刻跑一次 ——
   * 否则反复接管几次，挂起面板里就会堆出一串用户根本没打开过的会话。
   *
   * @returns 被清掉的挂起会话 ID 列表（便于日志/诊断）
   */
  async pruneOrphanTakeoverSessions(
    userId: number,
    currentRound: number,
    keepOriginalSessionIds: ReadonlySet<string>
  ): Promise<string[]> {
    const userSessions = this.getUserSessions(userId);
    const removed: string[] = [];
    for (const [suspendSessionId, details] of Array.from(userSessions.entries())) {
      if (!shouldPruneTakeoverSuspend(details, currentRound, keepOriginalSessionIds)) continue;
      try {
        const ok = await this.terminateSuspendedSession(userId, suspendSessionId);
        if (ok) removed.push(suspendSessionId);
      } catch (err: any) {
        console.warn(
          `[SshSuspendService WARN] 清理接管遗留的挂起会话 ${suspendSessionId} 失败:`,
          err?.message || err
        );
      }
    }
    return removed;
  }

  /**
   * 恢复指定的挂起会话。
   * @param userId 用户ID。
   * @param suspendSessionId 要恢复的挂起会话ID。
   * @param options.replay `full`（默认）回放全部历史，用于刷新页面后的恢复；
   *   `delta` 只回放断线期间新增的输出，用于终端里已有历史的「就地接回」。
   * @returns Promise<{ sshClient: Client; channel: ClientChannel; logData: string; fullLogData: string; ... } | null>
   *   `logData` 是按 replay 处理过、要发给前端的部分；`fullLogData` 是完整历史，只用于维护后端自己的环形缓冲，不回放。
   */
  async resumeSession(
    userId: number,
    suspendSessionId: string,
    options?: { replay?: 'full' | 'delta' }
  ): Promise<{
    sshClient: Client;
    channel: ClientChannel;
    logData: string;
    fullLogData: string;
    connectionName: string;
    originalConnectionId: string;
    paneStreams?: Map<string, any>;
    utf8Decoder?: { write(buf: Buffer): string; end(): string };
    getPendingResumeData?: () => Buffer[];
  } | null> {
    const userSessions = this.getUserSessions(userId);
    const session = userSessions.get(suspendSessionId);

    if (!session) {
      return null;
    }

    if (session.backendSshStatus !== 'hanging') {
      return null;
    }

    // 1. 先激活过渡队列，防止旧通道在移除监听器或切换期间发生数据丢失
    //    注意：不在此处调用 utf8Decoder.end()，而是把同一个解码器实例原样接力给恢复后的实时流，
    //    保证跨挂起/恢复边界的多字节 UTF-8 字符（中文/Emoji）无缝续接、绝不产出 U+FFFD。
    session.pendingResumeBuffer = [];

    // 2. 优先从内存缓冲中无缝拼接完整数据，避免异步磁盘 I/O 排队未落盘导致的尾部数据丢失
    let fullLogData = '';
    let deltaLogData = '';
    const historyChunks = session.historyChunks ?? 0;
    if (session.inMemoryBuffer && session.inMemoryBuffer.length > 0) {
      fullLogData = session.inMemoryBuffer.join('');
      deltaLogData = session.inMemoryBuffer.slice(historyChunks).join('');
      console.log(`[SshSuspendService][用户: ${userId}] resumeSession: 优先从内存输出缓冲拼接挂起会话 ${suspendSessionId} 数据，长度: ${fullLogData.length}（其中断线期间新增 ${deltaLogData.length}）`);
    } else {
      try {
        fullLogData = await this.logStorageService.readLog(session.tempLogPath);
        deltaLogData = fullLogData.slice(session.historyChars ?? 0);
        console.log(`[SshSuspendService][用户: ${userId}] resumeSession: 从磁盘读取挂起会话 ${suspendSessionId} (日志: ${session.tempLogPath}) 数据，长度: ${fullLogData.length}（其中断线期间新增 ${deltaLogData.length}）`);
      } catch (error) {
        fullLogData = '';
        deltaLogData = '';
      }
    }
    const logData = options?.replay === 'delta' ? deltaLogData : fullLogData;

    // 停止挂起阶段的旧监听器
    this.removeChannelListeners(session.channel, session.sshClient);
    
    // 保存返回的会话关键信息与过渡期缓冲
    const { sshClient, channel, connectionName, connectionId: originalConnectionId, paneStreams, utf8Decoder } = session;
    const pendingData = session.pendingResumeBuffer;

    userSessions.delete(suspendSessionId);
    try {
      await this.logStorageService.deleteLog(session.tempLogPath);
    } catch (error) {}

    return {
      sshClient,
      channel,
      logData,
      fullLogData,
      connectionName,
      originalConnectionId,
      paneStreams,
      utf8Decoder,
      getPendingResumeData: () => pendingData || [],
    };
  }

  /**
   * 终止一个活跃的挂起会话。
   * @param userId 用户ID。
   * @param suspendSessionId 要终止的挂起会话ID。
   * @returns Promise<boolean> 操作是否成功。
   */
  async terminateSuspendedSession(userId: number, suspendSessionId: string): Promise<boolean> { // userId: string -> number
    const userSessions = this.getUserSessions(userId);
    const session = userSessions.get(suspendSessionId);

    if (!session || session.backendSshStatus !== 'hanging') {
      console.warn(`[用户: ${userId}] 尝试终止的会话 ${suspendSessionId} 不存在或不是活跃状态 (${session?.backendSshStatus})。`);
      // 如果会话已断开，但记录还在，也应该能被“终止”（即移除）
      if(session && session.backendSshStatus === 'disconnected_by_backend'){
        const logPathToDelete = session.tempLogPath; // 获取正确的日志路径
        userSessions.delete(suspendSessionId);
        await this.logStorageService.deleteLog(logPathToDelete);
        console.log(`[用户: ${userId}] 已断开的挂起会话条目 ${suspendSessionId} (日志: ${logPathToDelete}) 已通过终止操作移除。`);
        return true;
      }
      return false;
    }

    this.removeChannelListeners(session.channel, session.sshClient);

    // 销毁所有分屏 Shell 通道
    if (session.paneStreams && session.paneStreams.size > 0) {
      for (const [, pState] of session.paneStreams.entries()) {
        try {
          pState.stream?.destroy?.();
          pState.stream?.end?.();
        } catch (e) {}
      }
      session.paneStreams.clear();
    }

    try {
      session.channel.close(); // 尝试优雅关闭
    } catch (e) {
      console.warn(`[用户: ${userId}, 会话: ${suspendSessionId}] 关闭channel时出错:`, e);
    }
    try {
      session.sshClient.end(); // 尝试优雅关闭
    } catch (e) {
      console.warn(`[用户: ${userId}, 会话: ${suspendSessionId}] 关闭sshClient时出错:`, e);
    }
    
    const logPathToFinallyDelete = session.tempLogPath; // 获取正确的日志路径
    userSessions.delete(suspendSessionId);
    await this.logStorageService.deleteLog(logPathToFinallyDelete);

    console.log(`[用户: ${userId}] 活跃的挂起会话 ${suspendSessionId} (日志: ${logPathToFinallyDelete}) 已成功终止并移除。`);
    return true;
  }

  /**
   * 移除一个已断开的挂起会话条目。
   * @param userId 用户ID。
   * @param suspendSessionId 要移除的挂起会话ID。
   * @returns Promise<boolean> 操作是否成功。
   */
  async removeDisconnectedSessionEntry(userId: number, suspendSessionId: string): Promise<boolean> { // userId: string -> number
    const userSessions = this.getUserSessions(userId);
    const session = userSessions.get(suspendSessionId);

    if (session && session.backendSshStatus === 'hanging') {
      console.warn(`[用户: ${userId}] 尝试移除的会话 ${suspendSessionId} 仍处于活跃状态，请先终止。`);
      return false; // 不允许直接移除活跃会话，应先终止
    }

    // 如果会话在内存中（不论状态），则删除
    if (session) {
      userSessions.delete(suspendSessionId);
    }
    
    // 总是尝试删除日志文件，因为它可能对应一个已不在内存中的断开会话
    try {
      // suspendSessionId 在这里是用户从UI上选择的，可能在内存中，也可能不在 (只剩日志文件)
      // 如果在内存中，session.tempLogPath 是正确的日志标识符
      // 如果不在内存中，suspendSessionId 本身可能就是日志文件名 (如果之前设计是这样的话，但现在统一用 originalSessionId 作为日志名基础)
      // 假设 remove 请求中的 suspendSessionId 就是我们存储的那个挂起ID
      const logPathToRemove = session ? session.tempLogPath : suspendSessionId; // 如果 session 不在内存，尝试直接用 suspendSessionId 作为日志文件名部分
      await this.logStorageService.deleteLog(logPathToRemove);
      console.log(`[用户: ${userId}] 已断开的挂起会话条目 ${suspendSessionId} 的日志 (标识: ${logPathToRemove}) 已删除 (内存中状态: ${session ? session.backendSshStatus : '不在内存'})。`);
      return true;
    } catch (error) {
      console.error(`[用户: ${userId}] 删除会话 ${suspendSessionId} 的日志文件失败:`, error);
      // 即便日志删除失败，如果内存条目已删，也算部分成功。但严格来说应返回false。
      // 如果 session 不在内存中，但日志删除成功，也算成功。
      return false; 
    }
  }

  /**
   * 编辑挂起会话的自定义名称。
   * 目前仅更新内存中的名称。
   * @param userId 用户ID。
   * @param suspendSessionId 挂起会话ID。
   * @param newCustomName 新的自定义名称。
   * @returns Promise<boolean> 操作是否成功。
   */
  async editSuspendedSessionName(userId: number, suspendSessionId: string, newCustomName: string): Promise<boolean> { // userId: string -> number
    const userSessions = this.getUserSessions(userId);
    const session = userSessions.get(suspendSessionId);

    if (!session) {
      console.warn(`[用户: ${userId}] 尝试编辑名称的会话 ${suspendSessionId} 不存在。`);
      return false;
    }

    session.customSuspendName = newCustomName;
    console.log(`[用户: ${userId}] 挂起会话 ${suspendSessionId} 的自定义名称已更新为: ${newCustomName}`);
    // TODO: 如果设计要求将自定义名称持久化到日志文件的元数据部分，
    // 此处需要添加更新日志文件的逻辑。这可能涉及读取、修改元数据、然后重写文件。
    return true;
  }

  /**
   * 处理特定会话的 SSH 连接意外断开。
   * 此方法主要由内部事件监听器调用。
   * @param userId 用户ID。
   * @param suspendSessionId 发生断开的会话ID。
   */
  public handleUnexpectedDisconnection(userId: number, suspendSessionId: string): void { // userId: string -> number
    const userSessions = this.getUserSessions(userId);
    const session = userSessions.get(suspendSessionId);

    if (session && session.backendSshStatus === 'hanging') {
      const reason = 'Unexpected disconnection handled by SshSuspendService.';
      session.backendSshStatus = 'disconnected_by_backend';
      session.disconnectionTimestamp = new Date().toISOString();
      this.removeChannelListeners(session.channel, session.sshClient); // 移除监听器
      console.log(`[用户: ${userId}] 会话 ${suspendSessionId} 状态更新为 'disconnected_by_backend'。原因: ${reason}`);
      
      this.emit('sessionAutoTerminated', {
        userId: session.userId,
        suspendSessionId,
        reason
      });
      // 确保所有已缓冲的日志已尝试写入 (通常由 'data' 事件处理，这里是最终状态确认)
    }
  }

  /**
   * 获取指定挂起会话的日志内容。
   * 允许导出 'disconnected_by_backend' 和 'hanging' 状态的会话日志。
   * @param userId 用户ID。
   * @param suspendSessionId 要导出日志的挂起会话ID。
   * @returns Promise<{ content: string, filename: string } | null> 日志内容和建议的文件名，如果会话不符合条件或读取失败则返回null。
   */
  async getSessionLogContent(userId: number, suspendSessionId: string): Promise<{ content: string, filename: string } | null> {
    console.log(`[SshSuspendService][用户: ${userId}] getSessionLogContent 调用，suspendSessionId: ${suspendSessionId}`);
    const userSessions = this.getUserSessions(userId);
    const session = userSessions.get(suspendSessionId);

    if (!session) {
      console.warn(`[SshSuspendService][用户: ${userId}] getSessionLogContent: 未找到挂起的会话 ${suspendSessionId}。`);
      return null;
    }

    if (session.backendSshStatus !== 'disconnected_by_backend' && session.backendSshStatus !== 'hanging') {
      console.warn(`[SshSuspendService][用户: ${userId}] getSessionLogContent: 会话 ${suspendSessionId} 状态为 ${session.backendSshStatus}，不符合导出条件 (需要 'disconnected_by_backend' 或 'hanging')。`);
      return null;
    }

    if (!session.tempLogPath) {
        console.error(`[SshSuspendService][用户: ${userId}] getSessionLogContent: 会话 ${suspendSessionId} 缺少 tempLogPath。`);
        return null;
    }

    try {
      const logContent = await this.logStorageService.readLog(session.tempLogPath);
      console.log(`[SshSuspendService][用户: ${userId}] getSessionLogContent: 已读取挂起会话 ${suspendSessionId} (日志: ${session.tempLogPath}) 的数据，长度: ${logContent.length}`);
      
      const baseName = session.customSuspendName || session.connectionName || suspendSessionId.substring(0,8);
      const safeBaseName = baseName.replace(/[^\w.-]/g, '_'); // 替换掉不安全字符为空格或下划线
      const timestamp = new Date(session.suspendStartTime).toISOString().replace(/[:.]/g, '-');
      // tempLogPath 通常是 originalSessionId
      const filename = `ssh_log_${safeBaseName}_${session.tempLogPath}_${timestamp}.log`;

      return { content: logContent, filename };
    } catch (error) {
      console.error(`[SshSuspendService][用户: ${userId}] getSessionLogContent: 读取挂起会话 ${suspendSessionId} (日志: ${session.tempLogPath}) 失败:`, error);
      return null;
    }
  }
}

// 单例模式导出
export const sshSuspendService = new SshSuspendService();