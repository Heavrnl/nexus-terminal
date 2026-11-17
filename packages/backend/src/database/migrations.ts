import { Database } from 'sqlite3';
import crypto from 'crypto';

/**
 * 根据文件夹名称生成全局确定性的 UUID v5 (基于 SHA-1 与固定命名空间)
 * 保证相同名称的文件夹在任何设备、任何时点生成的 UUID 完全一致，天然自动合并
 */
export function generateDeterministicFolderUuid(name: string): string {
    const normalized = (name || '').trim().toLowerCase();
    // ⚠️ 命名空间字符串保持 'nexus-tag-ns:' 不能改：它是 uuid 的输入，一改所有已有文件夹的 uuid 都会变，
    // 跨端按 uuid 对齐会全部错位。标识符改名不动这串常量。
    const hash = crypto.createHash('sha1').update('nexus-tag-ns:' + normalized, 'utf8').digest('hex');
    const p1 = hash.substring(0, 8);
    const p2 = hash.substring(8, 12);
    const p3 = '5' + hash.substring(13, 16); // Version 5
    const p4 = ((parseInt(hash.substring(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') + hash.substring(18, 20); // RFC4122 variant
    const p5 = hash.substring(20, 32);
    return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

/**
 * 根据设置项 key 生成全局确定性 UUID v5
 * 确保两端相同的设置项具有绝对一致的 UUID
 */
export function generateDeterministicSettingUuid(key: string): string {
    const normalized = (key || '').trim();
    const hash = crypto.createHash('sha1').update('nexus-setting-ns:' + normalized, 'utf8').digest('hex');
    const p1 = hash.substring(0, 8);
    const p2 = hash.substring(8, 12);
    const p3 = '5' + hash.substring(13, 16);
    const p4 = ((parseInt(hash.substring(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') + hash.substring(18, 20);
    const p5 = hash.substring(20, 32);
    return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

// 1. 定义 migrations 表 SQL
const createMigrationsTableSQL = `
CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY, -- 迁移的版本号
    name TEXT NOT NULL,     -- 迁移的描述性名称
    applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')) -- 应用迁移的时间戳
);
`;

// 2. 定义迁移列表
interface Migration {
    id: number;
    name: string;
    sql: string; // 可以是多条 SQL 语句，用 ; 分隔。db.exec 会处理。
    check?: (db: Database) => Promise<boolean>; // 可选的前置检查函数
    execute?: (db: Database) => Promise<void>;  // 可选的附加执行函数
}

// 辅助函数：检查表是否存在
const tableExists = async (db: Database, tableName: string): Promise<boolean> => {
    return new Promise((resolve, reject) => {
        db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [tableName], (err, row) => {
            if (err) reject(err);
            else resolve(!!row);
        });
    });
};

// 辅助函数：检查列是否存在
const columnExists = async (db: Database, tableName: string, columnName: string): Promise<boolean> => {
    return new Promise((resolve, reject) => {
        db.all(`PRAGMA table_info(${tableName})`, (err, columns: any[]) => {
            if (err) reject(err);
            else resolve(columns.some(col => col.name === columnName));
        });
    });
};

// 辅助函数：获取表的创建 SQL
const getTableCreateSQL = async (db: Database, tableName: string): Promise<string | null> => {
    return new Promise((resolve, reject) => {
        db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [tableName], (err, row: any) => {
            if (err) reject(err);
            else resolve(row ? row.sql : null);
        });
    });
};


const definedMigrations: Migration[] = [
    {
        id: 1,
        name: 'Add ssh_keys table and update connections table for SSH key management',
        check: async (db: Database): Promise<boolean> => {
            const sshKeysTableExists = await tableExists(db, 'ssh_keys');
            const connectionsTableExists = await tableExists(db, 'connections'); // 确保 connections 表存在再检查列
            const sshKeyIdColumnExists = connectionsTableExists ? await columnExists(db, 'connections', 'ssh_key_id') : false;
            // 如果 ssh_keys 表不存在 或 connections 表的 ssh_key_id 列不存在，则需要运行迁移
            return !sshKeysTableExists || !sshKeyIdColumnExists;
        },
        sql: `
            -- 创建 ssh_keys 表 (使用 IF NOT EXISTS 保证幂等性)
            CREATE TABLE IF NOT EXISTS ssh_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                encrypted_private_key TEXT NOT NULL,
                encrypted_passphrase TEXT NULL,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );

            -- 为 connections 表添加 ssh_key_id 列及外键 (如果列不存在)
            -- 注意: 直接 ALTER TABLE 添加列在列已存在时会抛出 "duplicate column name" 错误。
            --       迁移运行器 (runMigrations) 已配置为忽略此特定错误。
            ALTER TABLE connections ADD COLUMN ssh_key_id INTEGER NULL REFERENCES ssh_keys(id) ON DELETE SET NULL;

            -- 可选: 对旧数据进行清理或更新
            -- UPDATE connections SET encrypted_private_key = NULL WHERE encrypted_private_key = ''; -- 示例
            -- UPDATE connections SET encrypted_passphrase = NULL WHERE encrypted_passphrase = ''; -- 示例
        `
    },
    // --- Quick Command Tags Migrations ---
    {
        id: 2,
        name: 'Create quick_command_folders table',
        check: async (db: Database): Promise<boolean> => {
            const tableAlreadyExists = await tableExists(db, 'quick_command_folders');
            return !tableAlreadyExists; // Only run if the table does NOT exist
        },
        sql: `
            CREATE TABLE IF NOT EXISTS quick_command_folders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );
        `
    },
    {
        id: 3,
        name: 'Create quick_command_folder_associations table',
        check: async (db: Database): Promise<boolean> => {
            const tableAlreadyExists = await tableExists(db, 'quick_command_folder_associations');
            return !tableAlreadyExists; // Only run if the table does NOT exist
        },
        sql: `
            CREATE TABLE IF NOT EXISTS quick_command_folder_associations (
                quick_command_id INTEGER NOT NULL,
                folder_id INTEGER NOT NULL,
                PRIMARY KEY (quick_command_id, folder_id),
                FOREIGN KEY (quick_command_id) REFERENCES quick_commands(id) ON DELETE CASCADE,
                FOREIGN KEY (folder_id) REFERENCES quick_command_folders(id) ON DELETE CASCADE
            );
        `
    }
,
{
        id: 4,
        name: 'Add notes column to connections table',
        check: async (db: Database): Promise<boolean> => {
            const notesColumnExists = await columnExists(db, 'connections', 'notes');
            return !notesColumnExists;
        },
        sql: `
            -- Add the notes column to the connections table, allowing NULL values
            ALTER TABLE connections ADD COLUMN notes TEXT NULL;
        `
    },
    {
        id: 5,
        name: 'Update connections table to allow VNC type in CHECK constraint',
        check: async (db: Database): Promise<boolean> => {
            const createSQL = await getTableCreateSQL(db, 'connections');
            if (createSQL) {
                // 检查 CHECK 约束是否已经包含了 VNC
                // 这会检查 'VNC' 是否是允许的类型之一
                // 例如: CHECK(type IN ('SSH', 'RDP', 'VNC'))
                const constraintRegex = /CHECK\s*\(\s*LOWER\(type\)\s+IN\s*\(([^)]+)\)\s*\)/i; // 兼容大小写不敏感的检查
                const constraintRegexStrict = /CHECK\s*\(\s*type\s+IN\s*\(([^)]+)\)\s*\)/i;
                
                let match = createSQL.match(constraintRegex);
                if (!match) {
                    match = createSQL.match(constraintRegexStrict);
                }

                if (match && match[1]) {
                    const allowedTypes = match[1].split(',').map(t => t.trim().replace(/'/g, "").toLowerCase());
                    return !allowedTypes.includes('vnc'); // 如果 'vnc' 不在允许类型中，则需要运行迁移
                }
                // 如果没有找到明确的 CHECK 约束或格式不匹配，保守地运行迁移
                console.warn('[Migrations] Check for VNC in connections.type: Could not parse CHECK constraint from SQL. Assuming migration is needed.');
                return true;
            }
            console.warn('[Migrations] Check for VNC in connections.type: Could not get table create SQL. Assuming migration is needed.');
            return true; // 如果表不存在或无法获取 SQL，则运行迁移
        },
        sql: `
            PRAGMA foreign_keys=off;

            -- 步骤 1: 重命名旧表
            ALTER TABLE connections RENAME TO connections_old_for_vnc_constraint_update;
            ALTER TABLE connection_folders RENAME TO connection_folders_old_for_vnc_constraint_update;

            -- 步骤 2: 创建新表 (与 schema.ts 中的定义一致)
            CREATE TABLE connections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NULL,
                type TEXT NOT NULL CHECK(type IN ('SSH', 'RDP', 'VNC')) DEFAULT 'SSH',
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                username TEXT NOT NULL,
                auth_method TEXT NOT NULL CHECK(auth_method IN ('password', 'key')),
                encrypted_password TEXT NULL,
                encrypted_private_key TEXT NULL,
                encrypted_passphrase TEXT NULL,
                proxy_id INTEGER NULL,
                ssh_key_id INTEGER NULL,
                notes TEXT NULL,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                last_connected_at INTEGER NULL,
                FOREIGN KEY (proxy_id) REFERENCES proxies(id) ON DELETE SET NULL,
                FOREIGN KEY (ssh_key_id) REFERENCES ssh_keys(id) ON DELETE SET NULL
            );

            CREATE TABLE connection_folders (
                connection_id INTEGER NOT NULL,
                folder_id INTEGER NOT NULL,
                PRIMARY KEY (connection_id, folder_id),
                FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE,
                FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
            );

            -- 步骤 3: 从旧表复制数据到新表
            INSERT INTO connections (
                id, name, type, host, port, username, auth_method,
                encrypted_password, encrypted_private_key, encrypted_passphrase,
                proxy_id, ssh_key_id, notes, created_at, updated_at, last_connected_at
            )
            SELECT
                id, name,
                CASE
                    WHEN UPPER(type) = 'RDP' THEN 'RDP'
                    WHEN UPPER(type) = 'SSH' THEN 'SSH'
                    WHEN UPPER(type) = 'VNC' THEN 'VNC'
                    ELSE 'SSH'
                END,
                host, port, username, auth_method,
                encrypted_password, encrypted_private_key, encrypted_passphrase,
                proxy_id, ssh_key_id, notes, created_at, updated_at, last_connected_at
            FROM connections_old_for_vnc_constraint_update;

            INSERT INTO connection_folders (connection_id, folder_id)
            SELECT connection_id, folder_id FROM connection_folders_old_for_vnc_constraint_update;

            -- 步骤 4: 删除旧表
            DROP TABLE connections_old_for_vnc_constraint_update;
            DROP TABLE connection_folders_old_for_vnc_constraint_update;

            PRAGMA foreign_keys=on;

            ANALYZE; -- 重新分析数据库模式
        `
    },
    {
        id: 6,
        name: 'Create passkeys table for WebAuthn credentials',
        check: async (db: Database): Promise<boolean> => {
            const passkeysTableAlreadyExists = await tableExists(db, 'passkeys');
            return !passkeysTableAlreadyExists;
        },
        sql: `
            CREATE TABLE IF NOT EXISTS passkeys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                credential_id TEXT UNIQUE NOT NULL, -- Base64URL encoded
                public_key TEXT NOT NULL, -- COSE public key, stored as Base64URL or HEX
                counter INTEGER NOT NULL,
                transports TEXT, -- JSON array of transports e.g. ["usb", "nfc", "ble", "internal"]
                name TEXT NULL, -- User-friendly name for the passkey
                backed_up BOOLEAN NOT NULL DEFAULT FALSE, -- Stored as 0 or 1
                last_used_at INTEGER NULL,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
        `
    },
    {
        id: 7,
        name: 'Create path_history table',
        check: async (db: Database): Promise<boolean> => {
            const tableAlreadyExists = await tableExists(db, 'path_history');
            return !tableAlreadyExists;
        },
        sql: `
            CREATE TABLE IF NOT EXISTS path_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT NOT NULL,
                timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );
        `
    },
    {
        id: 8,
        name: 'Create favorite_paths table',
        check: async (db: Database): Promise<boolean> => {
            const tableAlreadyExists = await tableExists(db, 'favorite_paths');
            return !tableAlreadyExists; // Only run if the table does NOT exist
        },
        sql: `
            CREATE TABLE IF NOT EXISTS favorite_paths (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NULL,
                path TEXT NOT NULL,
                last_used_at INTEGER NULL;
                created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );
        `
    },
    {
        id: 9,
        name: 'Add jump_chain and proxy_type columns to connections table',
        sql: `
            ALTER TABLE connections ADD COLUMN jump_chain TEXT NULL;
            ALTER TABLE connections ADD COLUMN proxy_type TEXT NULL;
        `,
        check: async (db: Database): Promise<boolean> => {
            const jumpChainColumnExists = await columnExists(db, 'connections', 'jump_chain');
            const proxyTypeColumnExists = await columnExists(db, 'connections', 'proxy_type');
            return !jumpChainColumnExists || !proxyTypeColumnExists;
        }
    },
    {
        id: 10,
        name: 'Add variables column to quick_commands table',
        check: async (db: Database): Promise<boolean> => {
            const columnAlreadyExists = await columnExists(db, 'quick_commands', 'variables');
            return !columnAlreadyExists;
        },
        sql: `
            ALTER TABLE quick_commands ADD COLUMN variables TEXT NULL;
        `
    },
    {
        id: 11,
        name: 'Add background_color column to connections table',
        check: async (db: Database): Promise<boolean> => {
            const columnAlreadyExists = await columnExists(db, 'connections', 'background_color');
            return !columnAlreadyExists;
        },
        sql: `
            ALTER TABLE connections ADD COLUMN background_color TEXT NULL;
        `
    },
    {
        id: 12,
        name: 'Create workspace_sync table for real-time cloud workspace sync',
        check: async (db: Database): Promise<boolean> => {
            const tableAlreadyExists = await tableExists(db, 'workspace_sync');
            return !tableAlreadyExists;
        },
        sql: `
            CREATE TABLE IF NOT EXISTS workspace_sync (
                user_id INTEGER PRIMARY KEY NOT NULL,
                state TEXT NOT NULL DEFAULT '{}',
                active_client_id TEXT NULL,
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
        `
    },
    {
        id: 13,
        name: 'Add uuid column to syncable entities and create sync_tombstones table',
        check: async (db: Database): Promise<boolean> => {
            const tombstonesExists = await tableExists(db, 'sync_tombstones');
            const connUuidExists = await columnExists(db, 'connections', 'uuid');
            return !tombstonesExists || !connUuidExists;
        },
        sql: `
            -- 1. 创建删除墓碑表 (记录被删除的实体，防止跨端同步逆向复活)
            CREATE TABLE IF NOT EXISTS sync_tombstones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_type TEXT NOT NULL,
                uuid TEXT NOT NULL,
                deleted_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );
            CREATE INDEX IF NOT EXISTS idx_sync_tombstones_type_uuid ON sync_tombstones(entity_type, uuid);

            -- 2. 为各核心实体表添加 uuid 字段 (如果尚未存在)
            ALTER TABLE connections ADD COLUMN uuid TEXT NULL;
            ALTER TABLE proxies ADD COLUMN uuid TEXT NULL;
            ALTER TABLE ssh_keys ADD COLUMN uuid TEXT NULL;
            ALTER TABLE folders ADD COLUMN uuid TEXT NULL;
            ALTER TABLE quick_commands ADD COLUMN uuid TEXT NULL;

            -- 3. 创建 UUID 索引
            CREATE INDEX IF NOT EXISTS idx_connections_uuid ON connections(uuid);
            CREATE INDEX IF NOT EXISTS idx_proxies_uuid ON proxies(uuid);
            CREATE INDEX IF NOT EXISTS idx_ssh_keys_uuid ON ssh_keys(uuid);
            CREATE INDEX IF NOT EXISTS idx_folders_uuid ON folders(uuid);
            CREATE INDEX IF NOT EXISTS idx_quick_commands_uuid ON quick_commands(uuid);

            -- 4. 为已存在的数据补齐标准 UUID v4
            UPDATE connections SET uuid = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))) WHERE uuid IS NULL OR uuid = '';
            UPDATE proxies SET uuid = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))) WHERE uuid IS NULL OR uuid = '';
            UPDATE ssh_keys SET uuid = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))) WHERE uuid IS NULL OR uuid = '';
            UPDATE folders SET uuid = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))) WHERE uuid IS NULL OR uuid = '';
            UPDATE quick_commands SET uuid = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))) WHERE uuid IS NULL OR uuid = '';
        `
    },
    {
        id: 14,
        name: 'Implement Sync v2 schema with sync_state, sync_changes, pending_references, updated_hlc and deterministic folders',
        check: async (db: Database): Promise<boolean> => {
            const syncStateExists = await tableExists(db, 'sync_state');
            const connHlcExists = await columnExists(db, 'connections', 'updated_hlc');
            return !syncStateExists || !connHlcExists;
        },
        sql: `
            -- 1. 创建同步状态控制表
            CREATE TABLE IF NOT EXISTS sync_state (
                id               INTEGER PRIMARY KEY CHECK (id = 1),
                device_id        TEXT    NOT NULL,
                hlc_ms           INTEGER NOT NULL DEFAULT 0,
                hlc_ctr          INTEGER NOT NULL DEFAULT 0,
                applying         INTEGER NOT NULL DEFAULT 0,
                enabled          INTEGER NOT NULL DEFAULT 0,
                push_cursor      INTEGER NOT NULL DEFAULT 0,
                pull_cursor      INTEGER NOT NULL DEFAULT 0,
                min_valid_cursor INTEGER NOT NULL DEFAULT 0
            );

            -- 2. 创建增量变更日志表
            CREATE TABLE IF NOT EXISTS sync_changes (
                seq    INTEGER PRIMARY KEY AUTOINCREMENT,
                tbl    TEXT NOT NULL,
                row_id TEXT NOT NULL,
                op     TEXT NOT NULL CHECK (op IN ('U','D')),
                origin TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_sync_changes_seq ON sync_changes(seq);
            CREATE INDEX IF NOT EXISTS idx_sync_changes_row ON sync_changes(tbl, row_id);

            -- 3. 升级墓碑表为规范结构 (支持复合主键与 HLC)
            CREATE TABLE IF NOT EXISTS sync_tombstones_v2 (
                tbl         TEXT NOT NULL,
                row_id      TEXT NOT NULL,
                deleted_hlc TEXT NOT NULL DEFAULT '',
                deleted_at  INTEGER NOT NULL,
                PRIMARY KEY (tbl, row_id)
            );
            INSERT OR IGNORE INTO sync_tombstones_v2 (tbl, row_id, deleted_hlc, deleted_at)
                SELECT entity_type, uuid, printf('%013d-00000-migrated', deleted_at * 1000), deleted_at * 1000 
                FROM sync_tombstones;
            DROP TABLE IF EXISTS sync_tombstones;
            ALTER TABLE sync_tombstones_v2 RENAME TO sync_tombstones;

            -- 4. 创建待解析引用挂起表 (拓扑缝合)
            CREATE TABLE IF NOT EXISTS sync_pending_references (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                child_tbl   TEXT NOT NULL,
                child_uuid  TEXT NOT NULL,
                fk_field    TEXT NOT NULL,
                target_tbl  TEXT NOT NULL,
                target_uuid TEXT NOT NULL,
                created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );
            CREATE INDEX IF NOT EXISTS idx_pending_target ON sync_pending_references(target_tbl, target_uuid);

            -- 5. 为同步核心资产表补齐 updated_hlc 列
            ALTER TABLE connections ADD COLUMN updated_hlc TEXT NOT NULL DEFAULT '';
            ALTER TABLE proxies ADD COLUMN updated_hlc TEXT NOT NULL DEFAULT '';
            ALTER TABLE ssh_keys ADD COLUMN updated_hlc TEXT NOT NULL DEFAULT '';
            ALTER TABLE folders ADD COLUMN updated_hlc TEXT NOT NULL DEFAULT '';
            ALTER TABLE quick_commands ADD COLUMN updated_hlc TEXT NOT NULL DEFAULT '';
            ALTER TABLE quick_command_folders ADD COLUMN updated_hlc TEXT NOT NULL DEFAULT '';

            -- 6. 为 quick_command_folders 补齐 uuid 列与索引
            ALTER TABLE quick_command_folders ADD COLUMN uuid TEXT NULL;
            CREATE INDEX IF NOT EXISTS idx_quick_command_folders_uuid ON quick_command_folders(uuid);
            --    关联表的 folder_id 索引：这张表由迁移 #3 建出，必须在这里建（初始化阶段建会 no such table）
            CREATE INDEX IF NOT EXISTS idx_qc_folder_associations_folder_id ON quick_command_folder_associations(folder_id);
        `,
        execute: async (db: Database): Promise<void> => {
            // 7.1 初始化单行 sync_state
            const randomDeviceId = crypto.randomBytes(4).toString('hex');
            await new Promise<void>((resolve, reject) => {
                db.run(
                    `INSERT OR IGNORE INTO sync_state (id, device_id, hlc_ms, hlc_ctr, applying, enabled, push_cursor, pull_cursor, min_valid_cursor)
                     VALUES (1, ?, 0, 0, 0, 0, 0, 0, 0)`,
                    [randomDeviceId],
                    (err) => err ? reject(err) : resolve()
                );
            });

            // 获取有效 device_id
            let currentDeviceId = randomDeviceId;
            await new Promise<void>((resolve, reject) => {
                db.get(`SELECT device_id FROM sync_state WHERE id = 1`, (err, row: any) => {
                    if (err) return reject(err);
                    if (row?.device_id) currentDeviceId = row.device_id;
                    resolve();
                });
            });

            // 7.2 回填存量数据的 updated_hlc
            const tables = ['connections', 'proxies', 'ssh_keys', 'folders', 'quick_commands', 'quick_command_folders'];
            for (const tbl of tables) {
                await new Promise<void>((resolve, reject) => {
                    db.all(`SELECT id, updated_at FROM ${tbl} WHERE updated_hlc = ''`, async (err, rows: any[]) => {
                        if (err) return reject(err);
                        if (!rows || rows.length === 0) return resolve();
                        for (const r of rows) {
                            const ms = (r.updated_at && r.updated_at > 0) ? r.updated_at * 1000 : Date.now();
                            const hlc = `${String(ms).padStart(13, '0')}-00000-${currentDeviceId}`;
                            await new Promise<void>((resUpdate, rejUpdate) => {
                                db.run(`UPDATE ${tbl} SET updated_hlc = ? WHERE id = ?`, [hlc, r.id], (upErr) => upErr ? rejUpdate(upErr) : resUpdate());
                            });
                        }
                        resolve();
                    });
                });
            }

            // 7.3 存量 folders 确定性 UUID 刷新
            await new Promise<void>((resolve, reject) => {
                db.all(`SELECT id, name FROM folders`, async (err, rows: any[]) => {
                    if (err) return reject(err);
                    if (!rows || rows.length === 0) return resolve();
                    for (const r of rows) {
                        const detUuid = generateDeterministicFolderUuid(r.name);
                        await new Promise<void>((resTag, rejTag) => {
                            db.run(`UPDATE folders SET uuid = ? WHERE id = ?`, [detUuid, r.id], (upErr) => upErr ? rejTag(upErr) : resTag());
                        });
                    }
                    resolve();
                });
            });

            // 7.4 存量 quick_command_folders 确定性 UUID 刷新
            await new Promise<void>((resolve, reject) => {
                db.all(`SELECT id, name FROM quick_command_folders`, async (err, rows: any[]) => {
                    if (err) return reject(err);
                    if (!rows || rows.length === 0) return resolve();
                    for (const r of rows) {
                        const detUuid = generateDeterministicFolderUuid(r.name);
                        await new Promise<void>((resQTag, rejQTag) => {
                            db.run(`UPDATE quick_command_folders SET uuid = ? WHERE id = ?`, [detUuid, r.id], (upErr) => upErr ? rejQTag(upErr) : resQTag());
                        });
                    }
                    resolve();
                });
            });

            console.log('[Migrations] Migration 14: 确定性 UUID 与 updated_hlc 回填完成。');
        }
    },
    {
        id: 15,
        name: 'Add uuid and updated_hlc to settings table for sync engine',
        check: async (db: Database): Promise<boolean> => {
            const hasUuid = await columnExists(db, 'settings', 'uuid');
            const hasHlc = await columnExists(db, 'settings', 'updated_hlc');
            return !hasUuid || !hasHlc;
        },
        sql: `
            ALTER TABLE settings ADD COLUMN uuid TEXT NULL;
            ALTER TABLE settings ADD COLUMN updated_hlc TEXT NULL;
        `,
        execute: async (db: Database): Promise<void> => {
            await new Promise<void>((resolve, reject) => {
                db.all(`SELECT key FROM settings`, async (err, rows: any[]) => {
                    if (err) return reject(err);
                    if (!rows || rows.length === 0) return resolve();
                    for (const r of rows) {
                        const detUuid = generateDeterministicSettingUuid(r.key);
                        await new Promise<void>((res, rej) => {
                            db.run(
                                `UPDATE settings SET uuid = ?, updated_hlc = (SELECT printf('%013d-%05d-%s', hlc_ms, hlc_ctr, device_id) FROM sync_state WHERE id = 1) WHERE key = ?`,
                                [detUuid, r.key],
                                (upErr) => upErr ? rej(upErr) : res()
                            );
                        });
                    }
                    resolve();
                });
            });
            console.log('[Migrations] Migration 15: settings 表 uuid 与 updated_hlc 迁移完成。');
        }
    },
    {
        id: 16,
        name: 'Add background_color column to folders, quick_command_folders, and quick_commands tables',
        check: async (db: Database): Promise<boolean> => {
            const hasTagBg = await columnExists(db, 'folders', 'background_color');
            const hasQTagBg = await columnExists(db, 'quick_command_folders', 'background_color');
            const hasQCmdBg = await columnExists(db, 'quick_commands', 'background_color');
            return !hasTagBg || !hasQTagBg || !hasQCmdBg;
        },
        sql: `
            -- 安全添加 background_color 字段
        `,
        execute: async (db: Database): Promise<void> => {
            const hasTagBg = await columnExists(db, 'folders', 'background_color');
            if (!hasTagBg) {
                await new Promise<void>((resolve, reject) => {
                    db.run('ALTER TABLE folders ADD COLUMN background_color TEXT NULL', (err) => err ? reject(err) : resolve());
                });
            }
            const hasQTagBg = await columnExists(db, 'quick_command_folders', 'background_color');
            if (!hasQTagBg) {
                await new Promise<void>((resolve, reject) => {
                    db.run('ALTER TABLE quick_command_folders ADD COLUMN background_color TEXT NULL', (err) => err ? reject(err) : resolve());
                });
            }
            const hasQCmdBg = await columnExists(db, 'quick_commands', 'background_color');
            if (!hasQCmdBg) {
                await new Promise<void>((resolve, reject) => {
                    db.run('ALTER TABLE quick_commands ADD COLUMN background_color TEXT NULL', (err) => err ? reject(err) : resolve());
                });
            }
            console.log('[Migrations] Migration 16: folders, quick_command_folders, quick_commands background_color 字段迁移完成。');
        }
    },
    {
        id: 17,
        name: 'Add uuid and updated_hlc to command_history table for sync engine',
        check: async (db: Database): Promise<boolean> => {
            const hasUuid = await columnExists(db, 'command_history', 'uuid');
            const hasHlc = await columnExists(db, 'command_history', 'updated_hlc');
            return !hasUuid || !hasHlc;
        },
        sql: `
            -- 安全添加 uuid 和 updated_hlc
        `,
        execute: async (db: Database): Promise<void> => {
            const hasUuid = await columnExists(db, 'command_history', 'uuid');
            if (!hasUuid) {
                await new Promise<void>((resolve, reject) => {
                    db.run('ALTER TABLE command_history ADD COLUMN uuid TEXT NULL', (err) => err ? reject(err) : resolve());
                });
            }
            const hasHlc = await columnExists(db, 'command_history', 'updated_hlc');
            if (!hasHlc) {
                await new Promise<void>((resolve, reject) => {
                    db.run('ALTER TABLE command_history ADD COLUMN updated_hlc TEXT NULL', (err) => err ? reject(err) : resolve());
                });
            }
            // 回填存量没有 uuid 的 command_history
            await new Promise<void>((resolve, reject) => {
                db.all(`SELECT id FROM command_history WHERE uuid IS NULL OR uuid = ''`, async (err, rows: any[]) => {
                    if (err) return reject(err);
                    if (!rows || rows.length === 0) return resolve();
                    for (const r of rows) {
                        const newUuid = crypto.randomUUID();
                        await new Promise<void>((res, rej) => {
                            db.run(
                                `UPDATE command_history SET uuid = ?, updated_hlc = (SELECT printf('%013d-%05d-%s', hlc_ms, hlc_ctr, device_id) FROM sync_state WHERE id = 1) WHERE id = ?`,
                                [newUuid, r.id],
                                (upErr) => upErr ? rej(upErr) : res()
                            );
                        });
                    }
                    resolve();
                });
            });
            console.log('[Migrations] Migration 17: command_history 表 uuid 与 updated_hlc 迁移完成。');
        }
    },
    {
        id: 18,
        name: 'Deduplicate cloned command_history records by command and timestamp',
        check: async (db: Database): Promise<boolean> => {
            return new Promise<boolean>((resolve) => {
                db.get(
                    `SELECT 1 FROM command_history a WHERE EXISTS (SELECT 1 FROM command_history b WHERE b.command = a.command AND b.timestamp = a.timestamp AND b.id < a.id) LIMIT 1`,
                    (err, row) => {
                        if (err || !row) resolve(false);
                        else resolve(true);
                    }
                );
            });
        },
        sql: `-- 安全清理 command_history 相同 command 与 timestamp 的克隆副本`,
        execute: async (db: Database): Promise<void> => {
            await new Promise<void>((resolve, reject) => {
                db.serialize(() => {
                    db.run('UPDATE sync_state SET applying = 1 WHERE id = 1', () => {});
                    db.run(
                        'DELETE FROM command_history WHERE id NOT IN (SELECT min(id) FROM command_history GROUP BY command, timestamp)',
                        function (err) {
                            db.run('UPDATE sync_state SET applying = 0 WHERE id = 1', () => {});
                            if (err) {
                                console.error('[Migrations] Migration 18 去重清理失败:', err);
                                return reject(err);
                            }
                            console.log(`[Migrations] Migration 18: 成功清理 command_history 重复副本 ${this.changes} 条。`);
                            resolve();
                        }
                    );
                });
            });
        }
    },
    {
        id: 19,
        name: 'Create file_color_highlights table with cascade delete on connections',
        check: async (db: Database): Promise<boolean> => {
            return new Promise<boolean>((resolve) => {
                db.get(
                    `SELECT name FROM sqlite_master WHERE type='table' AND name='file_color_highlights'`,
                    (err, row) => {
                        if (err || !row) resolve(true);
                        else resolve(false);
                    }
                );
            });
        },
        sql: `
            CREATE TABLE IF NOT EXISTS file_color_highlights (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                connection_id INTEGER NOT NULL,
                path TEXT NOT NULL,
                color TEXT NOT NULL,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                uuid TEXT NULL,
                updated_hlc TEXT NULL,
                FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE,
                UNIQUE(connection_id, path)
            );
            CREATE INDEX IF NOT EXISTS idx_file_color_highlights_conn ON file_color_highlights(connection_id);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_file_color_highlights_conn_path ON file_color_highlights(connection_id, path);
        `,
        execute: async (db: Database): Promise<void> => {
            console.log('[Migrations] Migration 19: file_color_highlights 表及索引创建完成。');
        }
    },
    {
        id: 20,
        name: 'Add file_protocol column to connections table',
        check: async (db: Database): Promise<boolean> => {
            const exists = await columnExists(db, 'connections', 'file_protocol');
            return !exists;
        },
        sql: `
            ALTER TABLE connections ADD COLUMN file_protocol TEXT NOT NULL DEFAULT 'auto';
        `,
        execute: async (db: Database): Promise<void> => {
            await new Promise<void>((resolve, reject) => {
                db.run("UPDATE connections SET file_protocol = 'auto' WHERE file_protocol IS NULL OR file_protocol = ''", (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
            console.log('[Migrations] Migration 20: connections 表 file_protocol 字段迁移完成 (默认 auto)。');
        }
    },
    {
        id: 21,
        name: 'Add is_file column to favorite_paths table',
        check: async (db: Database): Promise<boolean> => {
            const exists = await columnExists(db, 'favorite_paths', 'is_file');
            return !exists;
        },
        sql: `
            ALTER TABLE favorite_paths ADD COLUMN is_file INTEGER NOT NULL DEFAULT 0;
        `,
        execute: async (db: Database): Promise<void> => {
            console.log('[Migrations] Migration 21: favorite_paths 表 is_file 字段迁移完成 (默认 0=目录)。');
        }
    },
    {
        id: 22,
        name: 'Add docker_exec_command column to connections table',
        check: async (db: Database): Promise<boolean> => {
            const exists = await columnExists(db, 'connections', 'docker_exec_command');
            return !exists;
        },
        sql: `
            ALTER TABLE connections ADD COLUMN docker_exec_command TEXT NOT NULL DEFAULT '';
        `,
        execute: async (db: Database): Promise<void> => {
            await new Promise<void>((resolve, reject) => {
                db.run("UPDATE connections SET docker_exec_command = '' WHERE docker_exec_command IS NULL", (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
            console.log('[Migrations] Migration 22: connections 表 docker_exec_command 字段迁移完成 (默认空=自动探测)。');
        }
    },
    {
        id: 23,
        name: 'Drop docker_exec_command column from connections table',
        check: async (db: Database): Promise<boolean> => {
            // 列还在才需要迁（新库直接 schema.ts 建表，本来就没有这列）
            return await columnExists(db, 'connections', 'docker_exec_command');
        },
        sql: `
            ALTER TABLE connections DROP COLUMN docker_exec_command;
        `,
        execute: async (db: Database): Promise<void> => {
            console.log('[Migrations] Migration 23: 已移除 connections.docker_exec_command —— 进容器命令改为按容器自动探测（shell 是容器级属性，连接级配置会错）。');
        }
    },
    {
        id: 24,
        name: 'Allow gotify channel type in notification_settings',
        check: async (db: Database): Promise<boolean> => {
            // SQLite 的 CHECK 约束改不了，只能重建表。老库建表 SQL 里没有 gotify 才需要重建；
            // 新库由 schema.ts 直接带上 gotify，拿到的是 null/已含 gotify → 跳过。
            const createSql = await getTableCreateSQL(db, 'notification_settings');
            if (!createSql) return false;
            return !/gotify/i.test(createSql);
        },
        sql: `
            ALTER TABLE notification_settings RENAME TO notification_settings_legacy;
            CREATE TABLE notification_settings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_type TEXT NOT NULL CHECK(channel_type IN ('webhook', 'email', 'telegram', 'gotify')),
                name TEXT NOT NULL DEFAULT '',
                enabled BOOLEAN NOT NULL DEFAULT false,
                config TEXT NOT NULL DEFAULT '{}',
                enabled_events TEXT NOT NULL DEFAULT '[]',
                created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );
            INSERT INTO notification_settings (id, channel_type, name, enabled, config, enabled_events, created_at, updated_at)
                SELECT id, channel_type, name, enabled, config, enabled_events, created_at, updated_at
                FROM notification_settings_legacy;
            DROP TABLE notification_settings_legacy;
        `,
        execute: async (db: Database): Promise<void> => {
            console.log('[Migrations] Migration 24: notification_settings 的 channel_type CHECK 已放开 gotify（重建表，原有渠道配置原样保留）。');
        }
    },
    {
        id: 25,
        name: 'Add uuid / updated_hlc columns to port_forwards for cross-device sync',
        check: async (db: Database): Promise<boolean> => {
            // 新库由 schema.ts 建表时就带上了；只有先在旧版本里建过 port_forwards 的库需要补列
            if (!(await tableExists(db, 'port_forwards'))) return false;
            return !(await columnExists(db, 'port_forwards', 'uuid'));
        },
        sql: `
            ALTER TABLE port_forwards ADD COLUMN uuid TEXT NULL;
            ALTER TABLE port_forwards ADD COLUMN updated_hlc TEXT NOT NULL DEFAULT '';
            CREATE INDEX IF NOT EXISTS idx_port_forwards_uuid ON port_forwards(uuid);
        `,
        execute: async (db: Database): Promise<void> => {
            // 补完列要回填 uuid，否则这些老规则永远进不了同步
            const rows = await new Promise<Array<{ id: number }>>((resolve, reject) => {
                db.all("SELECT id FROM port_forwards WHERE uuid IS NULL OR uuid = ''", (err, list: Array<{ id: number }>) => {
                    if (err) reject(err); else resolve(list || []);
                });
            });
            for (const row of rows) {
                await new Promise<void>((resolve, reject) => {
                    db.run('UPDATE port_forwards SET uuid = ? WHERE id = ?', [crypto.randomUUID(), row.id], err => {
                        if (err) reject(err); else resolve();
                    });
                });
            }
            console.log(`[Migrations] Migration 25: port_forwards 已补上 uuid / updated_hlc（回填 ${rows.length} 条），可参与双端同步。`);
        }
    },
    {
        id: 26,
        name: 'Add uuid / updated_hlc to appearance_settings, terminal_themes, favorite_paths for v2 sync',
        check: async (db: Database): Promise<boolean> => {
            // 新库由 schema.ts 建表时就带上了；只有旧库需要补列
            if (await tableExists(db, 'appearance_settings')) {
                if (!(await columnExists(db, 'appearance_settings', 'uuid'))) return true;
            }
            if (await tableExists(db, 'terminal_themes')) {
                if (!(await columnExists(db, 'terminal_themes', 'uuid'))) return true;
            }
            if (await tableExists(db, 'favorite_paths')) {
                if (!(await columnExists(db, 'favorite_paths', 'uuid'))) return true;
            }
            return false;
        },
        sql: `
            ALTER TABLE appearance_settings ADD COLUMN uuid TEXT NULL;
            ALTER TABLE appearance_settings ADD COLUMN updated_hlc TEXT NOT NULL DEFAULT '';
            CREATE INDEX IF NOT EXISTS idx_appearance_settings_uuid ON appearance_settings(uuid);
            ALTER TABLE terminal_themes ADD COLUMN uuid TEXT NULL;
            ALTER TABLE terminal_themes ADD COLUMN updated_hlc TEXT NOT NULL DEFAULT '';
            CREATE INDEX IF NOT EXISTS idx_terminal_themes_uuid ON terminal_themes(uuid);
            ALTER TABLE favorite_paths ADD COLUMN uuid TEXT NULL;
            ALTER TABLE favorite_paths ADD COLUMN updated_hlc TEXT NOT NULL DEFAULT '';
            CREATE INDEX IF NOT EXISTS idx_favorite_paths_uuid ON favorite_paths(uuid);
        `,
        execute: async (db: Database): Promise<void> => {
            // 补完列必须回填 uuid，否则这些老数据永远进不了同步。
            // uuid 用「业务主键」确定性生成（外观设置=key、主题=name、常用路径=path），
            // 这样两台机器上同名/同路径的记录会落到同一个 uuid 上，靠 HLC 判新旧，
            // 而不是各生成一个随机 id 变成两份重复数据。
            const hlcExpr = `(SELECT printf('%013d-%05d-%s', hlc_ms, hlc_ctr, device_id) FROM sync_state WHERE id = 1)`;

            const backfill = async (table: string, pkColumn: string, nsKey: (row: any) => string): Promise<number> => {
                if (!(await tableExists(db, table))) return 0;
                if (!(await columnExists(db, table, 'uuid'))) return 0;
                const rows = await new Promise<any[]>((resolve, reject) => {
                    db.all(`SELECT * FROM ${table} WHERE uuid IS NULL OR uuid = ''`, (err, list: any[]) => {
                        if (err) reject(err); else resolve(list || []);
                    });
                }).catch(() => [] as any[]);
                for (const row of rows) {
                    const uuid = generateDeterministicSettingUuid(nsKey(row));
                    await new Promise<void>((resolve, reject) => {
                        db.run(`UPDATE ${table} SET uuid = ?, updated_hlc = ${hlcExpr} WHERE ${pkColumn} = ?`, [uuid, row[pkColumn]], (err) => {
                            if (err) reject(err); else resolve();
                        });
                    });
                }
                return rows.length;
            };

            const a = await backfill('appearance_settings', 'key', (r) => `nexus-appearance:${r.key}`);
            const t = await backfill('terminal_themes', 'id', (r) => `nexus-theme:${r.name ?? r.id}`);
            const f = await backfill('favorite_paths', 'id', (r) => `nexus-favpath:${r.path ?? r.id}`);
            console.log(
                `[Migrations] Migration 26: 外观设置 ${a} 条 / 终端主题 ${t} 条 / 常用路径 ${f} 条 已补上 uuid，可参与 v2 增量同步。`
            );
        }
    },
    // ────────────────────────────────────────────────────────────────────────
    // #27 「标签」→「文件夹」改名收尾（表名/列名由 normalizeLegacyFolderSchema 在建表前处理）
    // 这里只做不依赖表结构的收尾：同步日志与墓碑里的表名、审计动作名、通知事件名、设置键。
    // 全部是幂等 UPDATE，重复跑不会二次破坏数据。
    // ────────────────────────────────────────────────────────────────────────
    {
        id: 27,
        name: 'Rename legacy tag identifiers to folder in sync log / audit / settings',
        check: async (): Promise<boolean> => true,
        sql: `SELECT 1;`,
        execute: async (db: Database): Promise<void> => {
            const exec = (sql: string, params: any[] = []): Promise<void> =>
                new Promise((resolve, reject) => {
                    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
                });

            const tableRenames: Array<[string, string]> = [
                ['tags', 'folders'],
                ['connection_tags', 'connection_folders'],
                ['quick_command_tags', 'quick_command_folders'],
                ['quick_command_tag_associations', 'quick_command_folder_associations'],
            ];

            // 1. v2 增量日志 / 墓碑 / 待解析引用里记的是表名，不改的话升级后这些变更再也认不出来
            if (await tableExists(db, 'sync_changes')) {
                for (const [from, to] of tableRenames) {
                    await exec('UPDATE sync_changes SET tbl = ? WHERE tbl = ?', [to, from]);
                }
            }
            if (await tableExists(db, 'sync_tombstones')) {
                for (const [from, to] of tableRenames) {
                    await exec('UPDATE sync_tombstones SET tbl = ? WHERE tbl = ?', [to, from]);
                }
            }
            if (await tableExists(db, 'sync_pending_references')) {
                for (const [from, to] of tableRenames) {
                    await exec('UPDATE sync_pending_references SET child_tbl = ? WHERE child_tbl = ?', [to, from]);
                    await exec('UPDATE sync_pending_references SET target_tbl = ? WHERE target_tbl = ?', [to, from]);
                }
            }

            // 2. 历史审计记录的动作名（老行不换名的话，界面上会退化成显示原始英文常量）
            if (await tableExists(db, 'audit_logs')) {
                await exec(
                    "UPDATE audit_logs SET action_type = REPLACE(action_type, 'TAG_', 'FOLDER_') WHERE action_type LIKE 'TAG\_%' ESCAPE '\\'"
                );
            }

            // 3. 通知渠道勾选的事件名是 JSON 数组，同样要把旧常量换掉
            if (await tableExists(db, 'notification_settings')) {
                for (const key of ['TAG_CREATED', 'TAG_UPDATED', 'TAG_DELETED']) {
                    await exec(
                        'UPDATE notification_settings SET enabled_events = REPLACE(enabled_events, ?, ?) WHERE enabled_events LIKE ?',
                        [`"${key}"`, `"${key.replace('TAG_', 'FOLDER_')}"`, `%"${key}"%`]
                    );
                }
            }

            // 4. 设置项 key：新 key 已存在时直接丢掉旧行，避免主键冲突也避免两份并存
            if (await tableExists(db, 'settings')) {
                const keyRenames: Array<[string, string]> = [
                    ['showConnectionTags', 'showConnectionFolders'],
                    ['showQuickCommandTags', 'showQuickCommandFolders'],
                ];
                for (const [from, to] of keyRenames) {
                    await exec(
                        'UPDATE settings SET key = ? WHERE key = ? AND NOT EXISTS (SELECT 1 FROM settings WHERE key = ?)',
                        [to, from, to]
                    );
                    await exec(
                        'DELETE FROM settings WHERE key = ? AND EXISTS (SELECT 1 FROM settings WHERE key = ?)',
                        [from, to]
                    );
                }
            }

            // 5. 索引名跟着表名走（SQLite 改表名不会改索引名）
            //    旧名字一律 DROP 掉再按新名字重建，避免「同列两份索引」这种残留
            const staleIndexes = ['idx_qc_tag_associations_tag_id', 'idx_qc_tag_associations_folder_id'];
            for (const stale of staleIndexes) {
                await exec(`DROP INDEX IF EXISTS ${stale}`);
            }
            const indexRenames: Array<[string, string, string]> = [
                ['idx_tags_uuid', 'idx_folders_uuid', 'folders(uuid)'],
                ['idx_quick_command_tags_uuid', 'idx_quick_command_folders_uuid', 'quick_command_folders(uuid)'],
                [
                    'idx_qc_tag_associations_tag_id',
                    'idx_qc_folder_associations_folder_id',
                    'quick_command_folder_associations(folder_id)',
                ],
            ];
            for (const [from, to, target] of indexRenames) {
                await exec(`DROP INDEX IF EXISTS ${from}`);
                if (await tableExists(db, target.slice(0, target.indexOf('(')))) {
                    await exec(`CREATE INDEX IF NOT EXISTS ${to} ON ${target}`);
                }
            }

            console.log('[Migrations] Migration 27: 旧「标签」标识已全部改写为「文件夹」。');
        }
    },

    // ── 收藏 / 历史路径的归属维度（28~30）────────────────────────────────────
    // 拆成三条独立迁移：`ALTER TABLE ... ADD COLUMN` 遇到 duplicate column 会中断整段 sql，
    // 每条只做一件事，各自的 check 才管得住，不会互相牵连。
    {
        id: 28,
        name: 'Add scope column to favorite_paths',
        check: async (db: Database): Promise<boolean> => {
            if (!(await tableExists(db, 'favorite_paths'))) return false;
            return !(await columnExists(db, 'favorite_paths', 'scope'));
        },
        sql: `
            ALTER TABLE favorite_paths ADD COLUMN scope TEXT NOT NULL DEFAULT 'global';
        `,
        execute: async (): Promise<void> => {
            console.log('[Migrations] Migration 28: favorite_paths.scope 已就绪（老数据一律为 global）。');
        }
    },
    {
        id: 29,
        name: 'Add connection_uuid column to favorite_paths',
        check: async (db: Database): Promise<boolean> => {
            if (!(await tableExists(db, 'favorite_paths'))) return false;
            return !(await columnExists(db, 'favorite_paths', 'connection_uuid'));
        },
        sql: `
            ALTER TABLE favorite_paths ADD COLUMN connection_uuid TEXT NULL;
            CREATE INDEX IF NOT EXISTS idx_favorite_paths_scope ON favorite_paths(scope, connection_uuid);
        `,
        execute: async (): Promise<void> => {
            console.log('[Migrations] Migration 29: favorite_paths.connection_uuid 已就绪。');
        }
    },
    {
        id: 30,
        name: 'Add connection_uuid column to path_history',
        check: async (db: Database): Promise<boolean> => {
            if (!(await tableExists(db, 'path_history'))) return false;
            return !(await columnExists(db, 'path_history', 'connection_uuid'));
        },
        sql: `
            ALTER TABLE path_history ADD COLUMN connection_uuid TEXT NULL;
            CREATE INDEX IF NOT EXISTS idx_path_history_conn ON path_history(connection_uuid, timestamp);
        `,
        execute: async (): Promise<void> => {
            console.log('[Migrations] Migration 30: path_history.connection_uuid 已就绪（老记录保持 NULL，不再出现）。');
        }
    },
    {
        id: 31,
        name: 'Add startup_command / sftp_sudo columns to connections',
        check: async (db: Database): Promise<boolean> => {
            if (!(await tableExists(db, 'connections'))) return false;
            // 三列任意一列缺失都要补，所以分开判、缺一列就整体走一遍（下面的 ALTER 逐条判断过）
            const hasStartup = await columnExists(db, 'connections', 'startup_command');
            const hasSudoEnabled = await columnExists(db, 'connections', 'sftp_sudo_enabled');
            const hasSudoPassword = await columnExists(db, 'connections', 'encrypted_sudo_password');
            return !(hasStartup && hasSudoEnabled && hasSudoPassword);
        },
        sql: 'SELECT 1;',
        execute: async (db: Database): Promise<void> => {
            // 逐列判断再加：一次跑一堆 ALTER 时，只要有一列已存在就会 duplicate column 中断整个脚本，
            // 后面的列永远补不上（这也是 schema.ts 与迁移必须各写一份、不能只改其一的原因）。
            const addColumn = async (name: string, ddl: string): Promise<void> => {
                if (await columnExists(db, 'connections', name)) return;
                await new Promise<void>((resolve, reject) => {
                    db.run(`ALTER TABLE connections ADD COLUMN ${ddl}`, (err) => (err ? reject(err) : resolve()));
                });
                console.log(`[Migrations] Migration 31: connections.${name} 已添加。`);
            };
            await addColumn('startup_command', "startup_command TEXT NOT NULL DEFAULT ''");
            // 默认开启：提权失败会自动降级到普通 SFTP，所以默认开是安全的
            await addColumn('sftp_sudo_enabled', 'sftp_sudo_enabled INTEGER NOT NULL DEFAULT 1');
            await addColumn('encrypted_sudo_password', 'encrypted_sudo_password TEXT NULL');
            console.log('[Migrations] Migration 31: connections 启动命令 / SFTP sudo 提权字段迁移完成。');
        }
    },
    {
        id: 32,
        name: 'Create user_oidc_links table for OIDC account binding',
        check: async (db: Database): Promise<boolean> => {
            return !(await tableExists(db, 'user_oidc_links'));
        },
        sql: `
            CREATE TABLE IF NOT EXISTS user_oidc_links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                provider_id TEXT NOT NULL,
                subject TEXT NOT NULL,
                email TEXT,
                issuer TEXT,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                last_login_at INTEGER,
                UNIQUE (provider_id, subject),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_user_oidc_links_user ON user_oidc_links(user_id);
        `,
        execute: async (): Promise<void> => {
            console.log('[Migrations] Migration 32: user_oidc_links 表已就绪（OIDC 账号绑定）。');
        }
    }

];

/**
 * 旧版的「标签」表名/列名 → 新的「文件夹」。
 *
 * 必须在 `runDatabaseInitializations` **之前**调用：
 *   - 新库：此时一张表都还没有，什么都不做，随后建表语句按新名字建出来；
 *   - 旧库：先把 tags / connection_tags / ... 原地改名，后面所有
 *     `CREATE TABLE IF NOT EXISTS` 都空转，历史迁移里的 `ALTER TABLE` 也继续作用在同一张表上
 *     （只是名字变了），不必把 1~26 号迁移的 SQL 整段重写。
 *
 * 幂等：只有「旧表在、新表不在」才改名；两边都在时把旧表并进新表再删掉旧表。
 */
export const normalizeLegacyFolderSchema = async (db: Database): Promise<void> => {
    const exec = (sql: string): Promise<void> =>
        new Promise((resolve, reject) => {
            db.exec(sql, (err) => (err ? reject(err) : resolve()));
        });

    const renamed: Array<{ from: string; to: string; columns: Array<[string, string]> }> = [
        { from: 'tags', to: 'folders', columns: [] },
        { from: 'connection_tags', to: 'connection_folders', columns: [['tag_id', 'folder_id']] },
        { from: 'quick_command_tags', to: 'quick_command_folders', columns: [] },
        {
            from: 'quick_command_tag_associations',
            to: 'quick_command_folder_associations',
            columns: [['tag_id', 'folder_id']],
        },
    ];

    for (const item of renamed) {
        if (!(await tableExists(db, item.from))) continue;

        if (!(await tableExists(db, item.to))) {
            await exec(`ALTER TABLE ${item.from} RENAME TO ${item.to};`);
            console.log(`[Migrations] 旧表 ${item.from} 已改名为 ${item.to}`);
        } else {
            // 两张表同时存在（正常不会出现）：把旧表里的行补进新表，再删旧表
            const cols = await new Promise<string[]>((resolve) => {
                db.all(`PRAGMA table_info(${item.from})`, (err, list: any[]) => {
                    resolve(err ? [] : (list || []).map((c) => String(c.name)));
                });
            });
            if (cols.length > 0) {
                const target = item.columns.reduce<string[]>(
                    (acc, [from, to]) => acc.map((c) => (c === from ? to : c)),
                    cols
                );
                await exec(
                    `INSERT OR IGNORE INTO ${item.to} (${target.map((c) => `"${c}"`).join(', ')}) ` +
                        `SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM ${item.from};`
                );
            }
            await exec(`DROP TABLE IF EXISTS ${item.from};`);
            console.log(`[Migrations] 旧表 ${item.from} 已并入 ${item.to} 并删除`);
        }

        for (const [fromCol, toCol] of item.columns) {
            const hasOldCol = await columnExists(db, item.to, fromCol);
            const hasNewCol = await columnExists(db, item.to, toCol);
            if (hasOldCol && !hasNewCol) {
                await exec(`ALTER TABLE ${item.to} RENAME COLUMN ${fromCol} TO ${toCol};`);
                console.log(`[Migrations] ${item.to}.${fromCol} 已改名为 ${toCol}`);
            }
        }
    }

    // 旧触发器名字里带旧表名，body 里还留着 'tags' 这种字符串字面量，改名后必须丢掉重装。
    // 触发器数量掉到期望值以下，installSyncTriggers 会自动按新名字重建整套。
    await exec(`
        DROP TRIGGER IF EXISTS tags_sync_ai;
        DROP TRIGGER IF EXISTS tags_sync_au;
        DROP TRIGGER IF EXISTS tags_sync_ad;
        DROP TRIGGER IF EXISTS quick_command_tags_sync_ai;
        DROP TRIGGER IF EXISTS quick_command_tags_sync_au;
        DROP TRIGGER IF EXISTS quick_command_tags_sync_ad;
        DROP TRIGGER IF EXISTS connection_tags_sync_ai;
        DROP TRIGGER IF EXISTS connection_tags_sync_ad;
        DROP TRIGGER IF EXISTS qc_tag_assoc_sync_ai;
        DROP TRIGGER IF EXISTS qc_tag_assoc_sync_ad;
    `);
};

export const runMigrations = (db: Database): Promise<void> => {
    return new Promise((resolve, reject) => {
        console.log('[Migrations] 开始检查和应用数据库迁移...');

        db.serialize(() => {
            // 步骤 1: 确保 migrations 表存在
            db.run(createMigrationsTableSQL, (err) => {
                if (err) {
                    console.error('[Migrations] 创建 migrations 表失败:', err);
                    return reject(new Error(`创建 migrations 表失败: ${err.message}`));
                }
                console.log('[Migrations] migrations 表已确保存在。');

                // 步骤 2: 获取当前数据库版本 (已应用的最大迁移 ID)
                db.get('SELECT MAX(id) as currentVersion FROM migrations', (err, row: { currentVersion: number | null }) => {
                    if (err) {
                        console.error('[Migrations] 查询当前数据库版本失败:', err);
                        return reject(new Error(`查询当前数据库版本失败: ${err.message}`));
                    }

                    const currentVersion = row?.currentVersion ?? 0; // 如果表为空或没有记录，则认为版本为 0
                    console.log(`[Migrations] 当前数据库版本: ${currentVersion}`);

                    // 步骤 3: 确定需要应用的迁移
                    const migrationsToApply = definedMigrations
                        .filter(m => m.id > currentVersion)
                        .sort((a, b) => a.id - b.id); // 确保按 ID 升序应用

                    if (migrationsToApply.length === 0) {
                        console.log('[Migrations] 数据库已是最新版本，无需迁移。');
                        return resolve();
                    }

                    console.log(`[Migrations] 发现 ${migrationsToApply.length} 个新迁移需要应用:`, migrationsToApply.map(m => `  #${m.id}: ${m.name}`));

                    // 步骤 4: 使用 async/await 方式按顺序应用迁移
                    const applyMigrationsSequentially = async () => {
                        for (const migration of migrationsToApply) { // 使用 for...of 循环
                            console.log(`[Migrations] 应用迁移 #${migration.id}: ${migration.name}...`);

                            // 开始事务
                            await new Promise<void>((resolveTx, rejectTx) => {
                                db.run('BEGIN TRANSACTION', (beginErr) => {
                                    if (beginErr) {
                                        console.error(`[Migrations] 开始迁移 #${migration.id} 事务失败:`, beginErr);
                                        rejectTx(new Error(`开始迁移 #${migration.id} 事务失败: ${beginErr.message}`));
                                    } else {
                                        resolveTx();
                                    }
                                });
                            });

                            try {
                                // 步骤 4.1: 执行前置检查 (如果存在)
                                let needsSqlExecution = true;
                                if (migration.check) {
                                    console.log(`[Migrations] 执行迁移 #${migration.id} 的前置检查...`);
                                    needsSqlExecution = await migration.check(db);
                                    console.log(`[Migrations] 迁移 #${migration.id} 前置检查结果: ${needsSqlExecution ? '需要执行 SQL' : '跳过 SQL 执行'}`);
                                }

                                if (needsSqlExecution) {
                                    // 步骤 4.2: 执行迁移 SQL
                                    console.log(`[Migrations] 执行迁移 #${migration.id} 的 SQL...`);
                                    await new Promise<void>((resolveSql, rejectSql) => {
                                        db.exec(migration.sql, (execErr) => {
                                            if (execErr) {
                                                // 特别处理 "duplicate column name" 错误
                                                if (execErr.message.includes('duplicate column name')) {
                                                    console.warn(`[Migrations] 迁移 #${migration.id} SQL 执行时出现 'duplicate column name' 错误，视为可接受并继续。`);
                                                    resolveSql();
                                                } else {
                                                    console.error(`[Migrations] 执行迁移 #${migration.id} SQL 失败:`, execErr);
                                                    rejectSql(execErr);
                                                }
                                            } else {
                                                resolveSql();
                                            }
                                        });
                                    });

                                    if (migration.execute) {
                                        console.log(`[Migrations] 执行迁移 #${migration.id} 的附加逻辑...`);
                                        await migration.execute(db);
                                    }
                                }

                                // 步骤 4.3: 记录迁移到 migrations 表
                                console.log(`[Migrations] 记录迁移 #${migration.id} 到 migrations 表...`);
                                const insertSQL = 'INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, strftime(\'%s\', \'now\'))';
                                await new Promise<void>((resolveInsert, rejectInsert) => {
                                    db.run(insertSQL, [migration.id, migration.name], (insertErr) => {
                                        if (insertErr) {
                                            console.error(`[Migrations] 记录迁移 #${migration.id} 到 migrations 表失败:`, insertErr);
                                            rejectInsert(insertErr);
                                        } else {
                                            resolveInsert();
                                        }
                                    });
                                });

                                // 步骤 4.4: 提交事务
                                console.log(`[Migrations] 提交迁移 #${migration.id} 事务...`);
                                await new Promise<void>((resolveCommit, rejectCommit) => {
                                    db.run('COMMIT', (commitErr) => {
                                        if (commitErr) {
                                            console.error(`[Migrations] 提交迁移 #${migration.id} 事务失败:`, commitErr);
                                            rejectCommit(commitErr);
                                        } else {
                                            console.log(`[Migrations] 迁移 #${migration.id}: ${migration.name} 应用成功 (SQL 可能已跳过)。`);
                                            resolveCommit();
                                        }
                                    });
                                });

                            } catch (migrationStepError: any) {
                                // 捕获 check, exec, insert 或 commit 中的任何错误
                                console.error(`[Migrations] 迁移 #${migration.id} 步骤失败，正在回滚事务...`);
                                await new Promise<void>((resolveRollback) => { // No reject needed for rollback itself
                                    db.run('ROLLBACK', (rollbackErr) => {
                                        if (rollbackErr) console.error(`[Migrations] 回滚迁移 #${migration.id} 事务失败:`, rollbackErr);
                                        // 拒绝整个迁移过程
                                        reject(new Error(`迁移 #${migration.id} 失败: ${migrationStepError.message}`));
                                        resolveRollback(); // Indicate rollback attempt finished
                                    });
                                });
                                return; // 停止应用后续迁移
                            }
                        } 

                        // 所有迁移成功应用
                        console.log('[Migrations] 所有新迁移已成功应用！');
                        resolve();

                    };

                    // 开始按顺序应用迁移
                    applyMigrationsSequentially().catch(reject); // 将 applyMigrationsSequentially 的拒绝传递给外层 Promise

                });
            });
        });
    });
};
