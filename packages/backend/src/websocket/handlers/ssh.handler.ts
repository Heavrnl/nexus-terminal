import { Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { StringDecoder } from 'node:string_decoder';
import { AuthenticatedWebSocket, ClientState } from '../types';
import { clientStates, sftpService, statusMonitorService, auditLogService, notificationService } from '../state';
import * as SshService from '../../services/ssh.service';
import { appendRingBuffer, cleanupClientConnection } from '../utils';
import { temporaryLogStorageService } from '../../ssh-suspend/temporary-log-storage.service';
import { startDockerStatusPolling } from './docker.handler';
import WebSocket from 'ws';

export async function handleSshConnect(
    ws: AuthenticatedWebSocket,
    request: Request,
    payload: any
): Promise<void> {
    const sessionId = ws.sessionId;
    const existingState = sessionId ? clientStates.get(sessionId) : undefined;

    if (sessionId && existingState) {
        console.warn(`WebSocket: 用户 ${ws.username} (会话: ${sessionId}) 已有活动连接，忽略新的连接请求。`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ssh:error', payload: '已存在活动的 SSH 连接。' }));
        return;
    }

    const dbConnectionId = payload?.connectionId;
    if (!dbConnectionId) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ssh:error', payload: '缺少 connectionId。' }));
        return;
    }

    console.log(`WebSocket: 用户 ${ws.username} 请求连接到数据库 ID: ${dbConnectionId}`);
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ssh:status', payload: '正在处理连接请求...' }));

    const clientIp = (request as any).clientIpAddress || 'unknown';
    let connInfo: SshService.DecryptedConnectionDetails | null = null;

    // 优先复用客户端提供的 sessionId，保证同一终端会话重连时标识一致不销毁前端实例
    const newSessionId = (typeof payload?.sessionId === 'string' && payload.sessionId.trim().length > 0)
        ? payload.sessionId.trim()
        : (ws.sessionId || uuidv4());

    // 若当前服务中仍残留该会话的历史状态（例如网络断开未触发 close），安全等待旧连接清理完毕再注册新状态
    if (clientStates.has(newSessionId)) {
        console.log(`[SSH Handler] 检测到会话 ${newSessionId} 已存在旧状态，执行重连前置清理...`);
        await cleanupClientConnection(newSessionId);
    }

    ws.sessionId = newSessionId; // 立即为 WebSocket 绑定当前确定好的 sessionId

    const dbConnectionIdAsNumber = parseInt(dbConnectionId, 10);
    if (isNaN(dbConnectionIdAsNumber)) {
        console.error(`WebSocket: 无效的 dbConnectionId '${dbConnectionId}' (非数字)，无法创建会话 ${newSessionId}。`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ssh:error', payload: '无效的连接 ID。' }));
        ws.close(1008, 'Invalid Connection ID');
        return;
    }

    // 立即注册初始 ClientState 占位对象，保证在 SSH 网络握手期间到达的分屏打开请求能够进入暂存队列排队，绝不丢失！
    const newState: ClientState = {
        ws: ws,
        sshClient: undefined as any,
        dbConnectionId: dbConnectionIdAsNumber,
        connectionName: 'Connecting...',
        ipAddress: clientIp,
        isShellReady: false,
        // 无终端会话：前端文件管理器绑定主机时开的私有通道，接管工作区时不参与挂起移交
        isHeadless: payload?.headless === true,
        recentOutputBuffer: [],
        recentOutputBytes: 0,
        pendingPaneOpens: new Map(),
        paneStreams: new Map(),
    };
    clientStates.set(newSessionId, newState);
    console.log(`WebSocket: 为用户 ${ws.username} (IP: ${clientIp}) 预注册会话 ${newSessionId} (DB ID: ${dbConnectionIdAsNumber}) 状态队列。`);

    try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ssh:status', payload: '正在获取连接信息...' }));
        connInfo = await SshService.getConnectionDetails(dbConnectionId);
        newState.connectionName = connInfo!.name;

        const sshClient = await SshService.establishSshConnection(connInfo);
        newState.sshClient = sshClient;

        console.log(`WebSocket: 为用户 ${ws.username} 建立 SSH 传输通道成功 (会话: ${newSessionId}, 连接名称: ${newState.connectionName})`);

        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ssh:status', payload: 'SSH 连接成功，正在打开 Shell...' }));
        try {
            const defaultCols = payload?.cols || 80; // Use provided cols or default
            const defaultRows = payload?.rows || 24; // Use provided rows or default
            sshClient.shell({ term: payload?.term || 'xterm-256color', cols: defaultCols, rows: defaultRows }, (err, stream) => {
                if (err) {
                    console.error(`SSH: 会话 ${newSessionId} 打开 Shell 失败:`, err);
                    auditLogService.logAction('SSH_SHELL_FAILURE', {
                        connectionName: newState.connectionName,
                        userId: ws.userId,
                        username: ws.username,
                        connectionId: dbConnectionIdAsNumber,
                        sessionId: newSessionId,
                        ip: newState.ipAddress,
                        reason: err.message
                    });
                    notificationService.sendNotification('SSH_SHELL_FAILURE', {
                        userId: ws.userId,
                        username: ws.username,
                        connectionId: dbConnectionIdAsNumber,
                        sessionId: newSessionId,
                        ip: newState.ipAddress,
                        reason: err.message
                    });
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'ssh:error', payload: `打开 Shell 失败: ${err.message}` }));
                    }
                    cleanupClientConnection(newSessionId);
                    return;
                }

                newState.sshShellStream = stream;
                newState.isShellReady = true;

                // 如果在 Shell 打开前已收到前端的调整尺寸请求，立即应用
                if (newState.pendingDimensions) {
                    console.log(`WebSocket: 会话 ${newSessionId} 应用就绪前暂存的终端尺寸: ${newState.pendingDimensions.cols}x${newState.pendingDimensions.rows}`);
                    stream.setWindow(newState.pendingDimensions.rows, newState.pendingDimensions.cols, 0, 0);
                    delete newState.pendingDimensions;
                }

                // ⚠️ 输出必须按**原始字节**转发（base64）。
                // 以前这里是 `data.toString('utf8')` 再转回 base64：PTY 的分块边界
                // 会随机把一个中文字符 / emoji 切成两半，逐块 toString 就会把它变成
                // U+FFFD（"�"），agy 这类中文输出多的 CLI 尤其明显。
                // 日志与环形缓冲需要文本，交给 StringDecoder 跨块拼接。
                const outDecoder = new StringDecoder('utf8');
                newState.outDecoder = outDecoder;
                stream.on('data', (data: Buffer) => {
                    const utf8Data = outDecoder.write(data);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'ssh:output', payload: data.toString('base64'), encoding: 'base64' }));
                    }

                    const currentState = clientStates.get(newSessionId);
                    if (currentState) {
                        appendRingBuffer(currentState, utf8Data);

                        // 如果会话被标记为待挂起（且不在异步写盘交接窗口内），则同时将输出写入日志
                        if (currentState.isMarkedForSuspend && !currentState.isHandingOverToSuspend && currentState.suspendLogPath) {
                            temporaryLogStorageService.writeToLog(currentState.suspendLogPath, utf8Data).catch(err => {
                                console.error(`[SSH Handler] 写入标记会话 ${newSessionId} 的日志失败 (路径: ${currentState.suspendLogPath}):`, err);
                            });
                        }
                    }
                });
                const errDecoder = new StringDecoder('utf8');
                stream.stderr.on('data', (data: Buffer) => {
                    const utf8ErrData = errDecoder.write(data);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'ssh:output', payload: data.toString('base64'), encoding: 'base64' }));
                    }

                    const currentState = clientStates.get(newSessionId);
                    if (currentState) {
                        appendRingBuffer(currentState, utf8ErrData);

                        if (currentState.isMarkedForSuspend && !currentState.isHandingOverToSuspend && currentState.suspendLogPath) {
                            temporaryLogStorageService.writeToLog(currentState.suspendLogPath, `[STDERR] ${utf8ErrData}`).catch(err => {
                                console.error(`[SSH Handler] 写入标记会话 ${newSessionId} 的 STDERR 日志失败 (路径: ${currentState.suspendLogPath}):`, err);
                            });
                        }
                    }
                });
                stream.on('close', () => {
                    console.log(`SSH: 会话 ${newSessionId} 的 Shell 通道已关闭。`);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'ssh:disconnected', payload: 'Shell 通道已关闭。' }));
                    }
                    cleanupClientConnection(newSessionId, ws);
                });

                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({
                    type: 'ssh:connected',
                    sessionId: newSessionId,
                    payload: {
                        connectionId: dbConnectionIdAsNumber,
                        sessionId: newSessionId
                    }
                }));
                console.log(`WebSocket: 会话 ${newSessionId} SSH 连接和 Shell 建立成功。`);

                // 立即处理在连接建立前暂存的分屏打开请求
                if (newState.pendingPaneOpens && newState.pendingPaneOpens.size > 0) {
                    console.log(`WebSocket: 会话 ${newSessionId} 处理连接就绪前暂存的 ${newState.pendingPaneOpens.size} 个分屏打开请求...`);
                    for (const [pId, pOpts] of newState.pendingPaneOpens.entries()) {
                        openPaneShell(ws, newSessionId, newState, pId, pOpts.cols, pOpts.rows, pOpts.term, pOpts.paneIndex);
                    }
                    newState.pendingPaneOpens.clear();
                }
                auditLogService.logAction('SSH_CONNECT_SUCCESS', {
                    userId: ws.userId,
                    username: ws.username,
                    connectionId: dbConnectionIdAsNumber,
                    sessionId: newSessionId,
                    ip: newState.ipAddress,
                    connectionName: connInfo!.name,
                });
                notificationService.sendNotification('SSH_CONNECT_SUCCESS', {
                    userId: ws.userId,
                    username: ws.username,
                    connectionId: dbConnectionIdAsNumber,
                    sessionId: newSessionId,
                    ip: newState.ipAddress
                });

                console.log(`WebSocket: 会话 ${newSessionId} 正在异步初始化 SFTP...`);
                sftpService.initializeSftpSession(newSessionId)
                    .then(() => console.log(`SFTP: 会话 ${newSessionId} 异步初始化成功。`))
                    .catch(sftpInitError => console.error(`WebSocket: 会话 ${newSessionId} 异步初始化 SFTP 失败:`, sftpInitError));

                statusMonitorService.startStatusPolling(newSessionId);
                startDockerStatusPolling(newSessionId); // Start Docker polling
            });
        } catch (shellError: any) {
            console.error(`SSH: 会话 ${newSessionId} 打开 Shell 时发生意外错误:`, shellError);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ssh:error', payload: `打开 Shell 时发生意外错误: ${shellError.message}` }));
            }
            cleanupClientConnection(newSessionId);
        }

        sshClient.on('close', () => {
            console.log(`SSH: 会话 ${newSessionId} 的客户端连接已关闭。`);
            cleanupClientConnection(newSessionId, ws);
        });
        sshClient.on('error', (err: Error) => {
            console.error(`SSH: 会话 ${newSessionId} 的客户端连接错误:`, err);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ssh:error', payload: `SSH 连接错误: ${err.message}` }));
            }
            cleanupClientConnection(newSessionId, ws);
        });

    } catch (connectError: any) {
        console.error(`WebSocket: 用户 ${ws.username} (IP: ${clientIp}) 连接到数据库 ID ${dbConnectionId} 失败:`, connectError);
        auditLogService.logAction('SSH_CONNECT_FAILURE', {
            userId: ws.userId,
            username: ws.username,
            connectionId: dbConnectionId,
            connectionName: connInfo?.name || 'Unknown',
            ip: clientIp,
            reason: connectError.message
        });
        notificationService.sendNotification('SSH_CONNECT_FAILURE', {
            userId: ws.userId,
            username: ws.username,
            connectionId: dbConnectionId,
            ip: clientIp,
            reason: connectError.message
        });
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ssh:error', payload: `连接失败: ${connectError.message}` }));
        ws.close(1011, `SSH Connection Failed: ${connectError.message}`);
    }
}

export function handleSshInput(ws: AuthenticatedWebSocket, payload: any): void {
    const sessionId = ws.sessionId;
    const state = sessionId ? clientStates.get(sessionId) : undefined;

    if (!state || !state.sshShellStream) {
        console.warn(`WebSocket: 收到来自 ${ws.username} (会话: ${sessionId}) 的 SSH 输入，但无活动 Shell。`);
        return;
    }
    const data = payload?.data;
    if (typeof data === 'string' && state.isShellReady) { // Check isShellReady
        state.sshShellStream.write(data);
    } else if (!state.isShellReady) {
        console.warn(`WebSocket: 会话 ${sessionId} 收到 SSH 输入，但 Shell 尚未就绪。`);
    }
}

export function handleSshResize(ws: AuthenticatedWebSocket, payload: any): void {
    const sessionId = ws.sessionId;
    const state = sessionId ? clientStates.get(sessionId) : undefined;

    if (!state || !state.sshClient) { // sshClient is enough, stream might not be ready for resize yet
        console.warn(`WebSocket: 收到来自 ${ws.username} 的调整大小请求，但无有效会话或 SSH 客户端。`);
        return;
    }

    const { cols, rows } = payload || {};
    if (typeof cols !== 'number' || typeof rows !== 'number' || cols <= 0 || rows <= 0) {
        console.warn(`WebSocket: 收到来自 ${ws.username} (会话: ${sessionId}) 的无效调整大小请求:`, payload);
        return;
    }

    if (state.isShellReady && state.sshShellStream) {
        console.log(`SSH: 会话 ${sessionId} 调整终端大小: ${cols}x${rows}`);
        state.sshShellStream.setWindow(rows, cols, 0, 0);
    } else {
        // 暂存尺寸请求，待 Shell 就绪后立即无缝应用，防止初始终端错位
        console.log(`WebSocket: 会话 ${sessionId} 收到调整大小请求，Shell 尚未就绪，暂存尺寸: ${cols}x${rows}`);
        state.pendingDimensions = { cols, rows };
    }
}

// 处理会话恢复后的状态监控与 Docker 轮询启动
export function handleSshResumeSuccess(sessionId: string): void {
    const state = clientStates.get(sessionId);
    if (state && state.sshClient) {
        statusMonitorService.startStatusPolling(sessionId);
        startDockerStatusPolling(sessionId);
        console.log(`[SSH Handler ${sessionId}] 已为恢复的会话启动系统状态监控与 Docker 状态轮询。`);
    } else {
        console.error(`[SSH Handler ${sessionId}] 无法为恢复的会话启动状态轮询：未找到会话状态或 SSH 客户端。`);
    }
}

// --- 多终端分屏 Shell 通道处理器 ---

export function openPaneShell(
    ws: AuthenticatedWebSocket,
    sessionId: string,
    state: ClientState,
    paneId: string,
    cols: number = 80,
    rows: number = 24,
    term: string = 'xterm-256color',
    paneIndex?: number
): void {
    if (!state.sshClient) {
        console.warn(`[openPaneShell] 会话 ${sessionId} 缺少活动 sshClient，无法为 ${paneId} 打开 Shell`);
        return;
    }
    if (!state.paneStreams) {
        state.paneStreams = new Map();
    }
    const existingPane = state.paneStreams.get(paneId);
    if (existingPane) {
        try { existingPane.stream?.end(); } catch (e) {}
        state.paneStreams.delete(paneId);
    }

    console.log(`SSH: 会话 ${sessionId} 正在为分屏终端 ${paneId} 打开独立 Shell (${cols}x${rows})...`);

    state.sshClient.shell({ term, cols, rows }, (err, stream) => {
        if (err) {
            console.error(`SSH: 会话 ${sessionId} 打开分屏 Shell ${paneId} 失败:`, err);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'ssh:pane_error',
                    sessionId,
                    payload: { paneId, error: err.message }
                }));
            }
            return;
        }

        const paneState = {
            paneId,
            paneIndex,
            stream,
            isReady: true,
        };
        state.paneStreams!.set(paneId, paneState);

        stream.on('data', (data: Buffer) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'ssh:pane_output',
                    sessionId,
                    payload: {
                        paneId,
                        // 原始字节直传，避免分块切断多字节字符（详见主终端的说明）
                        data: data.toString('base64')
                    },
                    encoding: 'base64'
                }));
            }
        });

        stream.stderr.on('data', (data: Buffer) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'ssh:pane_output',
                    sessionId,
                    payload: {
                        paneId,
                        data: data.toString('base64')
                    },
                    encoding: 'base64'
                }));
            }
        });

        stream.on('close', () => {
            console.log(`SSH: 会话 ${sessionId} 的分屏 Shell ${paneId} 已关闭。`);
            state.paneStreams?.delete(paneId);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'ssh:pane_closed',
                    sessionId,
                    payload: { paneId }
                }));
            }
        });

        // 通知前端该分屏终端 Shell 就绪
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'ssh:pane_ready',
                sessionId,
                payload: { paneId }
            }));
        }
        console.log(`SSH: 会话 ${sessionId} 的分屏终端 ${paneId} Shell 建立成功。`);
    });
}

export async function handleSshPaneOpen(ws: AuthenticatedWebSocket, payload: any, incomingSessionId?: string): Promise<void> {
    const sessionId = incomingSessionId || ws.sessionId || payload?.sessionId;
    const paneId = payload?.paneId;

    if (!paneId || typeof paneId !== 'string') {
        console.warn(`WebSocket: 收到来自 ${ws.username} 的无效 paneId 分屏打开请求:`, payload);
        return;
    }

    const state = sessionId ? clientStates.get(sessionId) : undefined;
    const cols = payload?.cols || 80;
    const rows = payload?.rows || 24;
    const term = payload?.term || 'xterm-256color';
    const paneIndex = typeof payload?.paneIndex === 'number' && Number.isInteger(payload.paneIndex)
        ? payload.paneIndex
        : undefined;

    // 情况 A：SSH 已连接就绪，立即派生打开或复用保活通道
    if (state && state.sshClient && state.isShellReady) {
        // 优先按 paneId 精确命中；若刷新/跨端导致 paneId 重编，再按稳定的 paneIndex 复用保活通道并重绑新 paneId
        let matchedKey: string | undefined = state.paneStreams?.has(paneId) ? paneId : undefined;
        let existingPane = matchedKey ? state.paneStreams?.get(matchedKey) : undefined;
        if (!existingPane && paneIndex !== undefined && state.paneStreams) {
            for (const [k, p] of state.paneStreams.entries()) {
                if (p && p.isReady && p.stream && p.paneIndex === paneIndex) {
                    matchedKey = k;
                    existingPane = p;
                    break;
                }
            }
        }
        if (existingPane && existingPane.stream && existingPane.isReady) {
            if (matchedKey && matchedKey !== paneId && state.paneStreams) {
                state.paneStreams.delete(matchedKey);
                existingPane.paneId = paneId;
                state.paneStreams.set(paneId, existingPane);
                console.log(`WebSocket: 会话 ${sessionId} 按 paneIndex=${paneIndex} 复用保活分屏通道并重绑 paneId: ${matchedKey} -> ${paneId}`);
            } else {
                console.log(`WebSocket: 会话 ${sessionId} 的分屏 ${paneId} 存在保活活动 Shell 通道，复用现有通道并重定向数据流`);
            }
            if (paneIndex !== undefined) {
                existingPane.paneIndex = paneIndex;
            }

            existingPane.stream.removeAllListeners('data');
            existingPane.stream.removeAllListeners('close');
            existingPane.stream.removeAllListeners('error');

            existingPane.stream.on('data', (data: Buffer) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'ssh:pane_output',
                        sessionId,
                        payload: {
                            paneId,
                            data: data.toString('base64')
                        },
                        encoding: 'base64'
                    }));
                }
            });

            if (existingPane.stream.stderr) {
                existingPane.stream.stderr.removeAllListeners('data');
                existingPane.stream.stderr.on('data', (data: Buffer) => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'ssh:pane_output',
                            sessionId,
                            payload: {
                                paneId,
                                data: data.toString('base64')
                            },
                            encoding: 'base64'
                        }));
                    }
                });
            }

            existingPane.stream.on('close', () => {
                console.log(`SSH: 会话 ${sessionId} 的分屏 Shell ${paneId} 已关闭。`);
                state.paneStreams?.delete(paneId);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'ssh:pane_closed',
                        sessionId,
                        payload: { paneId }
                    }));
                }
            });

            // 调整终端大小
            if (typeof cols === 'number' && typeof rows === 'number' && cols > 0 && rows > 0) {
                try { existingPane.stream.setWindow(rows, cols, 0, 0); } catch (e) {}
            }

            // 通知前端该分屏终端复用成功、通道就绪
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'ssh:pane_ready',
                    sessionId,
                    payload: { paneId }
                }));
            }
            return;
        }
        openPaneShell(ws, sessionId, state, paneId, cols, rows, term, paneIndex);
    } else if (state) {
        // 情况 B：会话正在握手连接中，暂存打开请求，连接成功发 ssh:connected 后自动消费
        console.log(`WebSocket: 会话 ${sessionId} 收到分屏 ${paneId} 打开请求，SSH 正在握手，加入暂存等待队列...`);
        if (!state.pendingPaneOpens) {
            state.pendingPaneOpens = new Map();
        }
        state.pendingPaneOpens.set(paneId, { cols, rows, term, paneIndex });
    } else {
        console.warn(`WebSocket: 收到分屏打开请求，但未找到对应的活动会话 (sessionId: ${sessionId}, paneId: ${paneId})`);
    }
}

export function handleSshPaneInput(ws: AuthenticatedWebSocket, payload: any, incomingSessionId?: string): void {
    const sessionId = incomingSessionId || ws.sessionId || payload?.sessionId;
    const state = sessionId ? clientStates.get(sessionId) : undefined;
    const paneId = payload?.paneId;
    const data = payload?.data;

    if (!state || !state.paneStreams) {
        console.warn(`WebSocket: 收到分屏输入，但未找到会话或分屏通道 (sessionId: ${sessionId}, paneId: ${paneId})`);
        return;
    }

    const paneState = state.paneStreams.get(paneId);
    if (!paneState || !paneState.stream || !paneState.isReady) {
        console.warn(`WebSocket: 分屏终端 ${paneId} 尚未就绪，忽略输入。`);
        return;
    }

    if (typeof data === 'string') {
        paneState.stream.write(data);
    }
}

export function handleSshPaneResize(ws: AuthenticatedWebSocket, payload: any, incomingSessionId?: string): void {
    const sessionId = incomingSessionId || ws.sessionId || payload?.sessionId;
    const state = sessionId ? clientStates.get(sessionId) : undefined;
    const paneId = payload?.paneId;
    const { cols, rows } = payload || {};

    if (!state || !state.paneStreams) return;

    const paneState = state.paneStreams.get(paneId);
    if (paneState && paneState.stream && paneState.isReady) {
        if (typeof cols === 'number' && typeof rows === 'number' && cols > 0 && rows > 0) {
            paneState.stream.setWindow(rows, cols, 0, 0);
        }
    }
}

export function handleSshPaneClose(ws: AuthenticatedWebSocket, payload: any, incomingSessionId?: string): void {
    const sessionId = incomingSessionId || ws.sessionId || payload?.sessionId;
    const state = sessionId ? clientStates.get(sessionId) : undefined;
    const paneId = payload?.paneId;

    if (!state || !state.paneStreams || !paneId) return;

    const paneState = state.paneStreams.get(paneId);
    if (paneState) {
        try {
            paneState.stream?.destroy();
        } catch (e) {}
        state.paneStreams.delete(paneId);
        console.log(`SSH: 主动关闭并移除分屏终端 ${paneId} (会话: ${sessionId})`);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'ssh:pane_closed',
                sessionId,
                payload: { paneId }
            }));
        }
    }
}