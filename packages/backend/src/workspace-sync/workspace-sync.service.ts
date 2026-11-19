import { AuthenticatedWebSocket } from '../websocket/types';
import * as workspaceSyncRepo from './workspace-sync.repository';
import { clientStates } from '../websocket/state';
import { sshSuspendService } from '../ssh-suspend/ssh-suspend.service';
import { temporaryLogStorageService } from '../ssh-suspend/temporary-log-storage.service';
import {
    chooseSuspendLogBuffer,
    evaluateLeaseWrite,
    isForeignWorkspaceClient,
    removeSessionFromSnapshot,
    shouldHandoverToSuspend,
} from './workspace-sync.pure';

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
     * 维护 userId -> 串行异步写锁队列。
     *
     * claimLease / saveState / destroySessionCompletely 都涉及「读快照 → 改内存/挂起池 → 写回 SQLite」
     * 的非原子操作。无锁并发时：
     *  - 批量关闭多个标签（并发 DELETE）互相覆盖导致已关会话复活；
     *  - 多端同时抢接管（并发 claimLease）导致孤儿清理误杀刚移交的活跃会话。
     */
    private userLocks = new Map<number, Promise<unknown>>();

    /**
     * 维护 `${userId}:${clientId}` 最近一次成功落盘的保存序号与快照时间戳，
     * 拦截弱网乱序到达的迟到旧快照，防止旧快照覆盖新状态。
     */
    private lastSaveVersion = new Map<string, { seq: number; updatedAt: number }>();

    /**
     * 维护 userId -> 「第几轮接管」。
     *
     * 每次租约真正换人 +1，用来给这一轮移交出去的挂起条目打标：
     * 下一轮接管时就能认出「上一轮留下的、这一轮没人会去 resume 的孤儿」并清掉。
     * 只存在内存里 —— 重启后挂起池本来就是空的，不需要持久化。
     */
    private takeoverRounds = new Map<number, number>();

    private withUserLock<T>(userId: number, task: () => Promise<T>): Promise<T> {
        const prev = this.userLocks.get(userId) ?? Promise.resolve();
        const next = prev.catch(() => undefined).then(task);
        const tracked = next.finally(() => {
            if (this.userLocks.get(userId) === tracked) {
                this.userLocks.delete(userId);
            }
        });
        this.userLocks.set(userId, tracked);
        return next;
    }

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
     *
     * @param takeoverRound 本轮接管编号，会写进挂起条目，供下一轮清理孤儿用
     */
    public async suspendOtherClientsSessions(
        userId: number,
        currentClientId: string,
        takeoverRound?: number
    ): Promise<void> {
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
            // 只接管「另一个**参与工作区同步**的客户端」的会话：
            // 没绑过 clientId 的 ws（桌面端、旧客户端、ws 抢在 store 初始化前连上的窗口期）
            // 不属于这个工作区，把它们挂走就是"挂起池里冒出一个我没打开过的连接"。
            const isForeignClient = isForeignWorkspaceClient(wsClientId, currentClientId);
            // 匹配同一用户、非当前声明接管客户端、且具有活跃 SSH 连接的会话
            //
            // 无终端会话（前端文件管理器绑定主机的私有通道）不参与移交：
            // 用户从没在标签栏见过它，挂进池子就是「挂起列表里冒出我没打开过的连接」。
            //
            // 末尾两个判空与 `shouldHandoverToSuspend` 里的判定重复，是为了让 TS 把
            // sshClient / sshShellStream 收窄成非空，下面直接拿它们去移交。
            if (
                state.ws?.userId === userId &&
                isForeignClient &&
                !state.isHandingOverToSuspend &&
                shouldHandoverToSuspend({
                    isHeadless: state.isHeadless === true,
                    isMarkedForSuspend: state.isMarkedForSuspend === true,
                    hasSshClient: Boolean(state.sshClient),
                    hasShellStream: Boolean(state.sshShellStream),
                }) &&
                state.sshClient &&
                state.sshShellStream
            ) {
                console.log(`[WorkspaceSyncService] 发现用户 ${userId} 旧客户端 (${wsClientId || 'unknown'}) 的活动会话 ${sessionId}，正在移交挂起...`);
                // 同步置防重入标记，防止与 cleanupClientConnection 竞态重复移交
                state.isHandingOverToSuspend = true;
                if (!state.suspendLogPath) {
                    state.suspendLogPath = sessionId;
                }

                // 在任何 await 之前同步冻结「接管前已产生的历史」，并清空 recentOutputBuffer
                // 用于接住写盘异步窗口内继续到达的远端输出（作为 deltaBuffer，1 字节不丢）
                const frozenRecentOutput = state.recentOutputBuffer ? state.recentOutputBuffer.join('') : '';
                state.recentOutputBuffer = [];
                state.recentOutputBytes = 0;

                // 优先从服务端 Headless VT 序列化纯净屏幕状态（天然不含历史查询控制序列）
                let vtSerialized = '';
                if (state.terminalEmulator?.hasAnyOutput()) {
                    vtSerialized = await state.terminalEmulator.serialize();
                }

                // 写挂起日志：优先用 VT 纯净快照；VT 为空时再走原有策略（内存 → 同 id 快照 → 同连接快照）
                const snapshotExact =
                    snapshotSessions.find((s: any) => s.sessionId === sessionId) ?? null;
                const snapshotSameConnection = snapshotSessions.filter(
                    (s: any) => String(s.connectionId) === String(state.dbConnectionId)
                );
                const picked = vtSerialized
                    ? { buffer: vtSerialized, source: 'recent' as const }
                    : chooseSuspendLogBuffer({
                        recentOutput: frozenRecentOutput,
                        snapshotExact,
                        snapshotSameConnection,
                    });

                let initialBufferToPass: string | undefined = undefined;
                if (picked.buffer) {
                    // VT 序列化产物与内存缓冲均已保留真实换行语义，
                    // 不能再做换行归一化；快照里是 xterm 序列化文本，需要补 \r。
                    const payload =
                        picked.source === 'recent'
                            ? picked.buffer
                            : picked.buffer.replace(/\r?\n/g, '\r\n');
                    initialBufferToPass = payload;
                    try {
                        console.log(
                            `[WorkspaceSyncService] 为挂起会话 ${sessionId} 写终端历史（来源: ${vtSerialized ? 'headless-vt' : picked.source}, 字符数: ${payload.length}）...`
                        );
                        await temporaryLogStorageService.ensureLogDirectoryExists();
                        await temporaryLogStorageService.overwriteLog(state.suspendLogPath, payload);
                    } catch (logErr) {
                        console.warn(`[WorkspaceSyncService] 写入终端历史日志失败:`, logErr);
                    }
                } else {
                    // 没有新历史时尝试读出已有磁盘日志，避免传 undefined 导致挂起期新输出覆掉旧磁盘日志
                    try {
                        const existingDiskLog = await temporaryLogStorageService.readLog(state.suspendLogPath);
                        if (existingDiskLog) {
                            initialBufferToPass = existingDiskLog;
                        }
                    } catch {
                        // ignore
                    }
                    if (!initialBufferToPass) {
                        console.warn(
                            `[WorkspaceSyncService] 会话 ${sessionId} 找不到可用的终端历史（快照与内存都为空），保留现有日志不覆盖`
                        );
                    }
                }

                // 收集异步写盘窗口内远端新吐出的数据，追加写盘并作为 deltaBuffer 交给挂起服务
                const windowDelta = state.recentOutputBuffer ? state.recentOutputBuffer.join('') : '';
                state.recentOutputBuffer = [];
                state.recentOutputBytes = 0;
                if (windowDelta) {
                    temporaryLogStorageService.writeToLog(state.suspendLogPath, windowDelta).catch(() => {});
                }

                const sshClientToPass = state.sshClient;
                const channelToPass = state.sshShellStream;
                const paneStreamsToPass = state.paneStreams;
                const emulatorToPass = state.terminalEmulator;
                // 同步分离 SSH 主通道、所有分屏副终端通道与 Headless VT，防止旧客户端关闭时误杀分屏 Shell 或释放 VT
                state.sshClient = undefined as any;
                state.sshShellStream = undefined;
                state.paneStreams = undefined;
                state.terminalEmulator = undefined;
                state.isMarkedForSuspend = true;
                state.isSuspendedByService = true;

                try {
                    const newSuspendId = await sshSuspendService.takeOverMarkedSession({
                        userId,
                        originalSessionId: sessionId,
                        sshClient: sshClientToPass,
                        channel: channelToPass,
                        connectionName: state.connectionName || '未知连接',
                        connectionId: String(state.dbConnectionId),
                        logIdentifier: state.suspendLogPath,
                        initialBuffer: initialBufferToPass,
                        deltaBuffer: windowDelta || undefined,
                        utf8Decoder: state.outDecoder,
                        terminalEmulator: emulatorToPass,
                        paneStreams: paneStreamsToPass,
                        // 打上本轮编号：下一轮接管才知道它是"上一轮留下的孤儿"
                        takeoverRound,
                    });
                    console.log(`[WorkspaceSyncService] 会话 ${sessionId} 成功由 SshSuspendService 接管挂起，suspendId: ${newSuspendId} (分屏数: ${paneStreamsToPass?.size || 0})`);
                } catch (err: any) {
                    console.error(`[WorkspaceSyncService] 挂起旧客户端会话 ${sessionId} 失败:`, err);
                    try { emulatorToPass?.dispose(); } catch {}
                    channelToPass?.end();
                    sshClientToPass?.end();
                    if (paneStreamsToPass) {
                        for (const [, p] of paneStreamsToPass.entries()) {
                            try { p.stream?.end?.(); } catch {}
                        }
                    }
                    state.isSuspendedByService = false;
                } finally {
                    state.isHandingOverToSuspend = false;
                }
            }
        }
    }

    /**
     * 客户端声明接管工作区租约，并通知其他客户端进入遮罩状态
     *
     * 【幂等】同一个客户端重复声明（挂载前预取 + 恢复流程、刷新、连点「接管」）
     * 不能再去"移交别人的会话"—— 那时候没有别人的会话可移交，白白多跑一遍
     * `suspendOtherClientsSessions`，还会把本端自己的会话当成别的客户端的。
     */
    public async claimLease(userId: number, clientId: string): Promise<void> {
        return this.withUserLock(userId, async () => {
            console.log(`[WorkspaceSyncService] 用户 ${userId} 客户端 ${clientId} 正在声明接管工作区...`);

            let currentOwner: string | null = null;
            try {
                const record = await workspaceSyncRepo.getWorkspaceSyncRecord(userId);
                currentOwner = record?.activeClientId || null;
            } catch (e) {
                // 读不到就当换人，按原逻辑走
            }

            if (currentOwner === clientId) {
                console.log(`[WorkspaceSyncService] 客户端 ${clientId} 已持有租约，跳过会话移交（幂等声明）`);
                await workspaceSyncRepo.claimWorkspaceLease(userId, clientId);
                this.notifyOtherClientsTakeover(userId, clientId);
                return;
            }

            const round = (this.takeoverRounds.get(userId) || 0) + 1;
            this.takeoverRounds.set(userId, round);
            console.log(`[WorkspaceSyncService] 用户 ${userId} 第 ${round} 轮接管：${currentOwner || '（无）'} -> ${clientId}`);

            await workspaceSyncRepo.claimWorkspaceLease(userId, clientId);
            // 1. 自动挂起旧客户端的 SSH 活动会话
            await this.suspendOtherClientsSessions(userId, clientId, round);
            // 2. 清掉上几轮接管留下、这一轮已经没人认领的挂起条目
            await this.pruneOrphanTakeoverSuspends(userId, round);
            // 3. 广播踢出/遮罩通知
            this.notifyOtherClientsTakeover(userId, clientId);
        });
    }

    /**
     * 清理「上一轮接管留下、这一轮恢复再也用不到」的自动挂起条目。
     *
     * 新端恢复时只认领云端快照里还有的会话，其余（旧端自己那一代、快照还没落库的新会话、
     * 不参与同步的客户端会话）永远没人认领 —— 不清理的话，反复接管几次挂起面板就堆成一串。
     * 快照为空 / 读失败时**不动手**：宁可留着，也不能把正常挂起清光。
     */
    private async pruneOrphanTakeoverSuspends(userId: number, round: number): Promise<void> {
        const keep = new Set<string>();
        try {
            const record = await workspaceSyncRepo.getWorkspaceSyncRecord(userId);
            if (!record?.state) return;
            const parsed = JSON.parse(record.state);
            const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
            if (sessions.length === 0) return;
            for (const item of sessions) {
                if (item?.sessionId) keep.add(String(item.sessionId));
            }
        } catch (e) {
            return;
        }

        try {
            const removed = await sshSuspendService.pruneOrphanTakeoverSessions(userId, round, keep);
            if (removed.length > 0) {
                console.log(
                    `[WorkspaceSyncService] 第 ${round} 轮接管：清掉 ${removed.length} 个上轮遗留的挂起条目 (${removed.join(', ')})`
                );
            }
        } catch (err: any) {
            console.warn(`[WorkspaceSyncService] 清理上轮遗留挂起条目失败:`, err?.message || err);
        }
    }

    /**
     * 保存工作区状态快照
     *
     * 【租约校验】只有持有租约的客户端才能写入。
     *
     * 以前这里无条件覆盖，而且会顺手把 active_client_id 改成调用方 —— 于是被接管的旧页面
     * 只要触发一次"关标签 / 改布局"的自动保存，就能把已关闭的会话重新写回快照，
     * 下次刷新又"复活"。现在非持有者的写入直接拒绝，并把当前持有者回传，
     * 前端据此自己进入接管遮罩（不依赖 WebSocket 踢出消息，断线重连也不会失忆）。
     */
    public async saveState(
        userId: number,
        clientId: string,
        state: WorkspaceSyncStatePayload,
        saveSeq?: number
    ): Promise<{ accepted: boolean; activeClientId: string | null; staleIgnored?: boolean }> {
        return this.withUserLock(userId, async () => {
            const record = await workspaceSyncRepo.getWorkspaceSyncRecord(userId);
            const leaseOwner = record?.activeClientId || null;

            // 判定逻辑抽到 workspace-sync.pure.ts（被接管后旧客户端的自动保存必须被拒，
            // 否则会出现"关闭会话后刷新又复活"）
            const decision = evaluateLeaseWrite(leaseOwner, clientId);
            if (!decision.accepted) {
                console.warn(
                    `[WorkspaceSyncService] 拒绝非租约持有者 ${clientId} 的快照写入（当前持有者: ${decision.activeClientId}），`
                    + `会话数 ${Array.isArray((state as any)?.sessions) ? (state as any).sessions.length : '?'}`
                );
                return decision;
            }

            // 弱网乱序防护：拦截同一客户端迟到的旧版本快照（按 saveSeq 优先，其次按 state.updatedAt）
            const versionKey = `${userId}:${clientId}`;
            const prevVersion = this.lastSaveVersion.get(versionKey);
            const incomingSeq = typeof saveSeq === 'number' && Number.isFinite(saveSeq) ? saveSeq : undefined;
            const incomingUpdatedAt = typeof state?.updatedAt === 'number' && Number.isFinite(state.updatedAt)
                ? state.updatedAt
                : 0;

            if (incomingSeq !== undefined && prevVersion && prevVersion.seq > 0 && incomingSeq <= prevVersion.seq) {
                console.warn(`[WorkspaceSyncService] 忽略客户端 ${clientId} 乱序迟到的旧快照 (saveSeq=${incomingSeq} <= ${prevVersion.seq})`);
                return { accepted: true, staleIgnored: true, activeClientId: clientId };
            }
            if (incomingSeq === undefined && incomingUpdatedAt > 0) {
                let storedUpdatedAt = prevVersion?.updatedAt || 0;
                if (storedUpdatedAt === 0 && record?.state && leaseOwner === clientId) {
                    try {
                        const parsed = JSON.parse(record.state);
                        if (typeof parsed?.updatedAt === 'number') storedUpdatedAt = parsed.updatedAt;
                    } catch {}
                }
                if (storedUpdatedAt > 0 && incomingUpdatedAt < storedUpdatedAt) {
                    console.warn(`[WorkspaceSyncService] 忽略客户端 ${clientId} 乱序迟到的旧快照 (updatedAt=${incomingUpdatedAt} < ${storedUpdatedAt})`);
                    return { accepted: true, staleIgnored: true, activeClientId: clientId };
                }
            }

            const serialized = JSON.stringify(state);
            await workspaceSyncRepo.saveWorkspaceSyncRecord(userId, serialized, clientId);
            this.lastSaveVersion.set(versionKey, {
                seq: incomingSeq !== undefined ? incomingSeq : (prevVersion?.seq || 0),
                updatedAt: Math.max(incomingUpdatedAt, prevVersion?.updatedAt || 0),
            });
            // 保存时确保持有租约，并确保其他端被遮罩
            this.notifyOtherClientsTakeover(userId, clientId);
            return { accepted: true, activeClientId: clientId };
        });
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

    /**
     * 强制彻底销毁指定的会话：
     * 1. 强制杀死该会话的底层 SSH 客户端与通道流，绝不转入挂起；
     * 2. 强制清理挂起服务池中属于该会话的残留记录；
     * 3. 强制从数据库 workspace_sync 快照中剔除该会话并立即落盘。
     * 【核心铁律】：严格仅针对特定的 targetSessionId，绝不能因 connectionId 相同而误伤同连接下的其他活跃会话！
     */
    public async destroySessionCompletely(
        userId: number,
        targetSessionId: string,
        clientId?: string
    ): Promise<{ success: boolean; accepted?: boolean; activeClientId?: string | null; remainingSessionsCount: number }> {
        return this.withUserLock(userId, async () => {
            console.log(`[WorkspaceSyncService] 开始强制彻底销毁会话: ${targetSessionId} (用户: ${userId}, clientId: ${clientId || 'none'})`);

            // 0. 租约校验：如果当前存在活跃租约持有者，拒绝非持有者（含未带合法 clientId 的旧端）篡改云端快照与新端会话
            const currentRecord = await workspaceSyncRepo.getWorkspaceSyncRecord(userId);
            const leaseOwner = currentRecord?.activeClientId || null;
            if (leaseOwner && (!clientId || leaseOwner !== clientId)) {
                let remaining = 0;
                try {
                    const parsed = currentRecord?.state ? JSON.parse(currentRecord.state) : null;
                    remaining = Array.isArray(parsed?.sessions) ? parsed.sessions.length : 0;
                } catch {}
                console.warn(
                    `[WorkspaceSyncService] 拒绝非租约持有者 (${clientId || 'missing'}) 销毁会话 ${targetSessionId}（当前持有者: ${leaseOwner}）`
                );
                return {
                    success: false,
                    accepted: false,
                    activeClientId: leaseOwner,
                    remainingSessionsCount: remaining,
                };
            }

            // 1. 强制切断底层 SSH 客户端与通道流（仅针对目标 targetSessionId）
            const state = clientStates.get(targetSessionId);
            if (state && (!state.ws?.userId || state.ws.userId === userId)) {
                console.log(`[WorkspaceSyncService] 强制切断并关闭活动 SSH 连接: ${targetSessionId}`);
                state.isExplicitlyClosed = true;
                state.isMarkedForSuspend = false;
                state.closeReason = 'client_explicit_destroy';
                try {
                    state.sshShellStream?.destroy?.();
                    state.sshShellStream?.end?.();
                    state.sshClient?.destroy?.();
                    state.sshClient?.end?.();
                } catch (e) {
                    console.warn(`[WorkspaceSyncService] 切断 SSH 连接发生非致命错误:`, e);
                }
                state.sshClient = undefined as any;
                state.sshShellStream = undefined;
                clientStates.delete(targetSessionId);
            }

            // 2. 强制清理挂起服务池中残留的该会话（仅针对目标 targetSessionId）
            try {
                await sshSuspendService.terminateSuspendedSession(userId, targetSessionId);
                const userSuspended = (sshSuspendService as any).getUserSessions?.(userId);
                if (userSuspended) {
                    for (const [suspId, suspSess] of userSuspended.entries()) {
                        if (suspId === targetSessionId || suspSess.originalSessionId === targetSessionId) {
                            console.log(`[WorkspaceSyncService] 强制清理残留挂起条目: ${suspId}`);
                            await sshSuspendService.terminateSuspendedSession(userId, suspId);
                        }
                    }
                }
            } catch (e) {
                console.warn(`[WorkspaceSyncService] 清理挂起条目异常:`, e);
            }

            // 3. 强制从数据库 workspace_sync 快照中剔除该会话并立即落盘（仅针对目标 targetSessionId）
            let remainingSessionsCount = 0;
            try {
                const record = await workspaceSyncRepo.getWorkspaceSyncRecord(userId);
                if (record && record.state) {
                    const parsedState = JSON.parse(record.state);
                    if (Array.isArray(parsedState.sessions)) {
                        const beforeCount = parsedState.sessions.length;
                        // 剔除规则抽到 workspace-sync.pure.ts：只按 sessionId 匹配，
                        // 绝不动同连接下的其他会话；顺带维护 sessionOrder / activeSessionId / fileManagers
                        const { state: nextState, remainingSessionsCount: remaining } = removeSessionFromSnapshot(
                            parsedState,
                            targetSessionId
                        );
                        remainingSessionsCount = remaining;

                        // 立即原子写入数据库落盘（已在 userLocks 串行临界区内）
                        await workspaceSyncRepo.saveWorkspaceSyncRecord(
                            userId,
                            JSON.stringify(nextState),
                            record.activeClientId || clientId || 'system'
                        );
                        console.log(`[WorkspaceSyncService] 数据库快照已强制剔除会话 ${targetSessionId} (原数量: ${beforeCount}, 剩余: ${remainingSessionsCount})`);
                    }
                }
            } catch (dbErr) {
                console.error(`[WorkspaceSyncService] 数据库快照剔除会话落盘失败:`, dbErr);
            }

            return { success: true, accepted: true, activeClientId: leaseOwner, remainingSessionsCount };
        });
    }
}

export const workspaceSyncService = new WorkspaceSyncService();
