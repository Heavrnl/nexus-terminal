import { getDbInstance, runDb, getDb as getDbRow, allDb } from '../database/connection';
import { generateDeterministicCommandUuid, normalizeCommandText } from './command-history.pure';

// 定义命令历史记录的接口
export interface CommandHistoryEntry {
    id: number;
    command: string;
    timestamp: number; // Unix 时间戳 (秒)
}

type DbCommandHistoryRow = CommandHistoryEntry;

/**
 * 原子插入或更新一条命令历史记录。
 * 依靠 command 唯一索引 + 确定性 UUID，彻底避免并发写入导致同一命令产生两条记录。
 * @param command - 要添加或更新的命令字符串
 * @returns 返回插入或更新后的完整历史记录条目
 */
export const upsertCommand = async (command: string): Promise<CommandHistoryEntry> => {
    const normalized = normalizeCommandText(command);
    if (!normalized) {
        throw new Error('命令不能为空');
    }

    const now = Math.floor(Date.now() / 1000); // 获取当前时间戳 (秒)
    const detUuid = generateDeterministicCommandUuid(normalized);
    const db = await getDbInstance();

    try {
        const upsertSql = `
            INSERT INTO command_history (command, timestamp, uuid)
            VALUES (?, ?, ?)
            ON CONFLICT(command) DO UPDATE SET
                timestamp = MAX(command_history.timestamp, excluded.timestamp),
                uuid = excluded.uuid
        `;
        await runDb(db, upsertSql, [normalized, now, detUuid]);

        const row = await getDbRow<DbCommandHistoryRow>(
            db,
            `SELECT id, command, timestamp FROM command_history WHERE command = ? LIMIT 1`,
            [normalized]
        );
        if (!row) {
            throw new Error('写入命令历史记录后未能查询到目标行');
        }
        return row;
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
