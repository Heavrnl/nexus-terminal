import { Request, Response } from 'express';
import { workspaceSyncService, WorkspaceSyncStatePayload } from './workspace-sync.service';

export class WorkspaceSyncController {
    /**
     * 获取当前用户的工作区快照
     */
    public async getState(req: Request, res: Response): Promise<void> {
        const userId = req.session?.userId || 1;
        try {
            const data = await workspaceSyncService.getState(userId);
            res.json({
                success: true,
                data: {
                    state: data.state,
                    activeClientId: data.activeClientId,
                    updatedAt: data.updatedAt
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

        if (!clientId || typeof clientId !== 'string') {
            res.status(400).json({ success: false, message: '缺少有效的 clientId' });
            return;
        }

        try {
            await workspaceSyncService.claimLease(userId, clientId);
            res.json({
                success: true,
                message: '工作区接管成功',
                data: {
                    activeClientId: clientId
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
        const { clientId, state } = req.body as { clientId: string; state: WorkspaceSyncStatePayload };

        if (!clientId || typeof clientId !== 'string') {
            res.status(400).json({ success: false, message: '缺少有效的 clientId' });
            return;
        }

        if (!state || typeof state !== 'object') {
            res.status(400).json({ success: false, message: '缺少有效的工作区状态 state' });
            return;
        }

        try {
            await workspaceSyncService.saveState(userId, clientId, state);
            res.json({
                success: true,
                message: '工作区已保存',
                data: {
                    updatedAt: Math.floor(Date.now() / 1000)
                }
            });
        } catch (error: any) {
            console.error(`[WorkspaceSyncController] 保存工作区失败:`, error);
            res.status(500).json({ success: false, message: '保存工作区状态失败', error: error.message });
        }
    }
}

export const workspaceSyncController = new WorkspaceSyncController();
