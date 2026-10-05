import * as CommandHistoryRepository from '../command-history/command-history.repository';
import { CommandHistoryEntry } from '../command-history/command-history.repository';

/**
 * 添加一条命令历史记录
 * @param command - 要添加的命令
 * @returns 返回完整历史记录条目
 */
export const addCommandHistory = async (command: string): Promise<CommandHistoryEntry> => {
    // 可以在这里添加额外的业务逻辑，例如校验命令格式、长度限制等
    if (!command || command.trim().length === 0) {
        throw new Error('命令不能为空');
    }

    // 调用 upsertCommand 来处理插入或更新时间戳
    return CommandHistoryRepository.upsertCommand(command.trim());
};

/**
 * 获取命令历史记录
 * @param limit - 获取的最大记录数
 * @returns 返回历史记录条目数组，按时间戳升序
 */
export const getAllCommandHistory = async (limit?: number): Promise<CommandHistoryEntry[]> => {
    return CommandHistoryRepository.getAllCommands(limit);
};

/**
 * 根据 ID 删除一条命令历史记录
 * @param id - 要删除的记录 ID
 * @returns 返回是否成功删除 (删除行数 > 0)
 */
export const deleteCommandHistoryById = async (id: number): Promise<boolean> => {
    // deleteCommandById now directly returns boolean indicating success
    const success = await CommandHistoryRepository.deleteCommandById(id);
    return success;
};

/**
 * 清空所有命令历史记录
 * @returns 返回删除的记录条数
 */
export const clearAllCommandHistory = async (): Promise<number> => {
    return CommandHistoryRepository.clearAllCommands();
};
