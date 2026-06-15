// packages/backend/src/schema.ts

export const createSettingsTableSQL = `
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
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
    channel_type TEXT NOT NULL CHECK(channel_type IN ('webhook', 'email', 'telegram')),
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
startup_command TEXT NULL,
sftp_sudo_enabled INTEGER NOT NULL DEFAULT 0,
encrypted_sftp_sudo_password TEXT NULL,
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

export const createTagsTableSQL = `
CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
`;

export const createConnectionTagsTableSQL = `
CREATE TABLE IF NOT EXISTS connection_tags (
    connection_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (connection_id, tag_id),
    FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
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
    timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
`;

export const createPathHistoryTableSQL = `
CREATE TABLE IF NOT EXISTS path_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
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
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
`;

// --- Quick Command Tags ---

export const createQuickCommandTagsTableSQL = `
CREATE TABLE IF NOT EXISTS quick_command_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
`;

export const createQuickCommandTagAssociationsTableSQL = `
CREATE TABLE IF NOT EXISTS quick_command_tag_associations (
    quick_command_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (quick_command_id, tag_id),
    FOREIGN KEY (quick_command_id) REFERENCES quick_commands(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES quick_command_tags(id) ON DELETE CASCADE
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
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
`;

export const createAppearanceSettingsTableSQL = `
CREATE TABLE IF NOT EXISTS appearance_settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
`;
export const createFavoritePathsTableSQL = `
CREATE TABLE IF NOT EXISTS favorite_paths (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NULL, 
    path TEXT NOT NULL, 
    last_used_at INTEGER NULL, 
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
`;