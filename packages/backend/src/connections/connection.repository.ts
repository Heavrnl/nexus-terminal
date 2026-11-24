import { Database } from 'sqlite3';
import crypto from 'crypto';
import { getDbInstance, runDb, getDb as getDbRow, allDb } from '../database/connection';


// Define Connection 类型 (可以从 controller 或 types 文件导入，暂时在此定义)
// 注意：这里不包含加密字段，因为 Repository 不应处理解密
interface ConnectionBase {
    id: number;
    name: string | null;
    type: 'SSH' | 'RDP' | 'VNC';
    host: string;
    port: number;
    username: string;
    auth_method: 'password' | 'key';
    proxy_id: number | null;
    proxy_type?: 'proxy' | 'jump' | null; // 新增连接本身的 proxy_type
    created_at: number;
    updated_at: number;
    last_connected_at: number | null;
    ssh_key_id?: number | null;
    notes?: string | null;
    background_color?: string | null;
    file_protocol?: 'auto' | 'sftp' | 'scp' | null;
    startup_command?: string;
    sftp_sudo_enabled?: number | boolean;
    /** 由 SELECT 里的表达式算出，只读 */
    has_sudo_password?: number | boolean;
    session_hosting_mode?: 'auto' | 'legacy' | null;
//    jump_chain: number[] | null; // <-- REMOVE from ConnectionBase
}

// ConnectionWithFoldersRow implicitly includes 'type' and 'ssh_key_id' via ConnectionBase
interface ConnectionWithFoldersRow extends ConnectionBase { // This will no longer cause error if ConnectionBase has no jump_chain
    uuid?: string;
    folder_ids_str: string | null;
    jump_chain: string | null; // Stored as JSON string in DB
}

// ConnectionWithFolders implicitly includes 'type' and 'ssh_key_id' via ConnectionBase
export interface ConnectionWithFolders extends ConnectionBase {
    uuid?: string;
    folder_ids: number[];
    jump_chain: number[] | null; // Explicitly add for service layer type
}

// 包含加密字段的完整类型，用于插入/更新
// FullConnectionData implicitly includes 'type' via ConnectionBase
export interface FullConnectionData extends ConnectionBase {
    encrypted_password?: string | null;
    encrypted_private_key?: string | null;
    encrypted_passphrase?: string | null;
    notes?: string | null;
    folder_ids?: number[];
    jump_chain: number[] | null; // Explicitly add for service layer input type
    proxy_type?: 'proxy' | 'jump' | null; // 新增连接本身的 proxy_type
    background_color?: string | null;
    file_protocol?: 'auto' | 'sftp' | 'scp' | null;
    startup_command?: string;
    sftp_sudo_enabled?: number | boolean;
    encrypted_sudo_password?: string | null;
    session_hosting_mode?: 'auto' | 'legacy' | null;
}



interface FullConnectionDbRow extends Omit<FullConnectionData, 'jump_chain' | 'folder_ids'> { // Omit service layer type, and folder_ids (not directly on connections table)
    ssh_key_id?: number | null; 
    jump_chain: string | null; // Stored as JSON string in DB
    proxy_type?: 'proxy' | 'jump' | null; // 连接本身的 proxy_type, from c.proxy_type
    proxy_db_id: number | null;
    proxy_name: string | null;
    actual_proxy_server_type: string | null; // p.type AS actual_proxy_server_type
    proxy_host: string | null;
    proxy_port: number | null;
    proxy_username: string | null;
    proxy_encrypted_password?: string | null;
    proxy_encrypted_private_key?: string | null;
    proxy_encrypted_passphrase?: string | null;
}


/**
 * 获取所有连接及其文件夹
 */
export const findAllConnectionsWithFolders = async (): Promise<ConnectionWithFolders[]> => {
    const sql = `
        SELECT
            c.id, c.uuid, c.name, c.type, c.host, c.port, c.username, c.auth_method, c.proxy_id, c.proxy_type, c.ssh_key_id, c.notes, c.jump_chain, c.background_color, c.file_protocol,
            c.startup_command, c.sftp_sudo_enabled, c.session_hosting_mode,
            (c.encrypted_sudo_password IS NOT NULL AND c.encrypted_sudo_password <> '') AS has_sudo_password,
            c.created_at, c.updated_at, c.last_connected_at,
            GROUP_CONCAT(ct.folder_id) as folder_ids_str
         FROM connections c
         LEFT JOIN connection_folders ct ON c.id = ct.connection_id
         GROUP BY c.id
         ORDER BY c.name ASC`;
    try {
        const db = await getDbInstance();
        const rows = await allDb<ConnectionWithFoldersRow>(db, sql);
        return rows.map(row => {
            const { jump_chain: jumpChainStr, ...restOfRow } = row;
            return {
                ...restOfRow,
                folder_ids: row.folder_ids_str ? row.folder_ids_str.split(',').map(Number).filter(id => !isNaN(id)) : [],
                jump_chain: jumpChainStr ? JSON.parse(jumpChainStr) as number[] : null
            } as ConnectionWithFolders;
        });
    } catch (err: any) {
        console.error('Repository: 查询连接列表时出错:', err.message);
        throw new Error('获取连接列表失败');
    }
};

/**
 * 根据 ID 获取单个连接及其文件夹
 */
export const findConnectionByIdWithFolders = async (id: number): Promise<ConnectionWithFolders | null> => {
    const sql = `
        SELECT
            c.id, c.uuid, c.name, c.type, c.host, c.port, c.username, c.auth_method, c.proxy_id, c.proxy_type, c.ssh_key_id, c.notes, c.jump_chain, c.background_color, c.file_protocol,
            c.startup_command, c.sftp_sudo_enabled, c.session_hosting_mode,
            (c.encrypted_sudo_password IS NOT NULL AND c.encrypted_sudo_password <> '') AS has_sudo_password,
            c.created_at, c.updated_at, c.last_connected_at,
            GROUP_CONCAT(ct.folder_id) as folder_ids_str
         FROM connections c
         LEFT JOIN connection_folders ct ON c.id = ct.connection_id
         WHERE c.id = ?
         GROUP BY c.id`;
    try {
        const db = await getDbInstance();
        const row = await getDbRow<ConnectionWithFoldersRow>(db, sql, [id]);
        if (row && typeof row.id !== 'undefined') {
            const { jump_chain: jumpChainStr, ...restOfRow } = row;
            return {
                ...restOfRow,
                folder_ids: row.folder_ids_str ? row.folder_ids_str.split(',').map(Number).filter(id => !isNaN(id)) : [],
                jump_chain: jumpChainStr ? JSON.parse(jumpChainStr) as number[] : null
            } as ConnectionWithFolders;
        } else {
            return null;
        }
    } catch (err: any) {
        console.error(`Repository: 查询连接 ${id} 时出错:`, err.message);
        throw new Error('获取连接信息失败');
    }
};

/**
 * 根据 ID 获取单个连接的完整信息 (包括加密字段和代理信息)
 */
export const findFullConnectionById = async (id: number): Promise<FullConnectionDbRow | null> => {
     const sql = `
         SELECT
             c.*, -- 选择 connections 表所有列 (包括 c.proxy_type)
             p.id as proxy_db_id, p.name as proxy_name, p.type as actual_proxy_server_type, -- Renamed p.type to avoid conflict
             p.host as proxy_host, p.port as proxy_port, p.username as proxy_username,
             p.encrypted_password as proxy_encrypted_password,
             p.encrypted_private_key as proxy_encrypted_private_key,
             p.encrypted_passphrase as proxy_encrypted_passphrase
          FROM connections c
          LEFT JOIN proxies p ON c.proxy_id = p.id
          WHERE c.id = ?`;
     try {
        const db = await getDbInstance();
        const row = await getDbRow<FullConnectionDbRow>(db, sql, [id]);
        return row || null;
     } catch (err: any) {
        console.error(`Repository: 查询连接 ${id} 详细信息时出错:`, err.message);
        throw new Error('获取连接详细信息失败');
     }
 };
 
 /**
  * 根据名称查找连接 (用于检查名称是否重复)
  */
 export const findConnectionByName = async (name: string): Promise<ConnectionBase | null> => {
     const sql = `SELECT id, name, type, host, port, username, auth_method, proxy_id, proxy_type, ssh_key_id, notes, jump_chain, background_color, file_protocol, startup_command, sftp_sudo_enabled, created_at, updated_at, last_connected_at FROM connections WHERE name = ?`;
     try {
         const db = await getDbInstance();
         const row = await getDbRow<ConnectionWithFoldersRow>(db, sql, [name]);
         if (row) {
             const { jump_chain: jumpChainStr, folder_ids_str, ...restOfRow } = row;
             return {
                 ...restOfRow,
             } as ConnectionBase;
         }
         return null;
     } catch (err: any) {
         console.error(`Repository: 查询连接名称 "${name}" 时出错:`, err.message);
         throw new Error('查找连接名称失败');
     }
 };
 
 
 /**
  * 创建新连接 (不处理文件夹)
  */
export const createConnection = async (data: Omit<FullConnectionData, 'id' | 'created_at' | 'updated_at' | 'last_connected_at' | 'folder_ids'>): Promise<number> => {
    console.log('[Repository:createConnection] Received data:', JSON.stringify(data, null, 2));
    const now = Math.floor(Date.now() / 1000);
    const uuid = (data as any).uuid || crypto.randomUUID();
    const sql = `
        INSERT INTO connections (uuid, name, type, host, port, username, auth_method, encrypted_password, encrypted_private_key, encrypted_passphrase, proxy_id, proxy_type, ssh_key_id, notes, jump_chain, background_color, file_protocol, startup_command, sftp_sudo_enabled, encrypted_sudo_password, session_hosting_mode, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    
    const jumpChainStringified = (data.jump_chain && data.jump_chain.length > 0) ? JSON.stringify(data.jump_chain) : null;
    console.log(`[Repository:createConnection] jump_chain input: ${JSON.stringify(data.jump_chain)}, stringified to: ${jumpChainStringified}`);

    const params = [
        uuid,
        data.name ?? null,
        data.type,
        data.host, data.port, data.username, data.auth_method,
        data.encrypted_password ?? null, data.encrypted_private_key ?? null, data.encrypted_passphrase ?? null,
        data.proxy_id ?? null,
        data.proxy_type ?? null,
        data.ssh_key_id ?? null,
        data.notes ?? null,
        jumpChainStringified,
        data.background_color ?? null,
        data.file_protocol ?? 'auto',
        data.startup_command ?? '',
        data.sftp_sudo_enabled ? 1 : 0,
        data.encrypted_sudo_password ?? null,
        data.session_hosting_mode === 'legacy' ? 'legacy' : 'auto',
        now, now
    ];
    console.log('[Repository:createConnection] SQL:', sql);
    console.log('[Repository:createConnection] Params:', JSON.stringify(params, null, 2));
    try {
        const db = await getDbInstance();
        const result = await runDb(db, sql, params);
        if (typeof result.lastID !== 'number' || result.lastID <= 0) {
             throw new Error('创建连接后未能获取有效的 lastID');
        }
        return result.lastID;
    } catch (err: any) {
        console.error('Repository: 插入连接时出错:', err.message);
        throw new Error('创建连接记录失败');
    }
};

/**
 * 更新连接信息 (不处理文件夹)
 */
// Update input type to reflect FullConnectionData now has 'type' and 'jump_chain'
export const updateConnection = async (id: number, data: Partial<Omit<FullConnectionData, 'id' | 'created_at' | 'last_connected_at' | 'folder_ids'>>): Promise<boolean> => {
    const fieldsToUpdate: { [key: string]: any } = { ...data };
    const params: any[] = [];

    delete fieldsToUpdate.id;
    delete fieldsToUpdate.created_at;
    delete fieldsToUpdate.last_connected_at;
    delete fieldsToUpdate.folder_ids;

    fieldsToUpdate.updated_at = Math.floor(Date.now() / 1000);

    const setClauses = Object.keys(fieldsToUpdate).map(key => `${key} = ?`).join(', ');
    
    Object.keys(fieldsToUpdate).forEach(key => {
        const K = key as keyof typeof fieldsToUpdate;
        const value = fieldsToUpdate[K];
        if (K === 'jump_chain') {
            const jumpChainValue = value as number[] | null;
            const jumpChainStringified = (jumpChainValue && jumpChainValue.length > 0) ? JSON.stringify(jumpChainValue) : null;
            params.push(jumpChainStringified);
        } else {
            params.push(value ?? null);
        }
    });

    if (!setClauses) {
        console.warn(`[Repository] updateConnection called for ID ${id} with no fields to update.`);
        return false;
    }

    params.push(id);
    const sql = `UPDATE connections SET ${setClauses} WHERE id = ?`;


    try {
        const db = await getDbInstance();
        const result = await runDb(db, sql, params);
        return result.changes > 0;
    } catch (err: any) {
        console.error(`Repository: 更新连接 ${id} 时出错:`, err.message);
        throw new Error('更新连接记录失败');
    }
};


/**
 * 删除连接
 */
export const deleteConnection = async (id: number): Promise<boolean> => {
    try {
        const db = await getDbInstance();
        // 双重保险：显式级联清理关联的文件颜色高亮设置
        try {
            await runDb(db, `DELETE FROM file_color_highlights WHERE connection_id = ?`, [id]);
        } catch (colorCleanErr: any) {
            console.warn(`Repository: 尝试清理连接 ${id} 的 file_color_highlights 时提示:`, colorCleanErr.message);
        }

        const sql = `DELETE FROM connections WHERE id = ?`;
        const result = await runDb(db, sql, [id]);
        return result.changes > 0;
    } catch (err: any) {
        console.error(`Repository: 删除连接 ${id} 时出错:`, err.message);
        throw new Error('删除连接记录失败');
    }
};

/**
 * 更新指定连接的 last_connected_at 时间戳
 * @param id 连接 ID
 * @param timestamp Unix 时间戳 (秒)
 */
export const updateLastConnected = async (id: number, timestamp: number): Promise<boolean> => {
    const sql = `UPDATE connections SET last_connected_at = ? WHERE id = ?`;
    try {
        const db = await getDbInstance();
        const result = await runDb(db, sql, [timestamp, id]);
        if (result.changes === 0) {
            console.warn(`[Repository] updateLastConnected: No connection found with ID ${id} to update.`);
        }
        return result.changes > 0;
    } catch (err: any) {
        console.error(`Repository: 更新连接 ${id} 的 last_connected_at 时出错:`, err.message);
        throw new Error('更新上次连接时间失败');
    }
};

/**
 * 更新连接的文件夹关联 (使用事务)
 * @param connectionId 连接 ID
 * @param folderIds 新的文件夹 ID 数组 (空数组表示清除所有文件夹)
 */
export const updateConnectionFolders = async (connectionId: number, folderIds: number[]): Promise<boolean> => { // 修改返回类型为 boolean
    const db = await getDbInstance();

    // 1. 检查连接是否存在
    try {
        const connectionExists = await getDbRow<{ id: number }>(db, `SELECT id FROM connections WHERE id = ?`, [connectionId]);
        if (!connectionExists) {
            console.warn(`Repository: updateConnectionFolders - Connection with ID ${connectionId} not found.`);
            return false; // 连接不存在，返回 false
        }
    } catch (checkErr: any) {
         console.error(`Repository: 检查连接 ${connectionId} 是否存在时出错:`, checkErr.message);
         throw new Error('检查连接是否存在时失败'); // 抛出检查错误
    }


    // 2. 执行文件夹更新事务
    try {
        await runDb(db, 'BEGIN TRANSACTION');

        // 删除旧关联
        await runDb(db, `DELETE FROM connection_folders WHERE connection_id = ?`, [connectionId]);

        // 插入新关联 (如果 folderIds 不为空)
        if (folderIds.length > 0) {
            const insertSql = `INSERT INTO connection_folders (connection_id, folder_id) VALUES (?, ?)`;
            // 过滤无效 ID
            const validFolderIds = folderIds.filter(folderId => typeof folderId === 'number' && folderId > 0);

            // 使用 Promise.all 确保所有插入完成或失败
            const insertPromises = validFolderIds.map(folderId =>
                 runDb(db, insertSql, [connectionId, folderId])
            );
             // 如果任何插入失败，Promise.all 会 reject，错误会被下面的 catch 捕获
            await Promise.all(insertPromises);
        }

        await runDb(db, 'COMMIT');
        return true; // 事务成功提交，返回 true
    } catch (err: any) {
        console.error(`Repository: 更新连接 ${connectionId} 的文件夹关联事务出错:`, err.message);
        try {
            await runDb(db, 'ROLLBACK');
            console.log(`Repository: Transaction rolled back for connection ${connectionId} folder update.`);
        } catch (rollbackErr: any) {
            console.error(`Repository: 回滚连接 ${connectionId} 的文件夹更新事务失败:`, rollbackErr.message);
            // 即使回滚失败，原始错误也更重要
        }
        // 直接重新抛出原始事务错误，让上层处理
        // SQLite 在事务中遇到错误时通常会自动回滚
        throw err;
    }
};

/**
 * 查找指定连接的所有文件夹
 * @param connectionId 连接 ID
 * @returns 文件夹对象数组 { id: number, name: string }[]
 */
export const findConnectionFolders = async (connectionId: number): Promise<{ id: number, name: string }[]> => {
    const sql = `
        SELECT t.id, t.name
        FROM folders t
        JOIN connection_folders ct ON t.id = ct.folder_id
        WHERE ct.connection_id = ?`;
    try {
        const db = await getDbInstance();
        const rows = await allDb<{ id: number, name: string }>(db, sql, [connectionId]);
        return rows;
    } catch (err: any) {
        console.error(`Repository: 查询连接 ${connectionId} 的文件夹时出错:`, err.message);
        throw new Error('获取连接文件夹失败');
    }
};

/**
 * 批量插入连接（用于导入）
 * 注意：此函数应在事务中调用 (由调用者负责事务)
 */
export const bulkInsertConnections = async (
    db: Database,
    // Update input type to reflect FullConnectionData now has 'type'
    connections: Array<Omit<FullConnectionData, 'id' | 'created_at' | 'updated_at' | 'last_connected_at'> & { folder_ids?: number[] }>
): Promise<{ connectionId: number, originalData: any }[]> => {

    const insertConnSql = `INSERT INTO connections (name, type, host, port, username, auth_method, encrypted_password, encrypted_private_key, encrypted_passphrase, proxy_id, proxy_type, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`; // Add type, proxy_type and notes columns and placeholders
    const results: { connectionId: number, originalData: any }[] = [];
    const now = Math.floor(Date.now() / 1000);

    for (const connData of connections) {
        const params = [
            connData.name ?? null, connData.type, connData.host, connData.port, connData.username, connData.auth_method, // Add type parameter
            connData.encrypted_password || null,
            connData.encrypted_private_key || null,
            connData.encrypted_passphrase || null,
            connData.proxy_id || null,
            connData.proxy_type || null, // Add proxy_type parameter
connData.notes || null, // Add notes parameter
            now, now
        ];
        try {
            const connResult = await runDb(db, insertConnSql, params);
            if (typeof connResult.lastID !== 'number' || connResult.lastID <= 0) {
                 throw new Error(`插入连接 "${connData.name}" 后未能获取有效的 lastID`);
            }
            results.push({ connectionId: connResult.lastID, originalData: connData });
        } catch (err: any) {
             console.error(`Repository: 批量插入连接 "${connData.name}" 时出错: ${err.message}`);
             throw new Error(`批量插入连接 "${connData.name}" 失败`);
        }
    }
    return results;
};

/**
 * 为多个连接添加同一个文件夹 (使用事务)
 * @param connectionIds 连接 ID 数组
 * @param folderId 要添加的文件夹 ID
 */
export const addFolderToMultipleConnections = async (connectionIds: number[], folderId: number): Promise<void> => {
    if (connectionIds.length === 0 || typeof folderId !== 'number' || folderId <= 0) {
        console.warn('[Repository] addFolderToMultipleConnections called with empty connectionIds or invalid folderId.');
        return; // 无需操作
    }

    const db = await getDbInstance();
    try {
        await runDb(db, 'BEGIN TRANSACTION');

        const insertSql = `INSERT OR IGNORE INTO connection_folders (connection_id, folder_id) VALUES (?, ?)`;
        // 使用 Promise.all 确保所有插入完成或失败
        const insertPromises = connectionIds.map(connId =>
            runDb(db, insertSql, [connId, folderId])
        );
        await Promise.all(insertPromises);

        await runDb(db, 'COMMIT');
    } catch (err: any) {
        console.error(`Repository: 为多个连接添加文件夹 ${folderId} 时事务出错:`, err.message);
        try {
            await runDb(db, 'ROLLBACK');
        } catch (rollbackErr: any) {
            console.error(`Repository: 回滚为多个连接添加文件夹 ${folderId} 的事务失败:`, rollbackErr.message);
        }
        throw new Error(`为多个连接添加文件夹失败: ${err.message}`);
    }
};
