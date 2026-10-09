import { PortInfo, ClientState } from './types';
import { SftpService } from '../sftp/sftp.service';
import { StatusMonitorService } from '../services/status-monitor.service';
import { clientStates, sftpService, statusMonitorService } from './state';
import { sshSuspendService } from '../ssh-suspend/ssh-suspend.service';
import { temporaryLogStorageService } from '../ssh-suspend/temporary-log-storage.service';
import { workspaceSyncService } from '../workspace-sync/workspace-sync.service';

// --- 解析 Ports 字符串的辅助函数 ---
export function parsePortsString(portsString: string | undefined | null): PortInfo[] {
    if (!portsString) {
        return [];
    }
    const ports: PortInfo[] = [];
    const entries = portsString.split(', ');

    for (const entry of entries) {
        const parts = entry.split('->');
        let publicPart = '';
        let privatePart = '';

        if (parts.length === 2) {
            publicPart = parts[0];
            privatePart = parts[1];
        } else if (parts.length === 1) {
            privatePart = parts[0];
        } else {
            console.warn(`[WebSocket] Skipping unparsable port entry: ${entry}`);
            continue;
        }

        const privateMatch = privatePart.match(/^(\d+)\/(tcp|udp|\w+)$/);
        if (!privateMatch) {
            //  console.warn(`[WebSocket] Skipping unparsable private port part: ${privatePart}`);
             continue;
        }
        const privatePort = parseInt(privateMatch[1], 10);
        const type = privateMatch[2];

        let ip: string | undefined = undefined;
        let publicPort: number | undefined = undefined;

        
        if (publicPart) {
            const publicMatch = publicPart.match(/^(?:([\d.:a-fA-F]+):)?(\d+)$/);
             if (publicMatch) {
                 ip = publicMatch[1] || undefined;
                 publicPort = parseInt(publicMatch[2], 10);
             } else {
                //   console.warn(`[WebSocket] Skipping unparsable public port part: ${publicPart}`);
                   
             }
        }

        if (!isNaN(privatePort)) {
             ports.push({
                 IP: ip,
                 PrivatePort: privatePort,
                 PublicPort: publicPort,
                 Type: type
             });
        }
    }
    return ports;
}


/**
 * 清理指定会话 ID 关联的所有资源
 * @param sessionId - 会话 ID
 */
export const cleanupClientConnection = async (sessionId: string | undefined) => { // Made async
    if (!sessionId) return;

    const state = clientStates.get(sessionId);
    if (state) {
        console.log(`WebSocket: 清理会话 ${sessionId} (用户: ${state.ws.username}, DB 连接 ID: ${state.dbConnectionId})...`);

        // 1. 停止状态轮询 (如果存在)
        if (statusMonitorService) statusMonitorService.stopStatusPolling(sessionId);

        // 2. 清理 SFTP 会话 (如果存在)
        if (sftpService) sftpService.cleanupSftpSession(sessionId);

        // 3. 处理 SSH 连接 (核心修改点)
        if (!state.isMarkedForSuspend && state.sshClient && state.sshShellStream && state.ws.userId !== undefined) {
            try {
                const syncRecord = await workspaceSyncService.getState(state.ws.userId);
                if (syncRecord.state && syncRecord.state.syncEnabled) {
                    console.log(`WebSocket: 用户 ${state.ws.userId} 已启用工作区实时同步，断开时自动挂起会话 ${sessionId}...`);
                    state.isMarkedForSuspend = true;
                    if (!state.suspendLogPath) {
                        state.suspendLogPath = sessionId;
                    }

                    // 如果快照中存有该会话最新的终端屏幕缓冲区，预写入到挂起日志，供恢复时回放
                    if (syncRecord.state.sessions && Array.isArray(syncRecord.state.sessions)) {
                        const matchedSync = syncRecord.state.sessions.find(
                            (s: any) => String(s.connectionId) === String(state.dbConnectionId) || s.sessionId === sessionId
                        );
                        if (matchedSync && matchedSync.terminalBuffer) {
                            try {
                                console.log(`WebSocket: 为自动挂起写入终端屏幕历史 (会话 ${sessionId}, 字符数: ${matchedSync.terminalBuffer.length})...`);
                                await temporaryLogStorageService.ensureLogDirectoryExists();
                                const normalized = matchedSync.terminalBuffer.replace(/\r?\n/g, '\r\n');
                                const formatted = normalized.endsWith('\r\n') ? normalized : `${normalized}\r\n`;
                                await temporaryLogStorageService.writeToLog(state.suspendLogPath, formatted);
                            } catch (logErr) {
                                console.warn(`[cleanupClientConnection] 写入终端历史日志失败:`, logErr);
                            }
                        }
                    }
                }
            } catch (err: any) {
                console.warn(`[cleanupClientConnection] 检查工作区同步配置失败:`, err.message);
            }
        }

        if (state.isMarkedForSuspend && state.sshClient && state.sshShellStream && state.suspendLogPath && state.ws.userId !== undefined) {
            console.log(`WebSocket: 会话 ${sessionId} 已被标记为待挂起，尝试移交给 SshSuspendService...`);
            try {
                const takeoverDetails = {
                    userId: state.ws.userId,
                    originalSessionId: sessionId, // sessionId 是原始活动会话的ID
                    sshClient: state.sshClient,
                    channel: state.sshShellStream,
                    connectionName: state.connectionName || '未知连接',
                    connectionId: String(state.dbConnectionId),
                    logIdentifier: state.suspendLogPath, // 这是基于 originalSessionId 的日志标识
                    customSuspendName: undefined, // 如果需要，可以从 state 或其他地方获取
                };
                
                // 从 state 中“分离”SSH资源，防止后续意外关闭
                const sshClientToPass = state.sshClient;
                const channelToPass = state.sshShellStream;
                state.sshClient = undefined as any; // 清除引用
                state.sshShellStream = undefined; // 清除引用
                state.isSuspendedByService = true; // 标记为已被服务接管（即使是尝试接管）

                const newSuspendId = await sshSuspendService.takeOverMarkedSession({
                    ...takeoverDetails,
                    sshClient: sshClientToPass, // 传递分离出来的实例
                    channel: channelToPass,     // 传递分离出来的实例
                });

                if (newSuspendId) {
                    console.log(`WebSocket: 会话 ${sessionId} 已成功移交给 SshSuspendService，新的挂起ID: ${newSuspendId}。SSH 连接将由服务管理。`);
                    // SSH 资源已移交，不需要在这里关闭它们
                } else {
                    console.warn(`WebSocket: 会话 ${sessionId} 移交给 SshSuspendService 失败 (takeOverMarkedSession 返回 null)。可能 SSH 连接在标记后已断开。将执行常规清理。`);
                    // 移交失败，执行常规关闭
                    channelToPass?.end();
                    sshClientToPass?.end();
                    state.isSuspendedByService = false; // 重置标记，因为接管失败
                }
            } catch (error) {
                console.error(`WebSocket: 会话 ${sessionId} 移交给 SshSuspendService 时发生错误:`, error);
                // 发生错误，也执行常规关闭以防资源泄露
                if (state.sshClient) state.sshClient.end(); // 如果引用还在，尝试关闭
                if (state.sshShellStream) state.sshShellStream.end(); // 如果引用还在，尝试关闭
                state.isSuspendedByService = false; // 重置标记
            }
        } else if (!state.isSuspendedByService && state.sshClient) {
            // 未标记挂起，也未被服务接管，执行常规关闭
            state.sshShellStream?.end();
            state.sshClient?.end();
            console.log(`WebSocket: 会话 ${sessionId} 的 SSH 连接已关闭 (未标记挂起，未被服务接管)。`);
        } else if (state.isSuspendedByService) {
            // 已被服务接管（例如通过旧的 startSuspend 流程，或成功移交后），不在此处关闭
            console.log(`WebSocket: 会话 ${sessionId} 的 SSH 连接已由挂起服务管理，跳过关闭。`);
        }


        // 4. 清理 Docker 状态轮询定时器
        if (state.dockerStatusIntervalId) {
            clearInterval(state.dockerStatusIntervalId);
            console.log(`WebSocket: Cleared Docker status interval for session ${sessionId}.`);
        }

        // 5. 从状态 Map 中移除
        clientStates.delete(sessionId);

        // 6. 清除 WebSocket 上的 sessionId 关联 (可选，因为 ws 可能已关闭)
        if (state.ws && state.ws.sessionId === sessionId) {
            delete state.ws.sessionId;
        }

        console.log(`WebSocket: 会话 ${sessionId} 已清理。`);
    } else {
        // console.warn(`[WebSocket Utils] cleanupClientConnection: No state found for session ID ${sessionId}.`);
    }
};