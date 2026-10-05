import { Request, Response } from 'express';
import * as CommandHistoryService from './command-history.service';

/**
 * 处理添加新命令历史记录的请求
 */
export const addCommand = async (req: Request, res: Response): Promise<void> => {
    const { command } = req.body;

    if (!command || typeof command !== 'string' || command.trim().length === 0) {
        res.status(400).json({ message: '命令不能为空' });
        return;
    }

    try {
        const entry = await CommandHistoryService.addCommandHistory(command);
        res.status(201).json({
            id: entry.id,
            command: entry.command,
            timestamp: entry.timestamp,
            message: '命令已添加到历史记录'
        });
    } catch (error: any) {
        console.error('添加命令历史记录控制器出错:', error);
        res.status(500).json({ message: error.message || '无法添加命令历史记录' });
    }
};

/**
 * 处理获取所有命令历史记录的请求
 */
export const getAllCommands = async (req: Request, res: Response): Promise<void> => {
    try {
        const limitParam = req.query.limit ? parseInt(req.query.limit as string, 10) : 500;
        const limit = isNaN(limitParam) || limitParam <= 0 ? 500 : Math.min(limitParam, 2000);
        const history = await CommandHistoryService.getAllCommandHistory(limit);
        // 注意：前端要求最新在下，最旧在上。Repository 返回的是升序（旧->新），符合要求。
        res.status(200).json(history);
    } catch (error: any) {
        console.error('获取命令历史记录控制器出错:', error);
        res.status(500).json({ message: error.message || '无法获取命令历史记录' });
    }
};

/**
 * 处理根据 ID 删除命令历史记录的请求
 */
export const deleteCommand = async (req: Request, res: Response): Promise<void> => {
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
        res.status(400).json({ message: '无效的 ID' });
        return;
    }

    try {
        const success = await CommandHistoryService.deleteCommandHistoryById(id);
        if (success) {
            res.status(200).json({ message: '命令历史记录已删除' });
        } else {
            res.status(404).json({ message: '未找到要删除的命令历史记录' });
        }
    } catch (error: any) {
        console.error('删除命令历史记录控制器出错:', error);
        res.status(500).json({ message: error.message || '无法删除命令历史记录' });
    }
};

/**
 * 处理清空所有命令历史记录的请求
 */
export const clearAllCommands = async (req: Request, res: Response): Promise<void> => {
    try {
        const count = await CommandHistoryService.clearAllCommandHistory();
        res.status(200).json({ count, message: `已清空 ${count} 条命令历史记录` });
    } catch (error: any) {
        console.error('清空命令历史记录控制器出错:', error);
        res.status(500).json({ message: error.message || '无法清空命令历史记录' });
    }
};
