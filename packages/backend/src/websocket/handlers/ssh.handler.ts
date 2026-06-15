import { Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedWebSocket, ClientState } from '../types';
import { clientStates, sftpService, statusMonitorService, auditLogService, notificationService } from '../state';
import * as SshService from '../../services/ssh.service';
import { cleanupClientConnection } from '../utils';
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

    try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ssh:status', payload: '正在获取连接信息...' }));
        connInfo = await SshService.getConnectionDetails(dbConnectionId);

        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ssh:status', payload: `正在连接到 ${connInfo.host}...` }));
        const sshClient = await SshService.establishSshConnection(connInfo);

        const newSessionId = uuidv4();
        ws.sessionId = newSessionId; // Assign new sessionId to the WebSocket

        const dbConnectionIdAsNumber = parseInt(dbConnectionId, 10);
        if (isNaN(dbConnectionIdAsNumber)) {
            console.error(`WebSocket: 无效的 dbConnectionId '${dbConnectionId}' (非数字)，无法创建会话 ${newSessionId}。`);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ssh:error', payload: '无效的连接 ID。' }));
            sshClient.end();
            ws.close(1008, 'Invalid Connection ID');
            return;
        }

        const newState: ClientState = {
            ws: ws,
            sshClient: sshClient,
            dbConnectionId: dbConnectionIdAsNumber,
            connectionName: connInfo!.name,
            ipAddress: clientIp,
            isShellReady: false,
            startup_command: connInfo!.startup_command ?? null,
            sftp_sudo_enabled: connInfo!.sftp_sudo_enabled ?? false,
            sftp_sudo_password: connInfo!.sftp_sudo_password ?? null,
        };
        clientStates.set(newSessionId, newState);
        console.log(`WebSocket: 为用户 ${ws.username} (IP: ${clientIp}) 创建新会话 ${newSessionId} (DB ID: ${dbConnectionIdAsNumber}, 连接名称: ${newState.connectionName})`);

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

                console.log(`WebSocket: 会话 ${newSessionId} Shell 打开成功 (尺寸 ${defaultCols}x${defaultRows})。`);
                newState.sshShellStream = stream;
                newState.isShellReady = true;
                if (connInfo!.startup_command) {
                    const cmd = connInfo!.startup_command.trimEnd() + '\n';
                    stream.write(cmd);
                    console.log(`WebSocket: 会话 ${newSessionId} 执行启动命令: ${connInfo!.startup_command}`);
                }

                stream.on('data', (data: Buffer) => {
                    if (ws.readyState === WebSocket.OPEN) {
                        // 确保数据以 UTF-8 编码转换为 Base64
                        const utf8Data = data.toString('utf8');
                        ws.send(JSON.stringify({ type: 'ssh:output', payload: Buffer.from(utf8Data, 'utf8').toString('base64'), encoding: 'base64' }));
                    }
                    // 如果会话被标记为待挂起，则将输出写入日志
                    const currentState = clientStates.get(newSessionId); // 获取最新的状态
                    if (currentState?.isMarkedForSuspend && currentState.suspendLogPath) {
                        temporaryLogStorageService.writeToLog(currentState.suspendLogPath, data.toString('utf-8')).catch(err => {
                            console.error(`[SSH Handler] 写入标记会话 ${newSessionId} 的日志失败 (路径: ${currentState.suspendLogPath}):`, err);
                        });
                    }
                });
                stream.stderr.on('data', (data: Buffer) => {
                    console.error(`SSH Stderr (会话: ${newSessionId}): ${data.toString('utf8').substring(0, 100)}...`);
                    if (ws.readyState === WebSocket.OPEN) {
                        // 确保数据以 UTF-8 编码转换为 Base64
                        const utf8ErrData = data.toString('utf8');
                        ws.send(JSON.stringify({ type: 'ssh:output', payload: Buffer.from(utf8ErrData, 'utf8').toString('base64'), encoding: 'base64' }));
                    }
                    // 同样，如果会话被标记为待挂起，则将 stderr 输出写入日志
                    const currentState = clientStates.get(newSessionId);
                    if (currentState?.isMarkedForSuspend && currentState.suspendLogPath) {
                        temporaryLogStorageService.writeToLog(currentState.suspendLogPath, `[STDERR] ${data.toString('utf-8')}`).catch(err => {
                            console.error(`[SSH Handler] 写入标记会话 ${newSessionId} 的 STDERR 日志失败 (路径: ${currentState.suspendLogPath}):`, err);
                        });
                    }
                });
                stream.on('close', () => {
                    console.log(`SSH: 会话 ${newSessionId} 的 Shell 通道已关闭。`);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'ssh:disconnected', payload: 'Shell 通道已关闭。' }));
                    }
                    cleanupClientConnection(newSessionId);
                });

                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({
                    type: 'ssh:connected',
                    payload: {
                        connectionId: dbConnectionIdAsNumber,
                        sessionId: newSessionId
                    }
                }));
                console.log(`WebSocket: 会话 ${newSessionId} SSH 连接和 Shell 建立成功。`);
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
            cleanupClientConnection(newSessionId);
        });
        sshClient.on('error', (err: Error) => {
            console.error(`SSH: 会话 ${newSessionId} 的客户端连接错误:`, err);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ssh:error', payload: `SSH 连接错误: ${err.message}` }));
            }
            cleanupClientConnection(newSessionId);
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
        // Store intended size if shell not ready, apply when shell is ready.
        // This part is a bit more complex as it requires modifying the shell opening logic.
        // For now, we just log if shell is not ready.
        console.warn(`WebSocket: 会话 ${sessionId} 收到调整大小请求，但 Shell 尚未就绪或流不存在 (isShellReady: ${state.isShellReady})。尺寸将不会立即应用。`);
        // A more robust solution would queue the resize or store it in ClientState to be applied later.
    }
}

// 处理会话恢复后的状态监控启动
export function handleSshResumeSuccess(sessionId: string): void {
    const state = clientStates.get(sessionId);
    if (state && state.sshClient) {
        statusMonitorService.startStatusPolling(sessionId);
        // 如果 Docker 状态也需要恢复，可以在这里添加
        // startDockerStatusPolling(sessionId);
    } else {
        console.error(`[SSH Handler ${sessionId}] 无法为恢复的会话启动状态轮询：未找到会话状态或 SSH 客户端。`);
    }
}