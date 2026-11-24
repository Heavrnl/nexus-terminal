import { Request, Response } from 'express';
import { workspaceSyncService, WorkspaceSyncStatePayload } from './workspace-sync.service';
import { workspaceSyncRemoteProxy } from './workspace-sync.remote-proxy';
import { isDesktopRuntime } from '../auth/desktop-bootstrap';
import { getOrCreateOwnerNamespace } from '../remote-agent/owner-namespace.service';

export class WorkspaceSyncController {
    /**
     * 获取当前工作区同步运行模式（Web 云端 / 桌面端云端同步 / 桌面端离线兜底 / 桌面端纯本地）
     */
    public async getRuntimeMode(_req: Request, res: Response): Promise<void> {
        try {
            const info = await workspaceSyncRemoteProxy.getRuntimeMode();
            const { workspaceOwnerId, ownerNamespace } = await getOrCreateOwnerNamespace();
            res.json({
                success: true,
                data: {
                    ...info,
                    workspaceOwnerId,
                    ownerNamespace,
                },
            });
        } catch (error: any) {
            res.status(500).json({ success: false, message: '获取工作区同步模式失败', error: error.message });
        }
    }

    /**
     * 获取当前用户的工作区快照
     */
    public async getState(req: Request, res: Response): Promise<void> {
        const userId = req.session?.userId || 1;
        const localOnly = req.query?.localOnly === '1' || req.query?.localOnly === 'true';
        try {
            const data =
                isDesktopRuntime() && !localOnly
                    ? await workspaceSyncRemoteProxy.getState(userId)
                    : await workspaceSyncService.getState(userId);
            res.json({
                success: true,
                data: {
                    state: data.state,
                    activeClientId: data.activeClientId,
                    updatedAt: data.updatedAt,
                    workspaceOwnerId: data.workspaceOwnerId,
                    offlineMode: (data as any).offlineMode === true,
                    syncSource: (data as any).syncSource || (isDesktopRuntime() ? 'desktop_local_only' : 'web_cloud'),
                }
            });
        } catch (error: any) {
            console.error(`[WorkspaceSyncController] 获取工作区失败:`, error);
            res.status(500).json({ success: false, message: '获取工作区状态失败', error: error.message });
        }
    }

    /**
     * 声明接管工作区租约
     */
    public async claimLease(req: Request, res: Response): Promise<void> {
        const userId = req.session?.userId || 1;
        const { clientId } = req.body;
        const localOnly = req.query?.localOnly === '1' || req.body?.localOnly === true;

        if (!clientId || typeof clientId !== 'string') {
            res.status(400).json({ success: false, message: '缺少有效的 clientId' });
            return;
        }

        try {
            if (isDesktopRuntime() && !localOnly) {
                const proxied = await workspaceSyncRemoteProxy.claimLease(userId, clientId);
                res.json({
                    success: true,
                    message: proxied.offlineMode ? '云端离线，已本地接管工作区' : '工作区接管成功',
                    data: {
                        activeClientId: proxied.activeClientId,
                        workspaceOwnerId: proxied.workspaceOwnerId,
                        offlineMode: proxied.offlineMode,
                    }
                });
                return;
            }
            await workspaceSyncService.claimLease(userId, clientId);
            const { workspaceOwnerId } = await getOrCreateOwnerNamespace();
            res.json({
                success: true,
                message: '工作区接管成功',
                data: {
                    activeClientId: clientId,
                    workspaceOwnerId,
                    offlineMode: false,
                }
            });
        } catch (error: any) {
            console.error(`[WorkspaceSyncController] 接管工作区失败:`, error);
            res.status(500).json({ success: false, message: '接管工作区失败', error: error.message });
        }
    }

    /**
     * 保存工作区快照
     */
    public async saveState(req: Request, res: Response): Promise<void> {
        const userId = req.session?.userId || 1;
        const { clientId, state, saveSeq, localOnly } = req.body as {
            clientId: string;
            state: WorkspaceSyncStatePayload;
            saveSeq?: number;
            localOnly?: boolean;
        };

        if (!clientId || typeof clientId !== 'string') {
            res.status(400).json({ success: false, message: '缺少有效的 clientId' });
            return;
        }

        if (!state || typeof state !== 'object') {
            res.status(400).json({ success: false, message: '缺少有效的工作区状态 state' });
            return;
        }

        try {
            const result =
                isDesktopRuntime() && !localOnly
                    ? await workspaceSyncRemoteProxy.saveState(userId, clientId, state, saveSeq)
                    : { ...(await workspaceSyncService.saveState(userId, clientId, state, saveSeq)), offlineMode: false };
            res.json({
                success: true,
                message: result.accepted
                    ? (result.staleIgnored ? '迟到的旧版本快照已忽略' : (result.offlineMode ? '云端离线，已暂存到本地缓存' : '工作区已保存'))
                    : '当前客户端不是工作区租约持有者，本次保存已忽略',
                data: {
                    updatedAt: Math.floor(Date.now() / 1000),
                    accepted: result.accepted,
                    staleIgnored: result.staleIgnored === true,
                    activeClientId: result.activeClientId,
                    offlineMode: result.offlineMode === true,
                }
            });
        } catch (error: any) {
            console.error(`[WorkspaceSyncController] 保存工作区失败:`, error);
            res.status(500).json({ success: false, message: '保存工作区状态失败', error: error.message });
        }
    }

    /**
     * 强制彻底销毁指定的会话（强制切断SSH + 杀目标机PTY + 清除挂起 + 数据库快照强制剔除）
     */
    public async destroySession(req: Request, res: Response): Promise<void> {
        const userId = req.session?.userId || 1;
        const sessionId = req.params.sessionId;
        const headerClientId = req.headers['x-workspace-client-id'];
        const localOnly = req.query?.localOnly === '1' || req.query?.localOnly === 'true';
        const clientId =
            (typeof headerClientId === 'string' && headerClientId.trim())
            || (typeof req.query?.clientId === 'string' && req.query.clientId.trim())
            || (typeof req.body?.clientId === 'string' && req.body.clientId.trim())
            || undefined;

        if (!sessionId) {
            res.status(400).json({ success: false, message: '缺少 sessionId' });
            return;
        }

        try {
            const result =
                isDesktopRuntime() && !localOnly
                    ? await workspaceSyncRemoteProxy.destroySession(userId, sessionId, clientId)
                    : await workspaceSyncService.destroySessionCompletely(userId, sessionId, clientId);
            if (result.accepted === false) {
                res.status(409).json({
                    success: false,
                    message: '当前客户端不是工作区租约持有者，拒绝销毁云端快照会话',
                    data: result
                });
                return;
            }
            res.json({
                success: true,
                message: '会话已强制彻底销毁并清除数据库记录',
                data: result
            });
        } catch (error: any) {
            console.error(`[WorkspaceSyncController] 强制销毁会话失败:`, error);
            res.status(500).json({ success: false, message: '强制销毁会话失败', error: error.message });
        }
    }
}

export const workspaceSyncController = new WorkspaceSyncController();
