// packages/backend/src/schema.ts

export const createSettingsTableSQL = `
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    uuid TEXT NULL,
    updated_hlc TEXT NULL
);
`;

export const createAuditLogsTableSQL = `
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    action_type TEXT NOT NULL,
    details TEXT NULL
);
`;



// Passkeys table definition
export const createPasskeysTableSQL = `
CREATE TABLE IF NOT EXISTS passkeys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credential_id TEXT UNIQUE NOT NULL, -- Base64URL encoded
    public_key TEXT NOT NULL, -- COSE public key, stored as Base64URL or HEX
    counter INTEGER NOT NULL,
    transports TEXT, -- JSON array of transports e.g. ["usb", "nfc", "ble", "internal"]
    name TEXT NULL, -- User-friendly name for the passkey
    backed_up BOOLEAN NOT NULL DEFAULT FALSE,
    last_used_at INTEGER NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const createNotificationSettingsTableSQL = `
CREATE TABLE IF NOT EXISTS notification_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_type TEXT NOT NULL CHECK(channel_type IN ('webhook', 'email', 'telegram', 'gotify')),
    name TEXT NOT NULL DEFAULT '',
    enabled BOOLEAN NOT NULL DEFAULT false,
    config TEXT NOT NULL DEFAULT '{}', -- JSON string for channel-specific config
    enabled_events TEXT NOT NULL DEFAULT '[]', -- JSON array of event names
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
`;

export const createUsersTableSQL = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    hashed_password TEXT NOT NULL,
    two_factor_secret TEXT NULL, -- 添加 2FA 密钥列，允许为空
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
`;

export const createProxiesTableSQL = `
CREATE TABLE IF NOT EXISTS proxies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('SOCKS5', 'HTTP')),
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT NULL,
    auth_method TEXT NOT NULL DEFAULT 'none' CHECK(auth_method IN ('none', 'password', 'key')),
    encrypted_password TEXT NULL,
    encrypted_private_key TEXT NULL,
    encrypted_passphrase TEXT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    UNIQUE(name, type, host, port)
);
`;

export const createConnectionsTableSQL = `
CREATE TABLE IF NOT EXISTS connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NULL, -- 允许 name 为空
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
jump_chain TEXT NULL,
proxy_type TEXT NULL,
background_color TEXT NULL,
file_protocol TEXT NOT NULL DEFAULT 'auto',
-- 连接级启动命令：连上终端后自动执行（与布局里的「终端自启指令」互相独立，两边都配了就都执行）
startup_command TEXT NOT NULL DEFAULT '',
-- SFTP sudo 提权：开启后用 sudo 启动 sftp-server 开文件通道，读写 root 才能碰的路径
-- 默认开启：失败会自动退回普通 SFTP，所以默认开是安全的（拿不到 root 只是没加成）
sftp_sudo_enabled INTEGER NOT NULL DEFAULT 1,
encrypted_sudo_password TEXT NULL,
-- 会话托管模式：auto=跟随全局自动使用目标机 nexus-mux 托管（失败降级传统模式），legacy=禁用目标机代理强制传统模式
session_hosting_mode TEXT NOT NULL DEFAULT 'auto',
created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    last_connected_at INTEGER NULL,
    FOREIGN KEY (proxy_id) REFERENCES proxies(id) ON DELETE SET NULL,
    FOREIGN KEY (ssh_key_id) REFERENCES ssh_keys(id) ON DELETE SET NULL 
);
`;

export const createSshKeysTableSQL = `
CREATE TABLE IF NOT EXISTS ssh_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    encrypted_private_key TEXT NOT NULL,
    encrypted_passphrase TEXT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
`;

export const createFoldersTableSQL = `
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    background_color TEXT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
`;

export const createConnectionFoldersTableSQL = `
CREATE TABLE IF NOT EXISTS connection_folders (
    connection_id INTEGER NOT NULL,
    folder_id INTEGER NOT NULL,
    PRIMARY KEY (connection_id, folder_id),
    FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE,
    FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
);
`;

export const createIpBlacklistTableSQL = `
CREATE TABLE IF NOT EXISTS ip_blacklist (
    ip TEXT PRIMARY KEY NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 1,
    last_attempt_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    blocked_until INTEGER NULL -- 封禁截止时间戳 (秒)，NULL 表示未封禁或永久封禁 (根据逻辑决定)
);
`;

export const createCommandHistoryTableSQL = `
CREATE TABLE IF NOT EXISTS command_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command TEXT NOT NULL,
    timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    uuid TEXT NULL,
    updated_hlc TEXT NULL
);
`;

export const createPathHistoryTableSQL = `
CREATE TABLE IF NOT EXISTS path_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    -- 路径历史按主机隔离：同一路径在不同机器上是两条独立记录
    connection_uuid TEXT NULL,
    timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
`;

export const createQuickCommandsTableSQL = `
CREATE TABLE IF NOT EXISTS quick_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NULL, -- 名称可选
    command TEXT NOT NULL, -- 指令必选
    usage_count INTEGER NOT NULL DEFAULT 0, -- 使用频率
    variables TEXT NULL,
    background_color TEXT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
`;

// --- Quick Command Folders ---

export const createQuickCommandFoldersTableSQL = `
CREATE TABLE IF NOT EXISTS quick_command_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    background_color TEXT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
`;

export const createQuickCommandFolderAssociationsTableSQL = `
CREATE TABLE IF NOT EXISTS quick_command_folder_associations (
    quick_command_id INTEGER NOT NULL,
    folder_id INTEGER NOT NULL,
    PRIMARY KEY (quick_command_id, folder_id),
    FOREIGN KEY (quick_command_id) REFERENCES quick_commands(id) ON DELETE CASCADE,
    FOREIGN KEY (folder_id) REFERENCES quick_command_folders(id) ON DELETE CASCADE
);
`;



// 从 database.ts 移动过来的，保持一致性
export const createTerminalThemesTableSQL = `
CREATE TABLE IF NOT EXISTS terminal_themes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    theme_type TEXT NOT NULL CHECK(theme_type IN ('preset', 'user')),
    foreground TEXT,
    background TEXT,
    cursor TEXT,
    cursor_accent TEXT,
    selection_background TEXT,
    black TEXT,
    red TEXT,
    green TEXT,
    yellow TEXT,
    blue TEXT,
    magenta TEXT,
    cyan TEXT,
    white TEXT,
    bright_black TEXT,
    bright_red TEXT,
    bright_green TEXT,
    bright_yellow TEXT,
    bright_blue TEXT,
    bright_magenta TEXT,
    bright_cyan TEXT,
    bright_white TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    uuid TEXT NULL,
    updated_hlc TEXT NOT NULL DEFAULT ''
);
`;

export const createAppearanceSettingsTableSQL = `
CREATE TABLE IF NOT EXISTS appearance_settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    uuid TEXT NULL,
    updated_hlc TEXT NOT NULL DEFAULT ''
);
`;
export const createFavoritePathsTableSQL = `
CREATE TABLE IF NOT EXISTS favorite_paths (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NULL, 
    path TEXT NOT NULL, 
    is_file INTEGER NOT NULL DEFAULT 0,
    -- 'global' = 所有主机可见；'host' = 只对 connection_uuid 那台主机可见
    scope TEXT NOT NULL DEFAULT 'global',
    connection_uuid TEXT NULL,
    last_used_at INTEGER NULL, 
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    uuid TEXT NULL,
    updated_hlc TEXT NOT NULL DEFAULT ''
);
`;

// 端口转发规则（按连接绑定）。运行态不落库，只在内存里。
export const createPortForwardsTableSQL = `
CREATE TABLE IF NOT EXISTS port_forwards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT NULL,
    connection_id INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('local', 'remote', 'dynamic')),
    bind_host TEXT NOT NULL DEFAULT '127.0.0.1',
    bind_port INTEGER NOT NULL,
    target_host TEXT NULL,
    target_port INTEGER NULL,
    auto_start INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_hlc TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
);
`;

export const createWorkspaceSyncTableSQL = `CREATE TABLE IF NOT EXISTS workspace_sync (
    user_id INTEGER PRIMARY KEY NOT NULL,
    state TEXT NOT NULL DEFAULT '{}',
    active_client_id TEXT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const createSyncTombstonesTableSQL = `
CREATE TABLE IF NOT EXISTS sync_tombstones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    uuid TEXT NOT NULL,
    deleted_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
`;

export const createFileColorHighlightsTableSQL = `
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
`;

export const createRemoteHostedSessionsTableSQL = `
CREATE TABLE IF NOT EXISTS remote_hosted_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    remote_session_id TEXT UNIQUE NOT NULL,
    connection_uuid TEXT NULL,
    connection_id INTEGER NULL,
    connection_name TEXT NOT NULL DEFAULT '',
    custom_name TEXT NULL,
    manually_suspended INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'hanging',
    exit_code INTEGER NULL,
    owner_namespace TEXT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_hlc TEXT NOT NULL DEFAULT ''
);
`;

