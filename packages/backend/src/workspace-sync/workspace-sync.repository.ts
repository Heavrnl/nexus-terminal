import { getDbInstance, runDb, getDb as getDbRow } from '../database/connection';

export interface WorkspaceSyncRecord {
    userId: number;
    state: string; // JSON serialized state
    activeClientId: string | null;
    updatedAt: number;
}

interface DbWorkspaceSyncRow {
    user_id: number;
    state: string;
    active_client_id: string | null;
    updated_at: number;
}

/**
 * 获取指定用户的工作区同步记录
 */
export const getWorkspaceSyncRecord = async (userId: number): Promise<WorkspaceSyncRecord | null> => {
    const db = await getDbInstance();
    const sql = `SELECT user_id, state, active_client_id, updated_at FROM workspace_sync WHERE user_id = ?`;
    try {
        const row = await getDbRow<DbWorkspaceSyncRow>(db, sql, [userId]);
        if (!row) {
            return null;
        }
        return {
            userId: row.user_id,
            state: row.state,
            activeClientId: row.active_client_id,
            updatedAt: row.updated_at
        };
    } catch (err: any) {
        console.error(`[WorkspaceSyncRepository] 获取用户 ${userId} 工作区失败:`, err.message);
        throw err;
    }
};

/**
 * 保存用户工作区状态并更新当前持有租约的 clientId
 */
export const saveWorkspaceSyncRecord = async (
    userId: number,
    state: string,
    clientId: string
): Promise<void> => {
    const db = await getDbInstance();
    const now = Math.floor(Date.now() / 1000);
    const sql = `
        INSERT INTO workspace_sync (user_id, state, active_client_id, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            state = excluded.state,
            active_client_id = excluded.active_client_id,
            updated_at = excluded.updated_at;
    `;
    try {
        await runDb(db, sql, [userId, state, clientId, now]);
    } catch (err: any) {
        console.error(`[WorkspaceSyncRepository] 保存用户 ${userId} 工作区失败:`, err.message);
        throw err;
    }
};

/**
 * 客户端声明接管工作区租约（不覆盖已有 state）
 */
export const claimWorkspaceLease = async (
    userId: number,
    clientId: string
): Promise<void> => {
    const db = await getDbInstance();
    const now = Math.floor(Date.now() / 1000);
    const sql = `
        INSERT INTO workspace_sync (user_id, state, active_client_id, updated_at)
        VALUES (?, '{}', ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            active_client_id = excluded.active_client_id,
            updated_at = excluded.updated_at;
    `;
    try {
        await runDb(db, sql, [userId, clientId, now]);
    } catch (err: any) {
        console.error(`[WorkspaceSyncRepository] 用户 ${userId} 声明租约失败:`, err.message);
        throw err;
    }
};
