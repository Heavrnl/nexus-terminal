import { AuthenticatedWebSocket } from '../websocket/types';
import * as workspaceSyncRepo from './workspace-sync.repository';
import { clientStates } from '../websocket/state';
import { sshSuspendService } from '../ssh-suspend/ssh-suspend.service';
import { temporaryLogStorageService } from '../ssh-suspend/temporary-log-storage.service';

export interface WorkspaceSyncStatePayload {
    syncEnabled: boolean;
    activeSessionId?: string | null;
    sessions?: Array<{
        sessionId: string;
        connectionId: string | number;
        connectionName: string;
        isSuspended?: boolean;
        suspendSessionId?: string;
        commandInputContent?: string;
        terminalBuffer?: string;
        editorTabs?: Array<{
            id: string;
            sessionId: string;
            filePath: string;
            filename: string;
            content?: string;
            rawContentBase64?: string | null;
            isModified?: boolean;
            language?: string;
            selectedEncoding?: string;
            scrollTop?: number;
            scrollLeft?: number;
        }>;
        activeEditorTabId?: string | null;
    }>;
    fileEditor?: {
        activeTabId: string | null;
        tabs: Array<{
            id: string;
            sessionId: string;
            filePath: string;
            filename: string;
            content?: string;
            rawContentBase64?: string | null;
            isModified?: boolean;
            language?: string;
            selectedEncoding?: string;
            scrollTop?: number;
            scrollLeft?: number;
        }>;
    };
    fileManager?: {
        currentPath: string;
        isSearchActive: boolean;
        searchQuery: string;
        scrollTop?: number;
        scrollRatio?: number;
    };
    fileManagers?: Record<string, {
        instanceId: string;
        sessionId: string;
        currentPath: string;
        isSearchActive: boolean;
        searchQuery: string;
        scrollTop?: number;
        scrollRatio?: number;
    }>;
    multiLineCommandInput?: {
        currentContent: string;
        sessionDrafts?: Record<string, string>;
    };
    updatedAt?: number;
}

export class WorkspaceSyncService {
    // 维护 userId -> Set<AuthenticatedWebSocket>
    private userSockets = new Map<number, Set<AuthenticatedWebSocket>>();

    /**
     * 注册客户端 WebSocket 连接
     */
    public registerSocket(userId: number, ws: AuthenticatedWebSocket, clientId?: string): void {
        if (!this.userSockets.has(userId)) {
            this.userSockets.set(userId, new Set());
        }
        this.userSockets.get(userId)!.add(ws);
        if (clientId) {
            (ws as any).syncClientId = clientId;
        }

        ws.on('close', () => {
            this.unregisterSocket(userId, ws);
        });
    }

    /**
     * 注销客户端 WebSocket 连接
     */
    public unregisterSocket(userId: number, ws: AuthenticatedWebSocket): void {
        const set = this.userSockets.get(userId);
        if (set) {
            set.delete(ws);
            if (set.size === 0) {
                this.userSockets.delete(userId);
            }
        }
    }

    /**
     * 绑定或更新 WebSocket 的 syncClientId
     */
    public bindSocketClientId(userId: number, ws: AuthenticatedWebSocket, clientId: string): void {
        (ws as any).syncClientId = clientId;
        if (!this.userSockets.has(userId)) {
            this.userSockets.set(userId, new Set());
        }
        this.userSockets.get(userId)!.add(ws);
    }

    /**
     * 获取指定用户的工作区快照
     */
    public async getState(userId: number): Promise<{
        state: WorkspaceSyncStatePayload | null;
        activeClientId: string | null;
        updatedAt: number | null;
    }> {
        const record = await workspaceSyncRepo.getWorkspaceSyncRecord(userId);
        if (!record || !record.state) {
            return { state: null, activeClientId: null, updatedAt: null };
        }
        try {
            const parsedState = JSON.parse(record.state);
            return {
                state: parsedState,
                activeClientId: record.activeClientId,
                updatedAt: record.updatedAt
            };
        } catch (e) {
            console.error(`[WorkspaceSyncService] 解析用户 ${userId} 工作区 JSON 失败:`, e);
            return { state: null, activeClientId: record.activeClientId, updatedAt: record.updatedAt };
        }
    }

    /**
     * 将该用户属于其他客户端的活动 SSH 会话自动移交给挂起服务，实现真正的无缝接管
     */
    public async suspendOtherClientsSessions(userId: number, currentClientId: string): Promise<void> {
        let snapshotSessions: any[] = [];
        try {
            const record = await workspaceSyncRepo.getWorkspaceSyncRecord(userId);
            if (record?.state) {
                const parsed = JSON.parse(record.state);
                if (Array.isArray(parsed.sessions)) {
                    snapshotSessions = parsed.sessions;
                }
            }
        } catch (e) {
            // ignore
        }

        for (const [sessionId, state] of clientStates.entries()) {
            const wsClientId = (state.ws as any)?.syncClientId;
            // 匹配同一用户、非当前声明接管客户端、且具有活跃 SSH 连接的会话
            if (
                state.ws?.userId === userId &&
                wsClientId !== currentClientId &&
                !state.isMarkedForSuspend &&
                state.sshClient &&
                state.sshShellStream
            ) {
                console.log(`[WorkspaceSyncService] 发现用户 ${userId} 旧客户端 (${wsClientId || 'unknown'}) 的活动会话 ${sessionId}，正在移交挂起...`);
                state.isMarkedForSuspend = true;
                if (!state.suspendLogPath) {
                    state.suspendLogPath = sessionId;
                }

                // 写入终端屏幕最新历史 (精准覆盖或清空)
                const matchedSync = snapshotSessions.find(
                    (s: any) => String(s.connectionId) === String(state.dbConnectionId) || s.sessionId === sessionId
                );
                if (matchedSync && typeof matchedSync.terminalBuffer === 'string') {
                    try {
                        console.log(`[WorkspaceSyncService] 为挂起会话 ${sessionId} 覆盖同步终端屏幕历史 (字符数: ${matchedSync.terminalBuffer.length})...`);
                        await temporaryLogStorageService.ensureLogDirectoryExists();
                        const normalized = matchedSync.terminalBuffer ? matchedSync.terminalBuffer.replace(/\r?\n/g, '\r\n') : '';
                        const formatted = normalized ? (normalized.endsWith('\r\n') ? normalized : `${normalized}\r\n`) : '';
                        await temporaryLogStorageService.overwriteLog(state.suspendLogPath, formatted);
                    } catch (logErr) {
                        console.warn(`[WorkspaceSyncService] 覆盖写入终端历史日志失败:`, logErr);
                    }
                }

                const takeoverDetails = {
                    userId,
                    originalSessionId: sessionId,
                    sshClient: state.sshClient,
                    channel: state.sshShellStream,
                    connectionName: state.connectionName || '未知连接',
                    connectionId: String(state.dbConnectionId),
                    logIdentifier: state.suspendLogPath,
                };

                const sshClientToPass = state.sshClient;
                const channelToPass = state.sshShellStream;
                state.sshClient = undefined as any;
                state.sshShellStream = undefined;
                state.isSuspendedByService = true;

                try {
                    const newSuspendId = await sshSuspendService.takeOverMarkedSession({
                        ...takeoverDetails,
                        sshClient: sshClientToPass,
                        channel: channelToPass,
                    });
                    console.log(`[WorkspaceSyncService] 会话 ${sessionId} 成功由 SshSuspendService 接管挂起，suspendId: ${newSuspendId}`);
                } catch (err: any) {
                    console.error(`[WorkspaceSyncService] 挂起旧客户端会话 ${sessionId} 失败:`, err);
                    channelToPass?.end();
                    sshClientToPass?.end();
                    state.isSuspendedByService = false;
                }
            }
        }
    }

    /**
     * 客户端声明接管工作区租约，并通知其他客户端进入遮罩状态
     */
    public async claimLease(userId: number, clientId: string): Promise<void> {
        console.log(`[WorkspaceSyncService] 用户 ${userId} 客户端 ${clientId} 正在声明接管工作区...`);
        await workspaceSyncRepo.claimWorkspaceLease(userId, clientId);
        // 1. 自动挂起旧客户端的 SSH 活动会话
        await this.suspendOtherClientsSessions(userId, clientId);
        // 2. 广播踢出/遮罩通知
        this.notifyOtherClientsTakeover(userId, clientId);
    }

    /**
     * 保存工作区状态快照
     */
    public async saveState(userId: number, clientId: string, state: WorkspaceSyncStatePayload): Promise<void> {
        const serialized = JSON.stringify(state);
        await workspaceSyncRepo.saveWorkspaceSyncRecord(userId, serialized, clientId);
        // 保存时确保持有租约，并确保其他端被遮罩
        this.notifyOtherClientsTakeover(userId, clientId);
    }

    /**
     * 向同一用户的其他客户端推送接管踢出通知
     */
    public notifyOtherClientsTakeover(userId: number, activeClientId: string): void {
        const sockets = this.userSockets.get(userId);
        if (!sockets) return;

        const kickoutMessage = JSON.stringify({
            type: 'workspace:takeover_kickout',
            payload: {
                activeClientId,
                reason: 'taken_over_by_another_tab',
                timestamp: Date.now()
            }
        });

        for (const ws of sockets) {
            const socketClientId = (ws as any).syncClientId;
            // 如果连接有效且不属于当前接管客户端，则发送被踢出通知
            if (ws.readyState === 1 /* WebSocket.OPEN */ && (!socketClientId || socketClientId !== activeClientId)) {
                console.log(`[WorkspaceSyncService] 通知客户端 ${socketClientId || 'unbound'} 已被 ${activeClientId} 接管`);
                try {
                    ws.send(kickoutMessage);
                } catch (err: any) {
                    console.error(`[WorkspaceSyncService] 发送接管消息到 ${socketClientId} 失败:`, err.message);
                }
            }
        }
    }
}

export const workspaceSyncService = new WorkspaceSyncService();
