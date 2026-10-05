import { getDbInstance, runDb, getDb as getDbRow, allDb } from '../database/connection';

// 定义命令历史记录的接口
export interface CommandHistoryEntry {
    id: number;
    command: string;
    timestamp: number; // Unix 时间戳 (秒)
}

type DbCommandHistoryRow = CommandHistoryEntry;

/**
 * 插入或更新一条命令历史记录。
 * 如果命令已存在，则更新其时间戳；否则，插入新记录。
 * @param command - 要添加或更新的命令字符串
 * @returns 返回插入或更新后的完整历史记录条目
 */
export const upsertCommand = async (command: string): Promise<CommandHistoryEntry> => {
    const now = Math.floor(Date.now() / 1000); // 获取当前时间戳
    const db = await getDbInstance();

    try {
        // 1. 尝试更新现有记录的时间戳
        const updateSql = `UPDATE command_history SET timestamp = ? WHERE command = ?`;
        const updateResult = await runDb(db, updateSql, [now, command]);

        if (updateResult.changes > 0) {
            // 更新成功，获取被更新记录的 ID
            const selectSql = `SELECT id FROM command_history WHERE command = ? ORDER BY timestamp DESC LIMIT 1`;
            const row = await getDbRow<{ id: number }>(db, selectSql, [command]);
            if (row) {
                return { id: row.id, command, timestamp: now };
            } else {
                throw new Error('更新成功但无法找到记录 ID');
            }
        } else {
            // 2. 没有记录被更新，说明命令不存在，执行插入
            const insertSql = `INSERT INTO command_history (command, timestamp) VALUES (?, ?)`;
            const insertResult = await runDb(db, insertSql, [command, now]);
            if (typeof insertResult.lastID !== 'number' || insertResult.lastID <= 0) {
                 throw new Error('插入新命令历史记录后未能获取有效的 lastID');
            }
            return { id: insertResult.lastID, command, timestamp: now };
        }
    } catch (err: any) {
        console.error('Upsert 命令历史记录时出错:', err.message);
        throw new Error('无法更新或插入命令历史记录');
    }
};

/**
 * 获取命令历史记录，按时间戳升序排列（最旧的在前）
 * 限制默认取最新的 500 条记录，防止全表无上限扫描导致网络与内存压力
 * @param limit - 最大获取数量，默认为 500
 * @returns 返回包含历史记录条目的数组
 */
export const getAllCommands = async (limit: number = 500): Promise<CommandHistoryEntry[]> => {
    const sql = `
        SELECT id, command, timestamp 
        FROM (
            SELECT id, command, timestamp 
            FROM command_history 
            ORDER BY timestamp DESC, id DESC 
            LIMIT ?
        ) 
        ORDER BY timestamp ASC, id ASC
    `;
    try {
        const db = await getDbInstance();
        const rows = await allDb<DbCommandHistoryRow>(db, sql, [limit]);
        return rows;
    } catch (err: any) {
        console.error('获取命令历史记录时出错:', err.message);
        throw new Error('无法获取命令历史记录');
    }
};

/**
 * 根据 ID 删除指定的命令历史记录
 * @param id - 要删除的记录 ID
 * @returns 返回是否成功删除 (true/false)
 */
export const deleteCommandById = async (id: number): Promise<boolean> => {
    const sql = `DELETE FROM command_history WHERE id = ?`;
    try {
        const db = await getDbInstance();
        const result = await runDb(db, sql, [id]);
        return result.changes > 0;
    } catch (err: any) {
        console.error('删除命令历史记录时出错:', err.message);
        throw new Error('无法删除命令历史记录');
    }
};

/**
 * 清空所有命令历史记录
 * @returns 返回删除的行数
 */
export const clearAllCommands = async (): Promise<number> => {
    const sql = `DELETE FROM command_history`;
    try {
        const db = await getDbInstance();
        const result = await runDb(db, sql);
        return result.changes;
    } catch (err: any) {
        console.error('清空命令历史记录时出错:', err.message);
        throw new Error('无法清空命令历史记录');
    }
};
