import { Database } from 'sqlite3';
import * as schemaSql from './schema';
import * as appearanceRepository from '../appearance/appearance.repository';
import * as terminalThemeRepository from '../terminal-themes/terminal-theme.repository';
import * as settingsRepository from '../settings/settings.repository'; 
import { presetTerminalThemes } from '../config/preset-themes-definition';
import { runDb } from './connection'; 

/**
 * Interface describing a database table definition for initialization.
 */
export interface TableDefinition {
    name: string;
    sql: string;
    init?: (db: Database) => Promise<void>; 
}





/**
 * Initializes preset terminal themes.
 * Assumes terminalThemeRepository.initializePresetThemes might need the db instance.
 */
const initTerminalThemesTable = async (db: Database): Promise<void> => {
    // ⚠️ 建表 SQL 里只跑第一条语句（runDb → sqlite3 run），所以索引必须写在 init 里
    try {
        await runDb(db, `CREATE INDEX IF NOT EXISTS idx_terminal_themes_uuid ON terminal_themes(uuid);`);
    } catch (err: any) {
        console.error('[DB Init] 创建 terminal_themes 索引失败:', err.message);
    }
    // Pass the db instance to the repository function
    // Note: This might require modifying initializePresetThemes if it doesn't accept db
    await terminalThemeRepository.initializePresetThemes(db, presetTerminalThemes);
    console.log('[DB Init] 预设主题初始化检查完成。');
};

/**
 * Ensures default appearance settings exist.
 * Assumes appearanceRepository.ensureDefaultSettingsExist might need the db instance.
 */
const initAppearanceSettingsTable = async (db: Database): Promise<void> => {
    try {
        await runDb(db, `CREATE INDEX IF NOT EXISTS idx_appearance_settings_uuid ON appearance_settings(uuid);`);
    } catch (err: any) {
        console.error('[DB Init] 创建 appearance_settings 索引失败:', err.message);
    }
    // Pass the db instance to the repository function
    // Note: This might require modifying ensureDefaultSettingsExist if it doesn't accept db
    await appearanceRepository.ensureDefaultSettingsExist(db);
    console.log('[DB Init] 外观设置初始化检查完成。');
};

const initFavoritePathsTable = async (db: Database): Promise<void> => {
    try {
        await runDb(db, `CREATE INDEX IF NOT EXISTS idx_favorite_paths_uuid ON favorite_paths(uuid);`);
    } catch (err: any) {
        console.error('[DB Init] 创建 favorite_paths 索引失败:', err.message);
    }
};


const initCommandHistoryTable = async (db: Database): Promise<void> => {
    try {
        await runDb(db, `CREATE INDEX IF NOT EXISTS idx_command_history_command ON command_history(command);`);
        await runDb(db, `CREATE INDEX IF NOT EXISTS idx_command_history_timestamp ON command_history(timestamp DESC);`);
        await runDb(db, `CREATE INDEX IF NOT EXISTS idx_command_history_uuid ON command_history(uuid);`);
    } catch (err: any) {
        console.error('[DB Init] 创建 command_history 索引失败:', err.message);
    }
};

const initQuickCommandsTable = async (db: Database): Promise<void> => {
    try {
        await runDb(db, `CREATE INDEX IF NOT EXISTS idx_quick_commands_name ON quick_commands(name);`);
        await runDb(db, `CREATE INDEX IF NOT EXISTS idx_quick_commands_usage_count ON quick_commands(usage_count DESC);`);
        // 注意：quick_command_folder_associations 的 folder_id 索引不在这里建 ——
        // 这张表由迁移 #3 创建，而建表逻辑跑在迁移之前，在这里建会报 "no such table"。
        // 索引统一放到迁移 #14（新库）与 #27（老库）里创建。
    } catch (err: any) {
        console.error('[DB Init] 创建 quick_commands 索引失败:', err.message);
    }
};

// --- Table Definitions Registry ---

/**
 * Array containing definitions for all tables to be created and initialized.
 * The order might matter if there are strict foreign key dependencies without ON DELETE/UPDATE clauses,
 * but CREATE IF NOT EXISTS makes it generally safe. Initialization order might also matter.
 */
export const tableDefinitions: TableDefinition[] = [
    // Core settings and logs first
    {
        name: 'settings',
        sql: schemaSql.createSettingsTableSQL,
        init: settingsRepository.ensureDefaultSettingsExist // <-- Use the function from the repository
    },
    { name: 'audit_logs', sql: schemaSql.createAuditLogsTableSQL },
    // { name: 'api_keys', sql: schemaSql.createApiKeysTableSQL }, // Removed API Keys table from registry
    // { name: 'passkeys', sql: schemaSql.createPasskeysTableSQL }, // Removed Passkeys table from registry
    { name: 'notification_settings', sql: schemaSql.createNotificationSettingsTableSQL },
    { name: 'users', sql: schemaSql.createUsersTableSQL },

    // Features like proxies, connections, folders
    { name: 'proxies', sql: schemaSql.createProxiesTableSQL },
    { name: 'ssh_keys', sql: schemaSql.createSshKeysTableSQL }, // Added SSH Keys table
    { name: 'connections', sql: schemaSql.createConnectionsTableSQL }, // Depends on proxies, ssh_keys
    {
        name: 'port_forwards',
        sql: schemaSql.createPortForwardsTableSQL, // 端口转发规则，随连接级联删除
        init: async (db: Database): Promise<void> => {
            try {
                await runDb(db, `CREATE INDEX IF NOT EXISTS idx_port_forwards_conn ON port_forwards(connection_id);`);
            } catch (err: any) {
                console.error('[DB Init] 创建 port_forwards 索引失败:', err.message);
            }
        }
    },
    { name: 'folders', sql: schemaSql.createFoldersTableSQL },
    { name: 'connection_folders', sql: schemaSql.createConnectionFoldersTableSQL }, // Depends on connections, folders

    // Other utilities
    { name: 'ip_blacklist', sql: schemaSql.createIpBlacklistTableSQL },
    {
        name: 'command_history',
        sql: schemaSql.createCommandHistoryTableSQL,
        init: initCommandHistoryTable
    },
    { name: 'path_history', sql: schemaSql.createPathHistoryTableSQL },
    {
        name: 'quick_commands',
        sql: schemaSql.createQuickCommandsTableSQL,
        init: initQuickCommandsTable
    },
    { name: 'favorite_paths', sql: schemaSql.createFavoritePathsTableSQL, init: initFavoritePathsTable }, // Added Favorite Paths table

    // Appearance related tables (often depend on others or have init logic)
    {
        name: 'terminal_themes',
        sql: schemaSql.createTerminalThemesTableSQL,
        init: initTerminalThemesTable
    },
    {
        name: 'appearance_settings',
        sql: schemaSql.createAppearanceSettingsTableSQL,
        init: initAppearanceSettingsTable
     }, // Depends on terminal_themes
    {
        name: 'workspace_sync',
        sql: schemaSql.createWorkspaceSyncTableSQL
    },
    {
        name: 'sync_tombstones',
        sql: schemaSql.createSyncTombstonesTableSQL
    },
    {
        name: 'file_color_highlights',
        sql: schemaSql.createFileColorHighlightsTableSQL,
        init: async (db: Database): Promise<void> => {
            try {
                await runDb(db, `CREATE INDEX IF NOT EXISTS idx_file_color_highlights_conn ON file_color_highlights(connection_id);`);
                await runDb(db, `CREATE UNIQUE INDEX IF NOT EXISTS idx_file_color_highlights_conn_path ON file_color_highlights(connection_id, path);`);
            } catch (err: any) {
                console.error('[DB Init] 创建 file_color_highlights 索引失败:', err.message);
            }
        }
    },
];