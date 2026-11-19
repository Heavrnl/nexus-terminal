import WebSocket, { WebSocketServer, RawData } from 'ws';
import { Request } from 'express';
import { StringDecoder } from 'node:string_decoder';
import {
    AuthenticatedWebSocket,
    SshSuspendStartRequest,
    SshSuspendListRequest,
    SshSuspendResumeRequest,
    SshReattachRequest,
    SshSuspendTerminateRequest,
    SshSuspendRemoveEntryRequest,
    // SshSuspendEditNameRequest, // Removed as it's now HTTP
    SshSuspendStartedResponse,
    SshSuspendListResponse,
    SshSuspendResumedNotification,
    SshOutputCachedChunk,
    SshSuspendTerminatedResponse,
    SshSuspendEntryRemovedResponse,
    // SshSuspendNameEditedResponse, // Removed as it's now HTTP
    SshSuspendAutoTerminatedNotification,
    SshMarkForSuspendRequest,
    SshMarkedForSuspendAck,
    SshUnmarkForSuspendRequest,    
    SshUnmarkedForSuspendAck,      
    ClientState
} from './types';
import { SshSuspendService } from '../ssh-suspend/ssh-suspend.service';
import { SftpService } from '../sftp/sftp.service';
import { appendRingBuffer, cleanupClientConnection } from './utils';
import { BackendTerminalEmulator } from './terminal-emulator';
import { OutputCoalescer } from './output-coalescer';
import { clientStates } from './state';
import { temporaryLogStorageService } from '../ssh-suspend/temporary-log-storage.service'; 
import { workspaceSyncService } from '../workspace-sync/workspace-sync.service'; 

// Handlers
import {
    handleSshConnect,
    handleSshInput,
    handleSshResize,
    handleSshResumeSuccess,
    handleSshPaneOpen,
    handleSshPaneInput,
    handleSshPaneResize,
    handleSshPaneClose
} from './handlers/ssh.handler';
import {
    handleDockerGetStatus,
    handleDockerCommand,
    handleDockerGetStats,
    handleDockerGetExecCommand
} from './handlers/docker.handler';
import {
    handleSftpOperation,
    handleSftpUploadStart,
    handleSftpUploadChunk,
    handleSftpUploadCancel
} from './handlers/sftp.handler';

/**
 * 把一个挂起会话接回某个 WebSocket 上（两条路共用）：
 *   - 挂起面板 / 刷新后恢复工作区：`replay: 'full'`，前端终端是空的，要回放全部历史；
 *   - WS 抖动后就地接回：`replay: 'delta'`，前端终端里已经有历史了，只补断线期间新增的那段。
 *
 * 无论哪种，后端自己的 `recentOutputBuffer` 都存**完整**历史，
 * 这样下一次挂起时写进日志的 initialBuffer 仍然带着全部回滚内容。
 */
async function activateResumedSession(params: {
    ws: AuthenticatedWebSocket;
    clientIp: string;
    sftpService: SftpService;
    sshSuspendService: SshSuspendService;
    suspendSessionId: string;
    newFrontendSessionId: string;
    replay: 'full' | 'delta';
    /** 挂起面板/恢复流程需要这条通知来收尾（弹提示、激活标签）；就地接回不需要 */
    notifySuspendResumed: boolean;
}): Promise<{ ok: true; connectionName: string } | { ok: false; error: string }> {
    const { ws, clientIp, sftpService, sshSuspendService, suspendSessionId, newFrontendSessionId, replay, notifySuspendResumed } = params;
    const userId = ws.userId;
    if (!userId) return { ok: false, error: '用户认证失败' };

    const result = await sshSuspendService.resumeSession(userId, suspendSessionId, { replay });
    if (!result) {
        return { ok: false, error: '服务未能恢复会话，或会话不存在/状态不正确。' };
    }

    const resumedEmulator =
        result.terminalEmulator && !result.terminalEmulator.isDisposed()
            ? result.terminalEmulator
            : new BackendTerminalEmulator();
    if (!resumedEmulator.hasAnyOutput() && result.fullLogData) {
        resumedEmulator.write(result.fullLogData);
    }

    const newSessionState: ClientState = {
        ws, // 当前的 WebSocket 连接
        sshClient: result.sshClient,
        sshShellStream: result.channel,
        dbConnectionId: parseInt(result.originalConnectionId, 10), // 从结果中恢复并转换为数字
        connectionName: result.connectionName, // 从结果中恢复
        ipAddress: clientIp,
        isShellReady: true, // 恢复后 Shell 立即可用
        recentOutputBuffer: [],
        recentOutputBytes: 0,
        terminalEmulator: resumedEmulator,
        paneStreams: result.paneStreams ? new Map(result.paneStreams) : new Map(),
    };
    // 屏幕完整历史已由 Headless VT 托管，无需再在 recentOutputBuffer 里多存一份原始文本副本
    clientStates.set(newFrontendSessionId, newSessionState);
    ws.sessionId = newFrontendSessionId; // 将当前 ws 与新会话关联

    // 为恢复的会话初始化 SFTP (异步后台执行)
    sftpService.initializeSftpSession(newFrontendSessionId).catch(sftpInitErr => {
        console.error(`[WebSocket Handler] 为恢复的会话 ${newFrontendSessionId} 初始化 SFTP 失败:`, sftpInitErr);
    });

    // 1. 第一步：先向前端发送挂起与历史日志数据块 SSH_OUTPUT_CACHED_CHUNK
    //    按 128KB 分片发送，避免数 MB 历史打成一个超大单帧 JSON 阻塞弱网/代理；
    //    切分点注意避开 UTF-16 代理对（emoji），防止把 4 字节字符切成半个 surrogate。
    //    日志里存的是 PTY 原始字节，原样回放，不要再做 `\n` → `\r\n` 的"规范化"。
    const logData = result.logData || '';
    console.log(`[SSH Suspend Backend] 准备发送${replay === 'delta' ? '断线期间新增' : '恢复'}日志给前端 (长度: ${logData.length}, 会话: ${newFrontendSessionId})`);
    if (logData && ws.readyState === WebSocket.OPEN) {
        const CHUNK_CHARS = 128 * 1024;
        let offset = 0;
        while (offset < logData.length && ws.readyState === WebSocket.OPEN) {
            let end = Math.min(offset + CHUNK_CHARS, logData.length);
            // 若正好落在高代理码元上，向后多带 1 个码元保持代理对完整
            if (end < logData.length) {
                const code = logData.charCodeAt(end - 1);
                if (code >= 0xd800 && code <= 0xdbff) {
                    end++;
                }
            }
            const slice = logData.slice(offset, end);
            const isLastChunk = end >= logData.length;
            const logChunkResponse: SshOutputCachedChunk = {
                type: 'SSH_OUTPUT_CACHED_CHUNK',
                payload: { frontendSessionId: newFrontendSessionId, data: slice, isLastChunk }
            };
            ws.send(JSON.stringify(logChunkResponse));
            offset = end;
        }
    }

    // 2. 第二步：发送恢复过渡期间暂存的数据（若有）
    //    接力复用同一 StringDecoder，避免跨恢复边界把多字节 UTF-8 切成 U+FFFD
    const liveDecoder = result.utf8Decoder || new StringDecoder('utf8');
    newSessionState.outDecoder = liveDecoder;

    if (typeof (result as any).getPendingResumeData === 'function') {
        const pendingBuffers: Buffer[] = (result as any).getPendingResumeData();
        if (pendingBuffers && pendingBuffers.length > 0) {
            console.log(`[SSH Suspend Backend] 正在回放恢复过渡期间暂存的数据块 (${pendingBuffers.length} 块)`);
            for (const buf of pendingBuffers) {
                const utf8Str = liveDecoder.write(buf);
                newSessionState.terminalEmulator?.write(utf8Str);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'ssh:output',
                        payload: buf.toString('base64'),
                        encoding: 'base64'
                    }));
                }
            }
        }
    }

    // 3. 第三步：重新设置实时事件监听器，将后续数据流导向新前端会话并维护 Headless VT（高频输出微批合帧）
    const resumedCoalescer = new OutputCoalescer({
        onFlush: (merged: Buffer) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'ssh:output',
                    payload: merged.toString('base64'),
                    encoding: 'base64'
                }));
            }
        },
    });
    newSessionState.outputCoalescer = resumedCoalescer;
    result.channel.removeAllListeners('data');
    result.channel.on('data', (data: Buffer) => {
        const utf8Data = liveDecoder.write(data);
        newSessionState.terminalEmulator?.write(utf8Data);
        if (newSessionState.isHandingOverToSuspend || !newSessionState.terminalEmulator) {
            appendRingBuffer(newSessionState, utf8Data);
        }
        resumedCoalescer.push(data);
    });

    result.channel.on('close', () => {
        console.log(`[WebSocket Handler] 恢复的会话 ${newFrontendSessionId} 的 channel 已关闭。`);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ssh:disconnected', payload: { sessionId: newFrontendSessionId } }));
        }
        cleanupClientConnection(newFrontendSessionId, ws);
    });
    result.sshClient.on('error', (err: Error) => {
        console.error(`[WebSocket Handler] 恢复后的 SSH 客户端错误 (会话: ${newFrontendSessionId}):`, err);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ssh:error', payload: { sessionId: newFrontendSessionId, error: err.message } }));
        cleanupClientConnection(newFrontendSessionId, ws);
    });

    // 4. 第四步：发送 ssh:connected 与 SSH_SUSPEND_RESUMED_NOTIF 通知前端会话已激活
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'ssh:connected',
            payload: {
                connectionId: newSessionState.dbConnectionId,
                sessionId: newFrontendSessionId
            }
        }));
        console.log(`[WebSocket Handler] 已发送 ssh:connected 给 ${newFrontendSessionId}。`);

        if (notifySuspendResumed) {
            const responseNotification: SshSuspendResumedNotification = {
                type: 'SSH_SUSPEND_RESUMED_NOTIF',
                payload: { suspendSessionId, newFrontendSessionId, success: true }
            };
            ws.send(JSON.stringify(responseNotification));
        }
    }

    // 启动状态监控
    handleSshResumeSuccess(newFrontendSessionId);

    return { ok: true, connectionName: result.connectionName };
}

export function initializeConnectionHandler(wss: WebSocketServer, sshSuspendService: SshSuspendService, sftpService: SftpService): void { // +++ Add sftpService parameter +++
    wss.on('connection', (ws: AuthenticatedWebSocket, request: Request) => {
        ws.isAlive = true;
        const clientIp = (request as any).clientIpAddress || 'unknown'; // Preserved from upgrade handler

        console.log(`WebSocket：客户端 ${ws.username} (ID: ${ws.userId}, IP: ${clientIp}) 已连接。`);

        ws.on('pong', () => { ws.isAlive = true; });

        {
            workspaceSyncService.registerSocket(ws.userId || 1, ws);
            // Standard SSH/SFTP/Docker connection
            ws.on('message', async (message: RawData) => {
                ws.isAlive = true;
                (ws as any).missedPongs = 0;
                let parsedMessage: any;
                try {
                    parsedMessage = JSON.parse(message.toString());
                } catch (e) {
                    console.error(`WebSocket：来自 ${ws.username} 的无效 JSON 消息:`, message.toString());
                    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', payload: '无效的消息格式 (非 JSON)' }));
                    return;
                }

                const { type, payload, requestId, sessionId: messageSessionId } = parsedMessage;
                const sessionId = ws.sessionId || messageSessionId; // 优先获取当前 WebSocket 的已绑定 sessionId，若尚未绑定则使用消息附带的 sessionId

                // It's crucial to get the state associated with the current ws.sessionId
                // For 'ssh:connect', ws.sessionId will be undefined initially, so state will be undefined.
                // For other messages, ws.sessionId should exist if connection was successful.
                const state = sessionId ? clientStates.get(sessionId) : undefined;

                try {
                    switch (type) {
                        // SSH Cases
                        case 'ssh:connect':
                            // Pass the original Express request object for IP and session
                            await handleSshConnect(ws, request, payload);
                            break;
                        case 'ssh:input':
                            handleSshInput(ws, payload);
                            break;
                        case 'ssh:resize':
                            handleSshResize(ws, payload);
                            break;
                        case 'ssh:pane_open':
                            await handleSshPaneOpen(ws, payload, sessionId);
                            break;
                        case 'ssh:pane_input':
                            handleSshPaneInput(ws, payload, sessionId);
                            break;
                        case 'ssh:pane_resize':
                            handleSshPaneResize(ws, payload, sessionId);
                            break;
                        case 'ssh:pane_close':
                            handleSshPaneClose(ws, payload, sessionId);
                            break;

                        // Docker Cases
                        case 'docker:get_status':
                            await handleDockerGetStatus(ws, sessionId);
                            break;
                        case 'docker:command':
                            await handleDockerCommand(ws, sessionId, payload);
                            break;
                        case 'docker:get_stats':
                            await handleDockerGetStats(ws, sessionId, payload);
                            break;
                        case 'docker:get_exec_command':
                            await handleDockerGetExecCommand(ws, sessionId, payload);
                            break;
                        
                        // SFTP Cases (generic operations)
                        case 'sftp:readdir':
                        case 'sftp:stat':
                        case 'sftp:readfile':
                        case 'sftp:writefile':
                        case 'sftp:mkdir':
                        case 'sftp:rmdir':
                        case 'sftp:unlink':
                        case 'sftp:rename':
                        case 'sftp:chmod':
                        case 'sftp:chown':
                        case 'sftp:realpath':
                        case 'sftp:copy':
                        case 'sftp:move':
                        case 'sftp:compress':
                        case 'sftp:decompress':
                            await handleSftpOperation(ws, type, payload, requestId);
                            break;

                        // SFTP Upload Cases
                        case 'sftp:upload:start':
                            await handleSftpUploadStart(ws, payload);
                            break;
                        case 'sftp:upload:chunk':
                            await handleSftpUploadChunk(ws, payload);
                            break;
                        case 'sftp:upload:cancel':
                            handleSftpUploadCancel(ws, payload);
                            break;

                        // --- SSH Suspend Cases ---

                        case 'SSH_SUSPEND_LIST_REQUEST': {
                            if (!ws.userId) {
                                console.error(`[SSH_SUSPEND_LIST_REQUEST] 用户 ID 未定义。`);
                                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'SSH_SUSPEND_LIST_RESPONSE', payload: { suspendSessions: [] } })); // 返回空列表或错误
                                break;
                            }
                            try {
                                const sessions = await sshSuspendService.listSuspendedSessions(ws.userId);
                                const response: SshSuspendListResponse = {
                                    type: 'SSH_SUSPEND_LIST_RESPONSE',
                                    payload: { suspendSessions: sessions }
                                };
                                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
                            } catch (error: any) {
                                console.error(`[SSH_SUSPEND_LIST_REQUEST] 获取挂起列表失败:`, error);
                                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'SSH_SUSPEND_LIST_RESPONSE', payload: { suspendSessions: [] } })); // 返回空列表或错误
                            }
                            break;
                        }
                        case 'SSH_SUSPEND_RESUME_REQUEST': {
                            const resumePayload = payload as SshSuspendResumeRequest['payload'];
                            const { suspendSessionId, newFrontendSessionId } = resumePayload;
                            // console.log(`[WebSocket Handler][${type}] 接到请求。UserID: ${ws.userId}, WsSessionID: ${ws.sessionId}, Payload: ${JSON.stringify(resumePayload)}`);

                            if (!ws.userId) {
                                console.error(`[WebSocket Handler][${type}] 用户 ID 未定义。`);
                                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'SSH_SUSPEND_RESUMED_NOTIF', payload: { suspendSessionId, newFrontendSessionId, success: false, error: '用户认证失败' } }));
                                break;
                            }
                            try {
                                // 挂起面板 / 刷新后恢复：前端终端是空的，回放全部历史
                                await activateResumedSession({
                                    ws,
                                    clientIp,
                                    sftpService,
                                    sshSuspendService,
                                    suspendSessionId,
                                    newFrontendSessionId,
                                    replay: 'full',
                                    notifySuspendResumed: true,
                                });
                            } catch (error: any) {
                                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'SSH_SUSPEND_RESUMED_NOTIF', payload: { suspendSessionId, newFrontendSessionId, success: false, error: error.message || '恢复会话失败' } }));
                            }
                            break;
                        }
                        /**
                         * 就地接回：WebSocket 因网络抖动断开、又自动连上时，先把刚才被后端自动挂起的
                         * 那条会话接回**同一个前端会话 id**，而不是闷头新建一条 SSH。
                         *
                         * 不这么做的话：ws 一断后端就把 SSH 转进挂起池保活，前端重连却发 ssh:connect
                         * 新建一条 —— 结果是屏幕上换了个全新的 shell，断网前那个 shell（连同 cwd、
                         * 跑着的进程）留在后台挂起池里变成没人认领的僵尸。
                         *
                         * 只认 `hanging` 且非手动挂起的条目：远端真断了（reboot / 进程被杀）接不回来，
                         * 用户自己关掉的标签也不该被按键复活 —— 这两种情况回 success:false，前端退回新建。
                         */
                        case 'SSH_REATTACH_REQUEST': {
                            const reattachPayload = payload as SshReattachRequest['payload'];
                            const requestedSessionId = (reattachPayload?.sessionId || messageSessionId || ws.sessionId || '').trim();
                            const replyReattach = (success: boolean, extra: Record<string, unknown> = {}) => {
                                if (ws.readyState === WebSocket.OPEN) {
                                    ws.send(JSON.stringify({
                                        type: 'SSH_REATTACH_RESULT',
                                        payload: { sessionId: requestedSessionId, success, ...extra },
                                    }));
                                }
                            };

                            if (!ws.userId) {
                                replyReattach(false, { reason: 'unauthorized' });
                                break;
                            }
                            if (!requestedSessionId) {
                                replyReattach(false, { reason: 'not_suspended' });
                                break;
                            }

                            /*
                             * 这里要容忍一个竞态：ws 一断，`cleanupClientConnection` 才开始异步
                             * 「写初始日志 → takeOverMarkedSession」，中间有几次 await（读工作区快照、
                             * 落盘 1MB 日志）。重连如果正好挤进这段窗口，`findReattachableSession`
                             * 会一无所获，前端就退回新建 —— 又变回僵尸。
                             * 所以先等一小会儿（最多 1.2s），条目一出现立刻接。
                             * 前端那边的兜底是 2.5s，留够余量。
                             */
                            const REATTACH_WAIT_MS = 1200;
                            const REATTACH_POLL_MS = 100;
                            const waitStart = Date.now();
                            let reattachHit = sshSuspendService.findReattachableSession(ws.userId, requestedSessionId);
                            while (!reattachHit && Date.now() - waitStart < REATTACH_WAIT_MS) {
                                if (ws.readyState !== WebSocket.OPEN) break; // 前端又断了就不必等了
                                await new Promise(resolve => setTimeout(resolve, REATTACH_POLL_MS));
                                reattachHit = sshSuspendService.findReattachableSession(ws.userId, requestedSessionId);
                            }
                            if (!reattachHit) {
                                console.log(`[SSH_REATTACH] 会话 ${requestedSessionId} 等了 ${Date.now() - waitStart}ms 仍没有可接回的挂起条目，交回前端新建连接`);
                                replyReattach(false, { reason: 'not_suspended' });
                                break;
                            }
                            if (Date.now() - waitStart > REATTACH_POLL_MS) {
                                console.log(`[SSH_REATTACH] 会话 ${requestedSessionId} 的挂起条目在等待 ${Date.now() - waitStart}ms 后才就绪（断连清理尚未收尾），已接上`);
                            }

                            console.log(`[SSH_REATTACH] 会话 ${requestedSessionId} 命中挂起条目 ${reattachHit.suspendSessionId}（${reattachHit.connectionName}），就地接回`);
                            try {
                                const reattachRes = await activateResumedSession({
                                    ws,
                                    clientIp,
                                    sftpService,
                                    sshSuspendService,
                                    suspendSessionId: reattachHit.suspendSessionId,
                                    newFrontendSessionId: requestedSessionId,
                                    replay: 'delta',
                                    notifySuspendResumed: false,
                                });
                                if (reattachRes.ok) {
                                    replyReattach(true, { connectionName: reattachHit.connectionName });
                                } else {
                                    replyReattach(false, { reason: reattachRes.error });
                                }
                            } catch (error: any) {
                                console.error(`[SSH_REATTACH] 接回会话 ${requestedSessionId} 失败:`, error);
                                replyReattach(false, { reason: error?.message || 'error' });
                            }
                            break;
                        }
                        case 'SSH_SUSPEND_TERMINATE_REQUEST': {
                            const { suspendSessionId } = payload as SshSuspendTerminateRequest['payload'];
                            console.log(`[WebSocket Handler] Received SSH_SUSPEND_TERMINATE_REQUEST. UserID: ${ws.userId}, WsSessionID: ${ws.sessionId}, SuspendSessionID: ${suspendSessionId}`);
                             if (!ws.userId) {
                                 console.error(`[SSH_SUSPEND_TERMINATE_REQUEST] 用户 ID 未定义。Payload: ${JSON.stringify(payload)}`);
                                 if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'SSH_SUSPEND_TERMINATED_RESP', payload: { suspendSessionId, success: false, error: '用户认证失败' } }));
                                 break;
                            }
                            try {
                                const success = await sshSuspendService.terminateSuspendedSession(ws.userId, suspendSessionId);
                                const response: SshSuspendTerminatedResponse = {
                                    type: 'SSH_SUSPEND_TERMINATED',
                                    payload: { suspendSessionId, success }
                                };
                                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
                            } catch (error: any) {
                                console.error(`[SSH_SUSPEND_TERMINATE_REQUEST] 终止会话 ${suspendSessionId} 失败:`, error);
                                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'SSH_SUSPEND_TERMINATED_RESP', payload: { suspendSessionId, success: false, error: error.message || '终止会话失败' } }));
                            }
                            break;
                        }
                        case 'SSH_SUSPEND_REMOVE_ENTRY': {
                            const { suspendSessionId } = payload as SshSuspendRemoveEntryRequest['payload'];
                            console.log(`[WebSocket Handler] Received SSH_SUSPEND_REMOVE_ENTRY. UserID: ${ws.userId}, WsSessionID: ${ws.sessionId}, SuspendSessionID: ${suspendSessionId}`);
                            if (!ws.userId) {
                                console.error(`[SSH_SUSPEND_REMOVE_ENTRY] 用户 ID 未定义。Payload: ${JSON.stringify(payload)}`);
                                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'SSH_SUSPEND_ENTRY_REMOVED_RESP', payload: { suspendSessionId, success: false, error: '用户认证失败' } }));
                                break;
                            }
                            try {
                                const success = await sshSuspendService.removeDisconnectedSessionEntry(ws.userId, suspendSessionId);
                                const response: SshSuspendEntryRemovedResponse = {
                                    type: 'SSH_SUSPEND_ENTRY_REMOVED',
                                    payload: { suspendSessionId, success }
                                };
                                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
                            } catch (error: any) {
                                console.error(`[SSH_SUSPEND_REMOVE_ENTRY] 移除条目 ${suspendSessionId} 失败:`, error);
                                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'SSH_SUSPEND_ENTRY_REMOVED_RESP', payload: { suspendSessionId, success: false, error: error.message || '移除条目失败' } }));
                            }
                            break;
                        }
                        // SSH_SUSPEND_EDIT_NAME case removed, handled by HTTP API now
                        case 'SSH_MARK_FOR_SUSPEND': {
                            const markPayload = payload as SshMarkForSuspendRequest['payload'];
                            const sessionToMarkId = markPayload.sessionId;
                            const initialBuffer = markPayload.initialBuffer; // +++ 获取 initialBuffer +++
                            console.log(`[WebSocket Handler] Received SSH_MARK_FOR_SUSPEND. UserID: ${ws.userId}, TargetSessionID: ${sessionToMarkId}, InitialBuffer provided: ${!!initialBuffer}`);

                            if (!ws.userId) {
                                console.error(`[SSH_MARK_FOR_SUSPEND] 用户 ID 未定义。`);
                                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'SSH_MARKED_FOR_SUSPEND_ACK', payload: { sessionId: sessionToMarkId, success: false, error: '用户认证失败' } as SshMarkedForSuspendAck['payload'] }));
                                break;
                            }

                            // 优先使用传入的 sessionToMarkId，若找不到则尝试使用当前连接绑定的 ws.sessionId 兜底
                            let actualSessionId = sessionToMarkId;
                            let activeSessionState = clientStates.get(actualSessionId);
                            if ((!activeSessionState || !activeSessionState.sshClient || !activeSessionState.sshShellStream) && ws.sessionId) {
                                const fallbackState = clientStates.get(ws.sessionId);
                                if (fallbackState && fallbackState.sshClient && fallbackState.sshShellStream) {
                                    console.log(`[SSH_MARK_FOR_SUSPEND] 传入的 ${sessionToMarkId} 未匹配到活动状态，自动回退到当前连接绑定的会话: ${ws.sessionId}`);
                                    actualSessionId = ws.sessionId;
                                    activeSessionState = fallbackState;
                                }
                            }

                            if (!activeSessionState || !activeSessionState.sshClient || !activeSessionState.sshShellStream) {
                                console.error(`[SSH_MARK_FOR_SUSPEND] 找不到活动的SSH会话或其组件: ${sessionToMarkId}`);
                                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'SSH_MARKED_FOR_SUSPEND_ACK', payload: { sessionId: sessionToMarkId, success: false, error: '未找到要标记的活动SSH会话' } as SshMarkedForSuspendAck['payload'] }));
                                break;
                            }

                            if (activeSessionState.isMarkedForSuspend) {
                                console.warn(`[SSH_MARK_FOR_SUSPEND] 会话 ${actualSessionId} 已被标记。`);
                                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'SSH_MARKED_FOR_SUSPEND_ACK', payload: { sessionId: sessionToMarkId, success: true, error: '会话已被标记' } as SshMarkedForSuspendAck['payload'] }));
                                break;
                            }

                            try {
                                // 使用活动会话ID作为日志文件名的一部分
                                const logPathSuffix = actualSessionId; // 使用确定的 sessionId 作为日志文件名
                                activeSessionState.isMarkedForSuspend = true;
                                activeSessionState.suspendLogPath = logPathSuffix; // 存储日志标识符 (服务内部会拼接完整路径)
                                
                                // 确保日志目录存在 (服务内部通常会做，但这里也可以调用一次)
                                await temporaryLogStorageService.ensureLogDirectoryExists();

                                // +++ 如果有 initialBuffer，先写入它 +++
                                if (initialBuffer) {
                                    // 确保换行符采用标准 CRLF (\r\n)，避免阶梯效应
                                    const normalizedBuffer = initialBuffer.replace(/\r?\n/g, '\r\n');
                                    const formattedInitialBuffer = normalizedBuffer.endsWith('\r\n') ? normalizedBuffer : `${normalizedBuffer}\r\n`;
                                    await temporaryLogStorageService.writeToLog(logPathSuffix, formattedInitialBuffer);
                                    console.log(`[SSH_MARK_FOR_SUSPEND] 已将初始缓冲区写入日志 (会话: ${sessionToMarkId})。`);
                                }
                                // --- 移除自动添加的日志标记行 ---
                                // await temporaryLogStorageService.writeToLog(logPathSuffix, `--- Log recording continued for session ${sessionToMarkId} at ${new Date().toISOString()} ---\n`);

                                console.log(`[SSH_MARK_FOR_SUSPEND] 会话 ${sessionToMarkId} 已成功标记待挂起。日志将记录到与 ${logPathSuffix} 关联的文件。`);
                                const response: SshMarkedForSuspendAck = {
                                    type: 'SSH_MARKED_FOR_SUSPEND_ACK',
                                    payload: { sessionId: sessionToMarkId, success: true }
                                };
                                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
                            } catch (error: any) {
                                console.error(`[SSH_MARK_FOR_SUSPEND] 标记会话 ${sessionToMarkId} 失败:`, error);
                                if (activeSessionState) { // 如果状态存在，尝试回滚标记
                                    activeSessionState.isMarkedForSuspend = false;
                                    activeSessionState.suspendLogPath = undefined;
                                }
                                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'SSH_MARKED_FOR_SUSPEND_ACK', payload: { sessionId: sessionToMarkId, success: false, error: error.message || '标记会话失败' } as SshMarkedForSuspendAck['payload'] }));
                            }
                            break;
                        }
                        /**
                         * 立即挂起（关闭标签时的默认动作）
                         *
                         * 与 SSH_MARK_FOR_SUSPEND 的区别：那个只打标记，真正的移交要等 ws 断开；
                         * 而 ws 断开一旦被判定为「显式关闭」（1000），标记会被清掉、SSH 直接被杀。
                         * 这里当场把 SSH 移交给挂起池，然后把 state 上的引用摘掉，
                         * 之后前端怎么关 ws 都碰不到这条连接了。
                         */
                        case 'SSH_SUSPEND_NOW': {
                            const nowPayload = payload as { sessionId?: string; initialBuffer?: string };
                            const requestedSessionId = nowPayload.sessionId;
                            const initialBuffer = nowPayload.initialBuffer;
                            const replySuspendNow = (ok: boolean, extra: Record<string, any> = {}) => {
                                if (ws.readyState === WebSocket.OPEN) {
                                    ws.send(JSON.stringify({
                                        type: 'SSH_SUSPEND_NOW_ACK',
                                        // 回传前端传进来的 id，前端靠它兑现等待的 Promise
                                        payload: { sessionId: requestedSessionId, success: ok, ...extra },
                                    }));
                                }
                            };

                            console.log(`[SSH_SUSPEND_NOW] UserID: ${ws.userId}, TargetSessionID: ${requestedSessionId}, InitialBuffer: ${!!initialBuffer}`);

                            if (!ws.userId) {
                                replySuspendNow(false, { error: '用户认证失败' });
                                break;
                            }

                            let actualSessionId = requestedSessionId || ws.sessionId || '';
                            let stateForSuspend = clientStates.get(actualSessionId);
                            if ((!stateForSuspend || !stateForSuspend.sshClient || !stateForSuspend.sshShellStream) && ws.sessionId) {
                                const fallbackState = clientStates.get(ws.sessionId);
                                if (fallbackState && fallbackState.sshClient && fallbackState.sshShellStream) {
                                    actualSessionId = ws.sessionId;
                                    stateForSuspend = fallbackState;
                                }
                            }

                            if (!stateForSuspend || !stateForSuspend.sshClient || !stateForSuspend.sshShellStream) {
                                replySuspendNow(false, { error: '未找到可挂起的活动 SSH 会话' });
                                break;
                            }

                            try {
                                const logIdentifier = stateForSuspend.suspendLogPath || actualSessionId;
                                await temporaryLogStorageService.ensureLogDirectoryExists();
                                // 先把前端带过来的完整 scrollback 或后端 Headless VT 纯净序列化状态落地，挂起期间的新输出由 service 追加
                                let normalizedInitialForSeed: string | undefined = undefined;
                                if (initialBuffer) {
                                    const normalized = initialBuffer.replace(/\r?\n/g, '\r\n');
                                    normalizedInitialForSeed = normalized.endsWith('\r\n') ? normalized : `${normalized}\r\n`;
                                    await temporaryLogStorageService.overwriteLog(logIdentifier, normalizedInitialForSeed);
                                } else if (stateForSuspend.terminalEmulator?.hasAnyOutput()) {
                                    const serialized = await stateForSuspend.terminalEmulator.serialize();
                                    if (serialized) {
                                        await temporaryLogStorageService.overwriteLog(logIdentifier, serialized);
                                    }
                                } else if (stateForSuspend.recentOutputBuffer?.length) {
                                    const fallbackBuffer = stateForSuspend.recentOutputBuffer.join('');
                                    if (fallbackBuffer) {
                                        await temporaryLogStorageService.overwriteLog(
                                            logIdentifier,
                                            fallbackBuffer.replace(/\r?\n/g, '\r\n')
                                        );
                                    }
                                }

                                const sshClientToPass = stateForSuspend.sshClient;
                                const channelToPass = stateForSuspend.sshShellStream;
                                const paneStreamsToPass = stateForSuspend.paneStreams;
                                const emulatorToPass = stateForSuspend.terminalEmulator;

                                // 先摘引用再交接：交接失败要能原样放回去
                                try { stateForSuspend.outputCoalescer?.dispose(true); } catch {}
                                stateForSuspend.outputCoalescer = undefined;
                                stateForSuspend.sshClient = undefined as any;
                                stateForSuspend.sshShellStream = undefined;
                                stateForSuspend.paneStreams = undefined;
                                stateForSuspend.terminalEmulator = undefined;
                                stateForSuspend.isSuspendedByService = true;
                                stateForSuspend.isMarkedForSuspend = false;
                                stateForSuspend.suspendLogPath = logIdentifier;

                                const newSuspendId = await sshSuspendService.takeOverMarkedSession({
                                    userId: ws.userId,
                                    originalSessionId: actualSessionId,
                                    sshClient: sshClientToPass,
                                    channel: channelToPass,
                                    connectionName: stateForSuspend.connectionName || '未知连接',
                                    connectionId: String(stateForSuspend.dbConnectionId),
                                    logIdentifier,
                                    // 仅在 VT 为空时作为种子灌入，不重复塞进内存 delta 缓冲
                                    initialBuffer: emulatorToPass?.hasAnyOutput() ? undefined : normalizedInitialForSeed,
                                    utf8Decoder: stateForSuspend.outDecoder,
                                    terminalEmulator: emulatorToPass,
                                    paneStreams: paneStreamsToPass,
                                    // 打上「手动挂起」标记：这是用户主动关的标签，
                                    // 工作区恢复流程必须跳过它，只能由用户去挂起面板手动恢复。
                                    manuallySuspended: true,
                                });

                                if (!newSuspendId) {
                                    stateForSuspend.sshClient = sshClientToPass;
                                    stateForSuspend.sshShellStream = channelToPass;
                                    stateForSuspend.paneStreams = paneStreamsToPass;
                                    if (emulatorToPass && !emulatorToPass.isDisposed()) {
                                        stateForSuspend.terminalEmulator = emulatorToPass;
                                    }
                                    stateForSuspend.isSuspendedByService = false;
                                    replySuspendNow(false, { error: '挂起失败：SSH 通道已不可用' });
                                    break;
                                }

                                console.log(`[SSH_SUSPEND_NOW] 会话 ${actualSessionId} 已转入挂起池，挂起 ID: ${newSuspendId}`);
                                replySuspendNow(true, { suspendSessionId: newSuspendId });
                            } catch (err: any) {
                                console.error(`[SSH_SUSPEND_NOW] 会话 ${actualSessionId} 挂起失败:`, err);
                                replySuspendNow(false, { error: err?.message || '挂起失败' });
                            }
                            break;
                        }
                        case 'SSH_UNMARK_FOR_SUSPEND': {
                            const unmarkPayload = payload as SshUnmarkForSuspendRequest['payload'];
                            const sessionToUnmarkId = unmarkPayload.sessionId;
                            console.log(`[WebSocket Handler] Received SSH_UNMARK_FOR_SUSPEND. UserID: ${ws.userId}, TargetSessionID: ${sessionToUnmarkId}`);
                            const ackPayloadBase = { sessionId: sessionToUnmarkId };

                            if (!ws.userId) {
                                console.error(`[SSH_UNMARK_FOR_SUSPEND] 用户 ID 未定义。`);
                                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'SSH_UNMARKED_FOR_SUSPEND_ACK', payload: { ...ackPayloadBase, success: false, error: '用户认证失败' } as SshUnmarkedForSuspendAck['payload'] }));
                                break;
                            }

                            let actualSessionId = sessionToUnmarkId;
                            let activeSessionState = clientStates.get(actualSessionId);
                            if (!activeSessionState && ws.sessionId) {
                                const fallbackState = clientStates.get(ws.sessionId);
                                if (fallbackState) {
                                    console.log(`[SSH_UNMARK_FOR_SUSPEND] 传入的 ${sessionToUnmarkId} 未匹配到活动状态，自动回退到当前连接绑定的会话: ${ws.sessionId}`);
                                    actualSessionId = ws.sessionId;
                                    activeSessionState = fallbackState;
                                }
                            }

                            if (!activeSessionState) {
                                console.warn(`[SSH_UNMARK_FOR_SUSPEND] 未找到会话: ${sessionToUnmarkId}`);
                                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'SSH_UNMARKED_FOR_SUSPEND_ACK', payload: { ...ackPayloadBase, success: false, error: '未找到要取消标记的会话' } as SshUnmarkedForSuspendAck['payload'] }));
                                break;
                            }

                            if (!activeSessionState.isMarkedForSuspend) {
                                console.warn(`[SSH_UNMARK_FOR_SUSPEND] 会话 ${actualSessionId} 并未被标记为待挂起。`);
                                // 即使未标记，也回复成功，因为最终状态是“未标记”
                                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'SSH_UNMARKED_FOR_SUSPEND_ACK', payload: { ...ackPayloadBase, success: true, error: '会话本就未标记' } as SshUnmarkedForSuspendAck['payload'] }));
                                break;
                            }

                            try {
                                activeSessionState.isMarkedForSuspend = false;
                                const logPathToDelete = activeSessionState.suspendLogPath;
                                activeSessionState.suspendLogPath = undefined; // 清除日志路径

                                if (logPathToDelete) {
                                    await temporaryLogStorageService.deleteLog(logPathToDelete);
                                    console.log(`[SSH_UNMARK_FOR_SUSPEND] 已删除会话 ${sessionToUnmarkId} 的临时挂起日志: ${logPathToDelete}`);
                                }

                                console.log(`[SSH_UNMARK_FOR_SUSPEND] 会话 ${sessionToUnmarkId} 已成功取消标记。`);
                                const response: SshUnmarkedForSuspendAck = {
                                    type: 'SSH_UNMARKED_FOR_SUSPEND_ACK',
                                    payload: { ...ackPayloadBase, success: true }
                                };
                                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
                            } catch (error: any) {
                                console.error(`[SSH_UNMARK_FOR_SUSPEND] 取消标记会话 ${sessionToUnmarkId} 失败:`, error);
                                // 尝试回滚状态（尽管可能意义不大，因为错误可能在删除日志时发生）
                                if (activeSessionState) {
                                     activeSessionState.isMarkedForSuspend = true; // 保持标记状态
                                     // activeSessionState.suspendLogPath = logPathToDelete; // 如果需要，可以恢复路径，但删除失败更可能是问题
                                }
                                 if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'SSH_UNMARKED_FOR_SUSPEND_ACK', payload: { ...ackPayloadBase, success: false, error: error.message || '取消标记会话失败' } as SshUnmarkedForSuspendAck['payload'] }));
                            }
                            break;
                        }

                        // Workspace Sync Cases
                        case 'workspace:bind_client': {
                            const uId = ws.userId || 1;
                            if (payload && payload.clientId) {
                                workspaceSyncService.bindSocketClientId(uId, ws, payload.clientId);
                                if (ws.readyState === WebSocket.OPEN) {
                                    ws.send(JSON.stringify({ type: 'workspace:bound_ack', payload: { clientId: payload.clientId } }));
                                }
                            }
                            break;
                        }
                        case 'workspace:claim_lease': {
                            const uId = ws.userId || 1;
                            if (payload && payload.clientId) {
                                await workspaceSyncService.claimLease(uId, payload.clientId);
                                if (ws.readyState === WebSocket.OPEN) {
                                    ws.send(JSON.stringify({ type: 'workspace:claim_ack', payload: { activeClientId: payload.clientId } }));
                                }
                            }
                            break;
                        }
                        case 'workspace:save_state': {
                            const uId = ws.userId || 1;
                            if (payload && payload.clientId && payload.state) {
                                // 租约校验：非持有者的写入会被服务端拒绝，这里把结果回给调用方
                                const saved = await workspaceSyncService.saveState(uId, payload.clientId, payload.state);
                                if (ws.readyState === WebSocket.OPEN) {
                                    ws.send(JSON.stringify({
                                        type: 'workspace:save_ack',
                                        payload: { success: true, accepted: saved.accepted, activeClientId: saved.activeClientId }
                                    }));
                                }
                            }
                            break;
                        }

                        default:
                            console.warn(`WebSocket：收到来自 ${ws.username} (会话: ${sessionId}) 的未知消息类型: ${type}`);
                            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', payload: `不支持的消息类型: ${type}` }));
                    }
                } catch (error: any) {
                    console.error(`WebSocket: 处理来自 ${ws.username} (会话: ${sessionId}) 的消息 (${type}) 时发生顶层错误:`, error);
                    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', payload: `处理消息时发生内部错误: ${error.message}` }));
                }
            });

            ws.on('close', (code, reason) => {
                const reasonStr = reason ? reason.toString() : '';
                console.log(`WebSocket：客户端 ${ws.username} (会话: ${ws.sessionId}) 已断开连接。代码: ${code}, 原因: ${reasonStr}`);
                if (code === 1000 || reasonStr.includes('关闭') || reasonStr.includes('主动') || reasonStr.includes('manual')) {
                    if (ws.sessionId) {
                        const existing = clientStates.get(ws.sessionId);
                        // 仅当该状态仍属于当前 ws 时才标记显式关闭，避免旧 ws 关闭污染新 ws 会话
                        if (existing && existing.ws === ws) {
                            existing.isExplicitlyClosed = true;
                            existing.isMarkedForSuspend = false;
                        }
                    }
                }
                workspaceSyncService.unregisterSocket(ws.userId || 1, ws);
                cleanupClientConnection(ws.sessionId, ws);
            });

            ws.on('error', (error) => {
                console.error(`WebSocket：客户端 ${ws.username} (会话: ${ws.sessionId}) 发生错误:`, error);
                workspaceSyncService.unregisterSocket(ws.userId || 1, ws);
                cleanupClientConnection(ws.sessionId, ws); // Ensure cleanup on error too
            });
        }
    });

    // 监听 SshSuspendService 发出的会话自动终止事件
    sshSuspendService.on('sessionAutoTerminated', (eventPayload: { userId: number; suspendSessionId: string; reason: string }) => {
        const { userId, suspendSessionId, reason } = eventPayload;
        console.log(`[WebSocket 通知] 准备发送 SSH_SUSPEND_AUTO_TERMINATED_NOTIF 给用户 ${userId} 的会话 ${suspendSessionId}`);

        wss.clients.forEach(client => {
            const wsClient = client as AuthenticatedWebSocket; // 类型断言
            if (wsClient.userId === userId && wsClient.readyState === WebSocket.OPEN) {
                const notification: SshSuspendAutoTerminatedNotification = {
                    type: 'SSH_SUSPEND_AUTO_TERMINATED',
                    payload: {
                        suspendSessionId,
                        reason
                    }
                };
                wsClient.send(JSON.stringify(notification));
                console.log(`[WebSocket 通知] 已发送 SSH_SUSPEND_AUTO_TERMINATED_NOTIF 给用户 ${userId} 的一个 WebSocket 连接 (会话 ${suspendSessionId})。`);
            }
        });
    });

    console.log('WebSocket connection handler initialized, including SshSuspendService event listener.');
}