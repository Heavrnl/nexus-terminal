import WebSocket, { WebSocketServer, RawData } from 'ws';
import { Request } from 'express';
import {
    AuthenticatedWebSocket,
    SshSuspendStartRequest,
    SshSuspendListRequest,
    SshSuspendResumeRequest,
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
import { cleanupClientConnection } from './utils';
import { clientStates } from './state';
import { temporaryLogStorageService } from '../ssh-suspend/temporary-log-storage.service'; 

// Handlers
import { handleRdpProxyConnection } from './handlers/rdp.handler';
import {
    handleSshConnect,
    handleSshInput,
    handleSshResize,
    handleSshResumeSuccess
} from './handlers/ssh.handler';
import {
    handleDockerGetStatus,
    handleDockerCommand,
    handleDockerGetStats
} from './handlers/docker.handler';
import {
    handleSftpOperation,
    handleSftpUploadStart,
    handleSftpUploadChunk,
    handleSftpUploadCancel
} from './handlers/sftp.handler';

export function initializeConnectionHandler(wss: WebSocketServer, sshSuspendService: SshSuspendService, sftpService: SftpService): void { // +++ Add sftpService parameter +++
    wss.on('connection', (ws: AuthenticatedWebSocket, request: Request) => {
        ws.isAlive = true;
        const isRdpProxy = (request as any).isRdpProxy;
        const clientIp = (request as any).clientIpAddress || 'unknown'; // Preserved from upgrade handler

        console.log(`WebSocket：客户端 ${ws.username} (ID: ${ws.userId}, IP: ${clientIp}, RDP Proxy: ${isRdpProxy}) 已连接。`);

        ws.on('pong', () => { ws.isAlive = true; });

        if (isRdpProxy) {
            handleRdpProxyConnection(ws, request);
        } else {
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

                const { type, payload, requestId } = parsedMessage;
                const sessionId = ws.sessionId; // Get current WebSocket's session ID

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
                                // console.log(`[WebSocket Handler][${type}] 调用 sshSuspendService.resumeSession (userId: ${ws.userId}, suspendSessionId: ${suspendSessionId})`);
                                const result = await sshSuspendService.resumeSession(ws.userId, suspendSessionId);
                                // console.log(`[WebSocket Handler][${type}] sshSuspendService.resumeSession 返回: ${result ? `包含 sshClient: ${!!result.sshClient}, channel: ${!!result.channel}, logData长度: ${result.logData?.length}` : 'null'}`);

                                if (result) {
                                    // console.log(`[WebSocket Handler][${type}] 成功恢复会话。准备设置新的 ClientState (ID: ${newFrontendSessionId})。`);
                                    const newSessionState: ClientState = {
                                        ws, // 当前的 WebSocket 连接
                                        sshClient: result.sshClient,
                                        sshShellStream: result.channel,
                                        dbConnectionId: parseInt(result.originalConnectionId, 10), // 从结果中恢复并转换为数字
                                        connectionName: result.connectionName, // 从结果中恢复
                                        ipAddress: clientIp,
                                        isShellReady: true, // 假设恢复后 Shell 立即可用
                                    };
                                    clientStates.set(newFrontendSessionId, newSessionState);
                                    ws.sessionId = newFrontendSessionId; // 将当前 ws 与新会话关联
                                    // console.log(`[WebSocket Handler][${type}] 新 ClientState (ID: ${newFrontendSessionId}) 已设置并关联到当前 WebSocket。`);

                                    // +++ 为恢复的会话初始化 SFTP +++
                                    // console.log(`[WebSocket Handler][${type}] 尝试为恢复的会话 ${newFrontendSessionId} 初始化 SFTP。`);
                                    sftpService.initializeSftpSession(newFrontendSessionId)
                                        .then(() => {
                                            // console.log(`[WebSocket Handler][${type}] SFTP 初始化调用完成 (可能异步) for ${newFrontendSessionId}。`);
                                            // sftp_ready 消息会由 sftpService 内部发送
                                        })
                                        .catch(sftpInitErr => {
                                            console.error(`[WebSocket Handler][${type}] 为恢复的会话 ${newFrontendSessionId} 初始化 SFTP 失败:`, sftpInitErr);
                                            // 即使 SFTP 初始化失败，SSH 会话仍然恢复
                                        });
                                    // +++ 结束 SFTP 初始化 +++

                                    // 重新设置事件监听器，将数据流导向新的前端会话
                                    result.channel.removeAllListeners('data'); // 清除 SshSuspendService 可能设置的监听器
                                    result.channel.on('data', (data: Buffer) => {
                                        if (ws.readyState === WebSocket.OPEN) {
                                            // console.debug(`[WebSocket Handler][${type}] 发送 ssh:output for ${newFrontendSessionId}`);
                                            // 保持与 ssh.handler.ts 中 ssh:output 格式一致
                                            ws.send(JSON.stringify({ type: 'ssh:output', payload: data.toString('base64'), encoding: 'base64' }));
                                        }
                                    });
                                    result.channel.on('close', () => {
                                        console.log(`[WebSocket Handler][${type}] 恢复的会话 ${newFrontendSessionId} 的 channel 已关闭。`);
                                        if (ws.readyState === WebSocket.OPEN) {
                                            ws.send(JSON.stringify({ type: 'ssh:disconnected', payload: { sessionId: newFrontendSessionId } }));
                                        }
                                        cleanupClientConnection(newFrontendSessionId);
                                    });
                                     result.sshClient.on('error', (err: Error) => {
                                        console.error(`[WebSocket Handler][${type}] 恢复后的 SSH 客户端错误 (会话: ${newFrontendSessionId}):`, err);
                                        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ssh:error', payload: { sessionId: newFrontendSessionId, error: err.message } }));
                                        cleanupClientConnection(newFrontendSessionId);
                                    });
                                    // console.log(`[WebSocket Handler][${type}] 已为恢复的会话 ${newFrontendSessionId} 设置事件监听器。`);

                                    // 发送缓存日志块
                                    console.log('[SSH Suspend Backend] Log data to send to frontend:', result.logData);
                                    const normalizedLogData = (result.logData || '').replace(/\r?\n/g, '\r\n');
                                    const logChunkResponse: SshOutputCachedChunk = {
                                        type: 'SSH_OUTPUT_CACHED_CHUNK',
                                        payload: { frontendSessionId: newFrontendSessionId, data: normalizedLogData, isLastChunk: true }
                                    };
                                    if (ws.readyState === WebSocket.OPEN) {
                                        ws.send(JSON.stringify(logChunkResponse));
                                        // console.log(`[WebSocket Handler][${type}] 已发送 SSH_OUTPUT_CACHED_CHUNK 给 ${newFrontendSessionId} (数据长度: ${result.logData.length})。`);
                                    } else {
                                        // console.warn(`[WebSocket Handler][${type}] WebSocket 在发送 SSH_OUTPUT_CACHED_CHUNK 前已关闭 (会话 ${newFrontendSessionId})。`);
                                    }

                                    // +++ 发送 ssh:connected 消息 +++
                                    if (ws.readyState === WebSocket.OPEN) {
                                        ws.send(JSON.stringify({
                                            type: 'ssh:connected',
                                            payload: {
                                                connectionId: newSessionState.dbConnectionId, // 使用已恢复的 dbConnectionId
                                                sessionId: newFrontendSessionId // 使用新的前端会话 ID
                                            }
                                        }));
                                        console.log(`[WebSocket Handler][SSH_SUSPEND_RESUME_REQUEST] 已发送 ssh:connected 给 ${newFrontendSessionId}。`);
                                    }
                                
                                    
                                    const responseNotification: SshSuspendResumedNotification = { // 确保变量名不冲突且类型正确
                                        type: 'SSH_SUSPEND_RESUMED_NOTIF', // 改回与前端和新类型定义一致
                                        payload: { suspendSessionId, newFrontendSessionId, success: true }
                                    };
                                    if (ws.readyState === WebSocket.OPEN) {
                                        ws.send(JSON.stringify(responseNotification));
                                        // console.log(`[WebSocket Handler][${type}] 已发送 SSH_SUSPEND_RESUMED_NOTIF 给 ${newFrontendSessionId}。`);
                                    } else {
                                        // console.warn(`[WebSocket Handler][${type}] WebSocket 在发送 SSH_SUSPEND_RESUMED_NOTIF 前已关闭 (会话 ${newFrontendSessionId})。`);
                                    }

                                    // 在成功恢复并通知前端后，调用 handleSshResumeSuccess 启动状态监控
                                    handleSshResumeSuccess(newFrontendSessionId);

                                } else {
                                    // console.warn(`[WebSocket Handler][${type}] sshSuspendService.resumeSession 返回 null，无法恢复会话 ${suspendSessionId}。`);
                                    throw new Error('服务未能恢复会话，或会话不存在/状态不正确。');
                                }
                            } catch (error: any) {
                                // console.error(`[WebSocket Handler][${type}] 处理恢复会话 ${suspendSessionId} 时发生错误:`, error);
                                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'SSH_SUSPEND_RESUMED_NOTIF', payload: { suspendSessionId, newFrontendSessionId, success: false, error: error.message || '恢复会话失败' } }));
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
                console.log(`WebSocket：客户端 ${ws.username} (会话: ${ws.sessionId}) 已断开连接。代码: ${code}, 原因: ${reason.toString()}`);
                cleanupClientConnection(ws.sessionId);
            });

            ws.on('error', (error) => {
                console.error(`WebSocket：客户端 ${ws.username} (会话: ${ws.sessionId}) 发生错误:`, error);
                cleanupClientConnection(ws.sessionId); // Ensure cleanup on error too
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