import { PortInfo, ClientState, AuthenticatedWebSocket } from './types';
import { SftpService } from '../sftp/sftp.service';
import { StatusMonitorService } from '../services/status-monitor.service';
import { clientStates, sftpService, statusMonitorService } from './state';
import { sshSuspendService } from '../ssh-suspend/ssh-suspend.service';
import { temporaryLogStorageService } from '../ssh-suspend/temporary-log-storage.service';
import { workspaceSyncService } from '../workspace-sync/workspace-sync.service';
import { remoteHostedSessionRepository } from '../remote-agent/remote-hosted-session.repository';
import { getOrCreateOwnerNamespace } from '../remote-agent/owner-namespace.service';

/** 单会话在线态环形输出缓冲上限（1MB） */
export const MAX_RECENT_OUTPUT_BYTES = 1024 * 1024;

/**
 * 向会话环形输出缓冲追加 UTF-8 文本，超出上限时从头部安全淘汰并尽量对齐换行边界，
 * 避免拦腰截断 ANSI / OSC 转义序列导致恢复回放头部出现垃圾控制字符。
 */
export function appendRingBuffer(state: ClientState, utf8Data: string, maxBytes: number = MAX_RECENT_OUTPUT_BYTES): void {
    if (!utf8Data) return;
    if (!state.recentOutputBuffer) {
        state.recentOutputBuffer = [];
        state.recentOutputBytes = 0;
    }
    state.recentOutputBuffer.push(utf8Data);
    state.recentOutputBytes = (state.recentOutputBytes || 0) + Buffer.byteLength(utf8Data, 'utf8');

    let trimmed = false;
    while (state.recentOutputBytes > maxBytes && state.recentOutputBuffer.length > 1) {
        const shifted = state.recentOutputBuffer.shift();
        if (shifted) {
            state.recentOutputBytes -= Buffer.byteLength(shifted, 'utf8');
        }
        trimmed = true;
    }

    // 发生截断后，若新头部恰好落在半截行/半截转义序列中，向后对齐到第一个换行符并重置 SGR 样式
    if (trimmed && state.recentOutputBuffer.length > 0) {
        const head = state.recentOutputBuffer[0];
        if (head && !head.startsWith('\x1b[0m')) {
            const firstNl = head.indexOf('\n');
            if (firstNl >= 0 && firstNl + 1 < head.length) {
                const oldBytes = Buffer.byteLength(head, 'utf8');
                const aligned = `\x1b[0m${head.slice(firstNl + 1)}`;
                state.recentOutputBuffer[0] = aligned;
                state.recentOutputBytes += Buffer.byteLength(aligned, 'utf8') - oldBytes;
            }
        }
    }
}

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
 * @param expectedWs - 可选，发起清理的 WebSocket 引用；若当前活跃会话已换绑新 WS，则跳过清理避免旧 WS 迟到 close 误杀新会话
 */
export const cleanupClientConnection = async (sessionId: string | undefined, expectedWs?: AuthenticatedWebSocket) => { // Made async
    if (!sessionId) return;

    const state = clientStates.get(sessionId);
    if (!state) return;

    // 核心并发守卫：弱网半开旧 WS 迟到触发 close/error 时，绝不能清理已换绑新 WS 的活跃会话
    if (expectedWs && state.ws !== expectedWs) {
        console.log(`WebSocket: 会话 ${sessionId} 已绑定新 WebSocket，忽略旧 WebSocket 的清理请求。`);
        return;
    }

    // 防止与 suspendOtherClientsSessions 或重复 close/error 事件并发重入
    if (state.isHandingOverToSuspend) {
        console.log(`WebSocket: 会话 ${sessionId} 正在移交挂起中，跳过重复清理。`);
        return;
    }

    {
        console.log(`WebSocket: 清理会话 ${sessionId} (用户: ${state.ws.username}, DB 连接 ID: ${state.dbConnectionId})...`);

        // 0. 冲刷并释放输出微批合帧器，防止残留定时器与未发尾包
        try { state.outputCoalescer?.dispose(false); } catch {}
        state.outputCoalescer = undefined;

        // 1. 停止状态轮询 (如果存在)
        if (statusMonitorService) statusMonitorService.stopStatusPolling(sessionId);

        // 2. 清理 SFTP 会话 (如果存在)
        if (sftpService) sftpService.cleanupSftpSession(sessionId);

        // 3. 处理 SSH 连接 (核心防御：主动关闭或已销毁绝对不挂起)
        //
        // 无终端（headless）会话同样**绝不自动挂起**：它是文件管理器绑定主机时开的私有通道，
        // 不在标签栏、也不进云端快照。ws 一断就没有宿主了，谁也不会再来 resume 它 ——
        // 移交进挂起池只会变成「一条我根本没打开过的连接」永久趴在面板里。
        let frozenInitialBuffer: string | undefined = undefined;
        let handoverDeltaBuffer: string | undefined = undefined;

        if (state.hostingMode === 'remote-agent') {
            // 目标机自托管模式（nexus-mux）：
            // - 显式关闭：发 KILL 彻底终止目标机主终端与全部分屏 PTY 进程树，并移除持久化记录；
            // - 断网 / 刷新 / 被接管 / 手动挂起：仅发 DETACH 释放本端 SSH 隧道，目标机进程继续保活！
            const remoteId = state.remoteSessionId;
            if (state.isExplicitlyClosed) {
                console.log(`WebSocket: 会话 ${sessionId} (remote-agent: ${remoteId}) 显式关闭，向目标机发送 KILL 终止进程树...`);
                try {
                    state.muxMainHandle?.kill();
                    if (state.paneStreams) {
                        for (const p of state.paneStreams.values()) {
                            try { p.muxHandle?.kill(); } catch {}
                        }
                        state.paneStreams.clear();
                    }
                    state.muxTransport?.destroy();
                } catch {}
                if (remoteId) {
                    remoteHostedSessionRepository.deleteByRemoteSessionId(remoteId).catch(() => {});
                }
            } else {
                console.log(`WebSocket: 会话 ${sessionId} (remote-agent: ${remoteId}) 非显式断开，优雅 DETACH 保留目标机存活会话...`);
                if (state.isMarkedForSuspend && remoteId && !state.isSuspendedByService) {
                    try {
                        const { ownerNamespace } = await getOrCreateOwnerNamespace();
                        await remoteHostedSessionRepository.upsert({
                            remoteSessionId: remoteId,
                            connectionUuid: state.connectionUuid ?? null,
                            connectionId: state.dbConnectionId,
                            connectionName: state.connectionName || '未知连接',
                            manuallySuspended: true,
                            status: 'hanging',
                            ownerNamespace,
                        });
                    } catch (err) {
                        console.warn(`[cleanupClientConnection] 持久化目标机挂起记录失败:`, err);
                    }
                }
                try {
                    state.muxTransport?.detachAllAndClose();
                } catch {}
                state.paneStreams?.clear();
            }
            state.muxMainHandle = undefined;
            state.muxTransport = undefined;
            try {
                state.sshClient?.end?.();
            } catch {}
            state.sshClient = undefined as any;
        } else if (state.isExplicitlyClosed || state.isHeadless) {
            console.log(
                state.isHeadless
                    ? `WebSocket: 会话 ${sessionId} 是无终端会话，断开后直接释放底层 SSH 资源（不转入挂起）。`
                    : `WebSocket: 会话 ${sessionId} 属于显式关闭/彻底销毁，绝不自动挂起，直接释放底层 SSH 资源。`
            );
            state.isMarkedForSuspend = false;
            try {
                state.terminalEmulator?.dispose();
                state.sshShellStream?.destroy?.();
                state.sshShellStream?.end?.();
                state.sshClient?.destroy?.();
                state.sshClient?.end?.();
            } catch (closeErr) {}
            state.terminalEmulator = undefined;
            state.sshClient = undefined as any;
            state.sshShellStream = undefined;
        } else if (!state.isMarkedForSuspend && state.sshClient && state.sshShellStream && state.ws.userId !== undefined) {
            // 只要不是显式主动关闭，网络断开（包括刷新 1001、网络异常等），均保护性自动转入挂起！
            console.log(`WebSocket: 会话 ${sessionId} 发生网络断开（非显式关闭），自动转入挂起保活模式...`);
            state.isHandingOverToSuspend = true;
            if (!state.suspendLogPath) {
                state.suspendLogPath = sessionId;
            }

            // ⚠️ 必须在任何 await 之前同步冻结「断线前前端已看到的历史」，并清空 recentOutputBuffer
            // 来专门承接异步写盘窗口内远端新吐出的输出（作为 deltaBuffer，避免 reattach delta 模式下被当成已读历史裁掉！）
            let initialBuffer = '';
            const fallbackRawRecent = state.recentOutputBuffer ? state.recentOutputBuffer.join('') : '';
            state.recentOutputBuffer = [];
            state.recentOutputBytes = 0;

            // 优先使用服务端 Headless VT 序列化出的纯净屏幕状态落盘（不含历史查询控制序列）
            if (state.terminalEmulator?.hasAnyOutput()) {
                initialBuffer = await state.terminalEmulator.serialize();
            }
            if (!initialBuffer) {
                initialBuffer = fallbackRawRecent;
            }

            // 如果后端内存缓冲与 VT 均为空，尝试从快照终端缓冲区获取保底历史
            if (!initialBuffer) {
                try {
                    const syncRecord = await workspaceSyncService.getState(state.ws.userId);
                    if (syncRecord.state?.sessions && Array.isArray(syncRecord.state.sessions)) {
                        const matchedSync = syncRecord.state.sessions.find(
                            (s: any) => String(s.sessionId) === String(sessionId)
                        );
                        if (matchedSync && matchedSync.terminalBuffer) {
                            initialBuffer = matchedSync.terminalBuffer.replace(/\r?\n/g, '\r\n');
                        }
                    }
                } catch (e) {}
            }

            frozenInitialBuffer = initialBuffer || undefined;

            // 写入日志文件作为初始日志（仅写入断线前历史）
            if (frozenInitialBuffer) {
                try {
                    await temporaryLogStorageService.ensureLogDirectoryExists();
                    await temporaryLogStorageService.overwriteLog(state.suspendLogPath, frozenInitialBuffer);
                } catch (logErr) {
                    console.warn(`[cleanupClientConnection] 写入挂起初始日志失败:`, logErr);
                }
            }

            // 收集在异步等待期间远端继续吐出的新输出作为 delta（同时追加到磁盘日志）
            const deltaText = state.recentOutputBuffer ? state.recentOutputBuffer.join('') : '';
            state.recentOutputBuffer = [];
            state.recentOutputBytes = 0;
            if (deltaText) {
                handoverDeltaBuffer = deltaText;
                temporaryLogStorageService.writeToLog(state.suspendLogPath, deltaText).catch(() => {});
            }

            state.isMarkedForSuspend = true;
        } else if (state.isMarkedForSuspend && state.sshClient && state.sshShellStream) {
            // 已经提前被标记为待挂起（SSH_MARK_FOR_SUSPEND）：优先序列化纯净屏幕状态，兜底使用内存缓冲
            state.isHandingOverToSuspend = true;
            if (state.terminalEmulator?.hasAnyOutput()) {
                frozenInitialBuffer = (await state.terminalEmulator.serialize()) || undefined;
            }
            if (!frozenInitialBuffer) {
                frozenInitialBuffer = state.recentOutputBuffer ? state.recentOutputBuffer.join('') || undefined : undefined;
            }
            state.recentOutputBuffer = [];
            state.recentOutputBytes = 0;
        }

        if (state.isMarkedForSuspend && state.sshClient && state.sshShellStream && state.suspendLogPath && state.ws.userId !== undefined) {
            console.log(`WebSocket: 会话 ${sessionId} 已被标记为待挂起，尝试移交给 SshSuspendService...`);
            let emulatorToPass = state.terminalEmulator;
            try {
                // 从 state 中“分离”SSH资源、分屏Shell通道与 Headless VT，防止后续意外关闭或释放
                const sshClientToPass = state.sshClient;
                const channelToPass = state.sshShellStream;
                const paneStreamsToPass = state.paneStreams;
                state.sshClient = undefined as any; // 清除引用
                state.sshShellStream = undefined; // 清除引用
                state.paneStreams = undefined; // 清除引用，防止后续误清理
                state.terminalEmulator = undefined; // 所有权移交给 SshSuspendService
                state.isSuspendedByService = true; // 标记为已被服务接管（即使是尝试接管）

                const newSuspendId = await sshSuspendService.takeOverMarkedSession({
                    userId: state.ws.userId,
                    originalSessionId: sessionId,
                    sshClient: sshClientToPass,
                    channel: channelToPass,
                    connectionName: state.connectionName || '未知连接',
                    connectionId: String(state.dbConnectionId),
                    logIdentifier: state.suspendLogPath,
                    initialBuffer: frozenInitialBuffer,
                    deltaBuffer: handoverDeltaBuffer,
                    utf8Decoder: state.outDecoder,
                    terminalEmulator: emulatorToPass,
                    customSuspendName: undefined,
                    paneStreams: paneStreamsToPass,
                });

                if (newSuspendId) {
                    console.log(`WebSocket: 会话 ${sessionId} 已成功移交给 SshSuspendService，新的挂起ID: ${newSuspendId}。SSH 连接与 ${paneStreamsToPass?.size || 0} 个分屏将由服务管理。`);
                    // SSH 资源与 Headless VT 已移交，不需要在这里关闭它们
                } else {
                    console.warn(`WebSocket: 会话 ${sessionId} 移交给 SshSuspendService 失败 (takeOverMarkedSession 返回 null)。可能 SSH 连接在标记后已断开。将执行常规清理。`);
                    // 移交失败，执行常规关闭
                    try { emulatorToPass?.dispose(); } catch {}
                    channelToPass?.end();
                    sshClientToPass?.end();
                    if (paneStreamsToPass) {
                        for (const [, p] of paneStreamsToPass.entries()) {
                            try { p.stream?.end?.(); } catch (e) {}
                        }
                    }
                    state.isSuspendedByService = false; // 重置标记，因为接管失败
                }
            } catch (error) {
                console.error(`WebSocket: 会话 ${sessionId} 移交给 SshSuspendService 时发生错误:`, error);
                // 发生错误，也执行常规关闭以防资源泄露
                try { emulatorToPass?.dispose(); } catch {}
                if (state.sshClient) state.sshClient.end(); // 如果引用还在，尝试关闭
                if (state.sshShellStream) state.sshShellStream.end(); // 如果引用还在，尝试关闭
                state.isSuspendedByService = false; // 重置标记
            } finally {
                state.isHandingOverToSuspend = false;
            }
        } else if (!state.isSuspendedByService && state.sshClient) {
            // 未标记挂起，也未被服务接管，执行常规关闭
            try { state.terminalEmulator?.dispose(); } catch {}
            state.terminalEmulator = undefined;
            state.sshShellStream?.end();
            state.sshClient?.end();
            console.log(`WebSocket: 会话 ${sessionId} 的 SSH 连接已关闭 (未标记挂起，未被服务接管)。`);
        } else if (state.isSuspendedByService) {
            // 已被服务接管（例如通过旧的 startSuspend 流程，或成功移交后），不在此处关闭
            console.log(`WebSocket: 会话 ${sessionId} 的 SSH 连接已由挂起服务管理，跳过关闭。`);
        } else {
            // 未建立完整 SSH 连接的残留状态，兜底释放可能已创建的 VT
            try { state.terminalEmulator?.dispose(); } catch {}
            state.terminalEmulator = undefined;
        }
        state.isHandingOverToSuspend = false;

        // 3.5 清理所有多终端分屏通道 (paneStreams)
        if (state.paneStreams && state.paneStreams.size > 0) {
            console.log(`WebSocket: 会话 ${sessionId} 正在清理 ${state.paneStreams.size} 个分屏 Shell 通道...`);
            for (const [, paneState] of state.paneStreams.entries()) {
                try {
                    paneState.stream?.destroy?.();
                    paneState.stream?.end?.();
                } catch (e) {}
            }
            state.paneStreams.clear();
        }

        // 4. 清理 Docker 状态轮询定时器
        if (state.dockerStatusIntervalId) {
            clearInterval(state.dockerStatusIntervalId);
            console.log(`WebSocket: Cleared Docker status interval for session ${sessionId}.`);
        }

        // 5. 从状态 Map 中移除（仅当当前映射仍是本 state 实例时才删除，避免误删异步期间重连的新会话）
        if (clientStates.get(sessionId) === state) {
            clientStates.delete(sessionId);
        }

        // 6. 清除 WebSocket 上的 sessionId 关联 (可选，因为 ws 可能已关闭)
        if (state.ws && state.ws.sessionId === sessionId) {
            delete state.ws.sessionId;
        }

        console.log(`WebSocket: 会话 ${sessionId} 已清理。`);
    }
};