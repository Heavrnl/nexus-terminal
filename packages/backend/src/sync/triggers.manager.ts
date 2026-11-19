import sqlite3 from 'sqlite3';

const NOW_MS = `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;

const BUMP_HLC = `
UPDATE sync_state SET
  hlc_ctr = CASE WHEN ${NOW_MS} > hlc_ms THEN 0 ELSE hlc_ctr + 1 END,
  hlc_ms  = MAX(hlc_ms, ${NOW_MS})
WHERE id = 1;
`;

const HLC_EXPR = `(SELECT printf('%013d-%05d-%s', hlc_ms, hlc_ctr, device_id) FROM sync_state WHERE id = 1)`;

const WHEN_ACTIVE = `WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0 AND (SELECT enabled FROM sync_state WHERE id = 1) = 1`;

const UUID_FALLBACK = `lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))`;

export interface TableTriggerConfig {
  tableName: string;
  updateOfColumns: string[];
  primaryKeyColumn?: string;
}

export const syncTableConfigs: TableTriggerConfig[] = [
  {
    tableName: 'connections',
    updateOfColumns: [
      'name', 'type', 'host', 'port', 'username', 'auth_method',
      'encrypted_password', 'encrypted_private_key', 'encrypted_passphrase',
      'proxy_type', 'proxy_id', 'ssh_key_id', 'notes', 'jump_chain', 'background_color',
      'file_protocol'
    ]
  },
  {
    tableName: 'proxies',
    updateOfColumns: [
      'name', 'type', 'host', 'port', 'username', 'auth_method',
      'encrypted_password', 'encrypted_private_key', 'encrypted_passphrase'
    ]
  },
  {
    tableName: 'ssh_keys',
    updateOfColumns: [
      'name', 'encrypted_private_key', 'encrypted_passphrase'
    ]
  },
  {
    tableName: 'folders',
    updateOfColumns: [
      'name', 'background_color'
    ]
  },
  {
    tableName: 'quick_commands',
    updateOfColumns: [
      'name', 'command', 'variables', 'background_color'
    ]
  },
  {
    tableName: 'quick_command_folders',
    updateOfColumns: [
      'name', 'background_color'
    ]
  },
  {
    tableName: 'settings',
    updateOfColumns: [
      'value'
    ],
    primaryKeyColumn: 'key'
  },
  {
    tableName: 'port_forwards',
    updateOfColumns: [
      'connection_id', 'type', 'bind_host', 'bind_port',
      'target_host', 'target_port', 'auto_start'
    ]
  },
  {
    tableName: 'command_history',
    updateOfColumns: [
      'command', 'timestamp'
    ]
  },
  {
    // 外观设置（终端背景图/字体/自定义 UI 主题…）。key 作主键，和 settings 一样一个键一行。
    tableName: 'appearance_settings',
    updateOfColumns: [
      'value'
    ],
    primaryKeyColumn: 'key'
  },
  {
    // 自定义终端配色主题。身份是 name（表上 UNIQUE），跨端对齐也按 name。
    tableName: 'terminal_themes',
    updateOfColumns: [
      'name', 'theme_type', 'foreground', 'background', 'cursor', 'cursor_accent',
      'selection_background', 'black', 'red', 'green', 'yellow', 'blue', 'magenta',
      'cyan', 'white', 'bright_black', 'bright_red', 'bright_green', 'bright_yellow',
      'bright_blue', 'bright_magenta', 'bright_cyan', 'bright_white'
    ]
  },
  {
    // 常用路径。刻意不含 last_used_at：它每用一次就变，进触发器会让同步被刷屏；
    // 它仍然会随其它字段一起被推上去，只是不单独触发。
    tableName: 'favorite_paths',
    updateOfColumns: [
      'name', 'path', 'is_file', 'scope', 'connection_uuid'
    ]
  }
];

/**
 * 生成主实体表的三类触发器 (AFTER INSERT / AFTER UPDATE OF / AFTER DELETE)
 */
function generateTableTriggersSql(cfg: TableTriggerConfig): string {
  const { tableName, updateOfColumns } = cfg;
  const pk = cfg.primaryKeyColumn || 'id';

  const extraCondition = tableName === 'settings'
    ? `\n    AND NEW.key NOT IN ('desktop_sync_config', 'syncApiKey') AND NEW.key NOT LIKE 'desktop_%'`
    // 内置 preset 主题（400+ 条）每台机器都一样，参与同步只是白白刷 400 行变更，
    // 还会让后装的一端用自己 seed 出来的 HLC 顶掉对端 —— 和 v1 一样只同步自定义主题。
    : tableName === 'terminal_themes'
      ? `\n    AND NEW.theme_type = 'user'`
      : '';

  const extraDeleteCondition = tableName === 'settings'
    ? `\n    AND OLD.key NOT IN ('desktop_sync_config', 'syncApiKey') AND OLD.key NOT LIKE 'desktop_%'`
    : tableName === 'terminal_themes'
      ? `\n    AND OLD.theme_type = 'user'`
      : '';

  return `
    -- ${tableName} AFTER INSERT
    DROP TRIGGER IF EXISTS ${tableName}_sync_ai;
    CREATE TRIGGER ${tableName}_sync_ai AFTER INSERT ON ${tableName}
    ${WHEN_ACTIVE}${extraCondition}
    BEGIN
      ${BUMP_HLC}
      UPDATE ${tableName} SET
        uuid = CASE WHEN NEW.uuid IS NULL OR NEW.uuid = '' THEN (${UUID_FALLBACK}) ELSE NEW.uuid END,
        updated_hlc = ${HLC_EXPR}
      WHERE ${pk} = NEW.${pk};

      DELETE FROM sync_tombstones WHERE tbl = '${tableName}' AND row_id = (SELECT uuid FROM ${tableName} WHERE ${pk} = NEW.${pk});
      INSERT INTO sync_changes(tbl, row_id, op, origin)
        SELECT '${tableName}', uuid, 'U', NULL FROM ${tableName} WHERE ${pk} = NEW.${pk};
    END;

    -- ${tableName} AFTER UPDATE
    DROP TRIGGER IF EXISTS ${tableName}_sync_au;
    CREATE TRIGGER ${tableName}_sync_au AFTER UPDATE OF ${updateOfColumns.join(', ')} ON ${tableName}
    ${WHEN_ACTIVE}${extraCondition}
    AND NEW.updated_hlc IS OLD.updated_hlc
    BEGIN
      ${BUMP_HLC}
      UPDATE ${tableName} SET
        uuid = CASE WHEN NEW.uuid IS NULL OR NEW.uuid = '' THEN (${UUID_FALLBACK}) ELSE NEW.uuid END,
        updated_hlc = ${HLC_EXPR}
      WHERE ${pk} = NEW.${pk};
      INSERT INTO sync_changes(tbl, row_id, op, origin)
        SELECT '${tableName}', uuid, 'U', NULL FROM ${tableName} WHERE ${pk} = NEW.${pk};
    END;

    -- ${tableName} AFTER DELETE
    DROP TRIGGER IF EXISTS ${tableName}_sync_ad;
    CREATE TRIGGER ${tableName}_sync_ad AFTER DELETE ON ${tableName}
    ${WHEN_ACTIVE}${extraDeleteCondition}
    AND OLD.uuid IS NOT NULL AND OLD.uuid != ''
    BEGIN
      ${BUMP_HLC}
      INSERT OR REPLACE INTO sync_tombstones(tbl, row_id, deleted_hlc, deleted_at)
        VALUES ('${tableName}', OLD.uuid, ${HLC_EXPR}, ${NOW_MS});
      INSERT INTO sync_changes(tbl, row_id, op, origin) VALUES ('${tableName}', OLD.uuid, 'D', NULL);
    END;

  `;
}

/**
 * 生成关联表反向推进触发器 (connection_folders 变动顶父记录)
 */
function generateAssociationTriggersSql(): string {
  return `
    -- connection_folders AFTER INSERT
    DROP TRIGGER IF EXISTS connection_folders_sync_ai;
    CREATE TRIGGER connection_folders_sync_ai AFTER INSERT ON connection_folders
    ${WHEN_ACTIVE}
    BEGIN
      ${BUMP_HLC}
      UPDATE connections SET updated_hlc = ${HLC_EXPR} WHERE id = NEW.connection_id;
      INSERT INTO sync_changes(tbl, row_id, op, origin)
        SELECT 'connections', uuid, 'U', NULL FROM connections WHERE id = NEW.connection_id;
    END;

    -- connection_folders AFTER DELETE
    DROP TRIGGER IF EXISTS connection_folders_sync_ad;
    CREATE TRIGGER connection_folders_sync_ad AFTER DELETE ON connection_folders
    ${WHEN_ACTIVE}
    BEGIN
      ${BUMP_HLC}
      UPDATE connections SET updated_hlc = ${HLC_EXPR} WHERE id = OLD.connection_id;
      INSERT INTO sync_changes(tbl, row_id, op, origin)
        SELECT 'connections', uuid, 'U', NULL FROM connections WHERE id = OLD.connection_id;
    END;

    -- quick_command_folder_associations AFTER INSERT
    DROP TRIGGER IF EXISTS qc_folder_assoc_sync_ai;
    CREATE TRIGGER qc_folder_assoc_sync_ai AFTER INSERT ON quick_command_folder_associations
    ${WHEN_ACTIVE}
    BEGIN
      ${BUMP_HLC}
      UPDATE quick_commands SET updated_hlc = ${HLC_EXPR}, updated_at = CAST(strftime('%s', 'now') AS INTEGER) WHERE id = NEW.quick_command_id;
      INSERT INTO sync_changes(tbl, row_id, op, origin)
        SELECT 'quick_commands', uuid, 'U', NULL FROM quick_commands WHERE id = NEW.quick_command_id;
    END;

    -- quick_command_folder_associations AFTER DELETE
    DROP TRIGGER IF EXISTS qc_folder_assoc_sync_ad;
    CREATE TRIGGER qc_folder_assoc_sync_ad AFTER DELETE ON quick_command_folder_associations
    ${WHEN_ACTIVE}
    BEGIN
      ${BUMP_HLC}
      UPDATE quick_commands SET updated_hlc = ${HLC_EXPR}, updated_at = CAST(strftime('%s', 'now') AS INTEGER) WHERE id = OLD.quick_command_id;
      INSERT INTO sync_changes(tbl, row_id, op, origin)
        SELECT 'quick_commands', uuid, 'U', NULL FROM quick_commands WHERE id = OLD.quick_command_id;
    END;

    -- file_color_highlights AFTER INSERT
    DROP TRIGGER IF EXISTS file_color_highlights_sync_ai;
    CREATE TRIGGER file_color_highlights_sync_ai AFTER INSERT ON file_color_highlights
    ${WHEN_ACTIVE}
    BEGIN
      ${BUMP_HLC}
      UPDATE connections SET updated_hlc = ${HLC_EXPR}, updated_at = CAST(strftime('%s', 'now') AS INTEGER) WHERE id = NEW.connection_id;
      INSERT INTO sync_changes(tbl, row_id, op, origin)
        SELECT 'connections', uuid, 'U', NULL FROM connections WHERE id = NEW.connection_id;
    END;

    -- file_color_highlights AFTER UPDATE
    DROP TRIGGER IF EXISTS file_color_highlights_sync_au;
    CREATE TRIGGER file_color_highlights_sync_au AFTER UPDATE OF color, path ON file_color_highlights
    ${WHEN_ACTIVE}
    BEGIN
      ${BUMP_HLC}
      UPDATE connections SET updated_hlc = ${HLC_EXPR}, updated_at = CAST(strftime('%s', 'now') AS INTEGER) WHERE id = NEW.connection_id;
      INSERT INTO sync_changes(tbl, row_id, op, origin)
        SELECT 'connections', uuid, 'U', NULL FROM connections WHERE id = NEW.connection_id;
    END;

    -- file_color_highlights AFTER DELETE
    DROP TRIGGER IF EXISTS file_color_highlights_sync_ad;
    CREATE TRIGGER file_color_highlights_sync_ad AFTER DELETE ON file_color_highlights
    ${WHEN_ACTIVE}
    BEGIN
      ${BUMP_HLC}
      UPDATE connections SET updated_hlc = ${HLC_EXPR}, updated_at = CAST(strftime('%s', 'now') AS INTEGER) WHERE id = OLD.connection_id;
      INSERT INTO sync_changes(tbl, row_id, op, origin)
        SELECT 'connections', uuid, 'U', NULL FROM connections WHERE id = OLD.connection_id;
    END;
  `;
}

/**
 * 安装所有双端同步触发器
 */
export async function installSyncTriggers(db: sqlite3.Database, forceReinstall: boolean = false): Promise<void> {
  const expectedCount = syncTableConfigs.length * 3 + 7;
  if (!forceReinstall) {
    const currentCount = await new Promise<number>((resolve) => {
      db.get("SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%_sync_%'", (err, r: any) => {
        resolve(r?.count ?? 0);
      });
    });

    const staleCommandAu = await new Promise<boolean>((resolve) => {
      db.get("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'command_history_sync_au'", (err, r: any) => {
        resolve(Boolean(r?.sql && r.sql.includes("VALUES ('command_history', NEW.uuid")));
      });
    });

    if (currentCount >= expectedCount && !staleCommandAu) {
      console.log(`[SyncTriggers] SQLite 同步触发器已就绪 (${currentCount}/${expectedCount})，跳过重复安装。`);
      return;
    }
  }

  console.log('[SyncTriggers] 开始安装 SQLite 增量同步触发器 (带熔断保护)...');

  let fullSql = '';
  for (const cfg of syncTableConfigs) {
    fullSql += generateTableTriggersSql(cfg) + '\n';
  }
  fullSql += generateAssociationTriggersSql();

  // SQLite exec 批量执行 DDL
  await new Promise<void>((resolve, reject) => {
    db.exec(fullSql, (err) => {
      if (err) {
        console.error('[SyncTriggers] 安装触发器失败:', err);
        return reject(err);
      }
      resolve();
    });
  });

  console.log('[SyncTriggers] 所有同步触发器安装完毕 (当前 enabled 状态受控于 sync_state 表)。');
}

/**
 * 卸载/清理所有触发器
 */
export async function uninstallSyncTriggers(db: sqlite3.Database): Promise<void> {
  const triggerNames: string[] = [];
  for (const cfg of syncTableConfigs) {
    triggerNames.push(`${cfg.tableName}_sync_ai`, `${cfg.tableName}_sync_au`, `${cfg.tableName}_sync_ad`);
  }
  triggerNames.push(
    'connection_folders_sync_ai',
    'connection_folders_sync_ad',
    'qc_folder_assoc_sync_ai',
    'qc_folder_assoc_sync_ad',
    'file_color_highlights_sync_ai',
    'file_color_highlights_sync_au',
    'file_color_highlights_sync_ad'
  );

  const drops = triggerNames.map(name => `DROP TRIGGER IF EXISTS ${name};`).join('\n');
  await new Promise<void>((resolve, reject) => {
    db.exec(drops, (err) => (err ? reject(err) : resolve()));
  });
  console.log('[SyncTriggers] 所有同步触发器已卸载。');
}
