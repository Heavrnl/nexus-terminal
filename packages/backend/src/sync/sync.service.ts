import { getDbInstance, runDb, getDb, allDb, acquireApplyLock, applyContext } from '../database/connection';
import { envelopeCryptoService } from './envelope-crypto.service';
import { recordTombstone, getTombstonesSince } from './tombstone.service';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { workspaceSyncService } from '../workspace-sync/workspace-sync.service';
import { getServerSyncApiKey } from './sync.middleware';
import { assertSafeSyncOutboundUrl } from './outbound-url';
import { syncThrottleScheduler } from './sync.scheduler';
import {
  CATEGORY_ITEMS,
  describeSyncItems,
  isAppearanceKeyEnabled,
  isSettingsKeyEnabled,
  isTableEnabled,
  resolveSyncItems,
  type SyncCategoryKey,
  type SyncItemKey,
} from './sync.items';
import {
  generateDeterministicCommandUuid,
  normalizeCommandText,
  normalizeTimestampSeconds,
} from '../command-history/command-history.pure';

/**
 * 同步范围里的一个 key：既可能是旧的大类（appearance / layout …），
 * 也可能是细项（appearance.font / layout.presets …）。
 * 老客户端只发大类，resolveSyncItems 会自动展开，别在这里把类型收窄回大类。
 */
export type SyncModuleKey = SyncCategoryKey | SyncItemKey;

/**
 * 是否同步某个大类 —— 只为兼容旧调用点保留。
 * 新的判定一律用 resolveSyncItems() + 具体子项，别再按大类粗粒度过滤。
 */
export function shouldSyncModule(modules: SyncModuleKey[] | undefined, target: SyncCategoryKey): boolean {
  const enabled = resolveSyncItems(modules as unknown as string[]);
  return CATEGORY_ITEMS[target].every(item => enabled.has(item));
}

export interface SyncEntityItem {
  uuid: string;
  updated_at: number;
  data: any;
}

export interface SyncExchangePayload {
  clientTime: number;
  lastSyncTime?: number;
  mode?: 'bidirectional' | 'cloud_to_local' | 'local_to_cloud';
  modules?: SyncModuleKey[];
  entities: {
    folders?: SyncEntityItem[];
    quick_command_folders?: SyncEntityItem[];
    ssh_keys?: SyncEntityItem[];
    proxies?: SyncEntityItem[];
    connections?: SyncEntityItem[];
    quick_commands?: SyncEntityItem[];
    settings?: SyncEntityItem[];
    appearance_settings?: SyncEntityItem[];
    users?: SyncEntityItem[];
    terminal_themes?: SyncEntityItem[];
    favorite_paths?: SyncEntityItem[];
    workspace_sync?: SyncEntityItem[];
    command_history?: SyncEntityItem[];
  };
  tombstones: Array<{ entity_type: string; uuid: string; deleted_at: number }>;
}

export interface SyncExchangeResult {
  serverTime: number;
  syncedEntities: SyncExchangePayload['entities'];
  tombstones: Array<{ entity_type: string; uuid: string; deleted_at: number }>;
  stats: {
    pulled: number;
    pushed: number;
    conflictsResolved: number;
  };
}

export const syncService = {
  /**
   * 导出本端自 sinceTimestamp 之后更新的数据与删除墓碑 (支持按模块过滤)
   */
  async exportIncrementalData(sinceTimestamp: number, apiKey: string, modules?: SyncModuleKey[]): Promise<{
    entities: SyncExchangePayload['entities'];
    tombstones: Array<{ entity_type: string; uuid: string; deleted_at: number }>;
  }> {
    const db = await getDbInstance();
    // modules 里既可以是旧的 5 个大类，也可以是新的细项（appearance.font 这种）
    const enabledItems = resolveSyncItems(modules as unknown as string[]);
    const en = (key: SyncItemKey) => enabledItems.has(key);
    const categoryFullyEnabled = (cat: SyncCategoryKey) => CATEGORY_ITEMS[cat].every(i => enabledItems.has(i));
    const anyAppearance = CATEGORY_ITEMS.appearance.some(i => enabledItems.has(i));
    const anyLayout = CATEGORY_ITEMS.layout.some(i => enabledItems.has(i));

    // 1. 获取 Tombstones (按模块过滤)
    let tombstones = await getTombstonesSince(sinceTimestamp);
    if (modules && modules.length > 0) {
      tombstones = tombstones.filter(t => {
        // 混合表（settings / appearance_settings）不知道墓碑对应哪个 key，
        // 只勾了部分子项时宁可不删，否则会把没同步的那部分也一起删掉
        if (t.entity_type === 'settings') return categoryFullyEnabled('layout');
        if (t.entity_type === 'appearance_settings') return categoryFullyEnabled('appearance');
        return isTableEnabled(enabledItems, t.entity_type);
      });
    }

    // 2. 导出 Folders
    let folders: SyncEntityItem[] = [];
    if (en('connections.folders')) {
      const tagsRows = await allDb<any>(
        db,
        `SELECT uuid, name, background_color, created_at, updated_at FROM folders WHERE updated_at > ?`,
        [sinceTimestamp]
      );
      folders = tagsRows.map(r => ({
        uuid: r.uuid,
        updated_at: r.updated_at,
        data: { name: r.name, background_color: r.background_color || null, created_at: r.created_at, updated_at: r.updated_at }
      }));
    }

    // 3. 导出 SshKeys (敏感字段打上信封密文)
    let ssh_keys: SyncEntityItem[] = [];
    if (en('connections.keys')) {
      const sshKeysRows = await allDb<any>(
        db,
        `SELECT uuid, name, encrypted_private_key, encrypted_passphrase, created_at, updated_at FROM ssh_keys WHERE updated_at > ?`,
        [sinceTimestamp]
      );
      ssh_keys = sshKeysRows.map(r => ({
        uuid: r.uuid,
        updated_at: r.updated_at,
        data: {
          name: r.name,
          encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(r.encrypted_private_key, apiKey),
          encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(r.encrypted_passphrase, apiKey),
          created_at: r.created_at,
          updated_at: r.updated_at
        }
      }));
    }

    // 4. 导出 Proxies
    let proxies: SyncEntityItem[] = [];
    if (en('connections.proxies')) {
      const proxiesRows = await allDb<any>(
        db,
        `SELECT uuid, name, type, host, port, username, auth_method, encrypted_password, encrypted_private_key, encrypted_passphrase, created_at, updated_at FROM proxies WHERE updated_at > ?`,
        [sinceTimestamp]
      );
      proxies = proxiesRows.map(r => ({
        uuid: r.uuid,
        updated_at: r.updated_at,
        data: {
          name: r.name,
          type: r.type,
          host: r.host,
          port: r.port,
          username: r.username,
          auth_method: r.auth_method,
          encrypted_password: envelopeCryptoService.convertLocalToEnvelope(r.encrypted_password, apiKey),
          encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(r.encrypted_private_key, apiKey),
          encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(r.encrypted_passphrase, apiKey),
          created_at: r.created_at,
          updated_at: r.updated_at
        }
      }));
    }

    // 5. 导出 Connections (解析 proxy_uuid, ssh_key_uuid 以及关联的 folder_uuids)
    let connections: SyncEntityItem[] = [];
    if (en('connections.hosts')) {
      const connectionsRows = await allDb<any>(
        db,
        `SELECT c.id, c.uuid, c.name, c.type, c.host, c.port, c.username, c.auth_method,
                c.encrypted_password, c.encrypted_private_key, c.encrypted_passphrase,
                c.proxy_type, c.notes, c.jump_chain, c.background_color, c.file_protocol,
                c.startup_command, c.sftp_sudo_enabled, c.encrypted_sudo_password,
                c.created_at, c.updated_at,
                p.uuid as proxy_uuid, sk.uuid as ssh_key_uuid
         FROM connections c
         LEFT JOIN proxies p ON c.proxy_id = p.id
         LEFT JOIN ssh_keys sk ON c.ssh_key_id = sk.id
         WHERE c.updated_at > ?`,
        [sinceTimestamp]
      );

      for (const r of connectionsRows) {
        const tagRows = await allDb<{ uuid: string }>(
          db,
          `SELECT t.uuid FROM connection_folders ct JOIN folders t ON ct.folder_id = t.id WHERE ct.connection_id = ?`,
          [r.id]
        );
        const tagUuids = tagRows.map(t => t.uuid).filter(Boolean);

        const highlightRows = await allDb<{ path: string; color: string }>(
          db,
          `SELECT path, color FROM file_color_highlights WHERE connection_id = ?`,
          [r.id]
        );

        connections.push({
          uuid: r.uuid,
          updated_at: r.updated_at,
          data: {
            name: r.name,
            type: r.type,
            host: r.host,
            port: r.port,
            username: r.username,
            auth_method: r.auth_method,
            encrypted_password: envelopeCryptoService.convertLocalToEnvelope(r.encrypted_password, apiKey),
            encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(r.encrypted_private_key, apiKey),
            encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(r.encrypted_passphrase, apiKey),
            proxy_uuid: r.proxy_uuid || null,
            proxy_type: r.proxy_type || null,
            ssh_key_uuid: r.ssh_key_uuid || null,
            notes: r.notes || null,
            jump_chain: r.jump_chain || null,
            background_color: r.background_color || null,
            file_protocol: r.file_protocol || 'auto',
            startup_command: r.startup_command || '',
            sftp_sudo_enabled: r.sftp_sudo_enabled ? 1 : 0,
            encrypted_sudo_password: envelopeCryptoService.convertLocalToEnvelope(r.encrypted_sudo_password, apiKey),
            folder_uuids: tagUuids,
            file_highlights: highlightRows,
            created_at: r.created_at,
            updated_at: r.updated_at
          }
        });
      }
    }

    // 6. 导出 QuickCommands (携带所属文件夹/文件夹 folder_uuids)
    let quick_commands: SyncEntityItem[] = [];
    if (en('quickCommands.items')) {
      const quickCmdRows = await allDb<any>(
        db,
        `SELECT id, uuid, name, command, usage_count, variables, background_color, created_at, updated_at FROM quick_commands WHERE updated_at > ?`,
        [sinceTimestamp]
      );
      for (const r of quickCmdRows) {
        const tagRows = await allDb<{ uuid: string }>(
          db,
          `SELECT qt.uuid FROM quick_command_folder_associations qa
           JOIN quick_command_folders qt ON qa.folder_id = qt.id
           WHERE qa.quick_command_id = ?`,
          [r.id]
        );
        const tagUuids = tagRows.map(t => t.uuid).filter(Boolean);

        quick_commands.push({
          uuid: r.uuid,
          updated_at: r.updated_at,
          data: {
            name: r.name,
            command: r.command,
            usage_count: r.usage_count,
            variables: r.variables,
            background_color: r.background_color || null,
            folder_uuids: tagUuids,
            created_at: r.created_at,
            updated_at: r.updated_at
          }
        });
      }
    }

    // 7. WorkspaceSync (快照)：桌面端数据库同步不推拉动态工作区会话，保持纯净数据同步
    let workspace_sync: SyncEntityItem[] = [];

    // 8. 导出 quick_command_folders
    let quick_command_folders: SyncEntityItem[] = [];
    if (en('quickCommands.folders')) {
      const qcFoldersRows = await allDb<any>(
        db,
        `SELECT uuid, name, background_color, updated_hlc, created_at, updated_at FROM quick_command_folders WHERE updated_at > ?`,
        [sinceTimestamp]
      );
      quick_command_folders = qcFoldersRows.map(r => ({
        uuid: r.uuid,
        updated_at: r.updated_at || Math.floor(Date.now() / 1000),
        data: {
          name: r.name,
          background_color: r.background_color || null
        }
      }));
    }

    // 9. 导出 settings (整库全量或增量设置项，严格排除本地私有配置)
    let settings: SyncEntityItem[] = [];
    if (anyLayout) {
      const allSettingsRows = await allDb<any>(
        db,
        `SELECT uuid, key, value, updated_hlc, updated_at FROM settings 
         WHERE (updated_at > ? OR key = 'layoutPresets')
           AND key NOT IN ('desktop_sync_config', 'syncApiKey') 
           AND key NOT LIKE 'desktop_%'`,
        [sinceTimestamp]
      );
      // settings 是混合表：只把启用子项对应的键带出去（布局预设 / 组件状态 / 焦点顺序 / 其它界面设置）
      const settingsRows = allSettingsRows.filter(r => isSettingsKeyEnabled(enabledItems, r.key));

      // 布局预设里的 connectionIds 是「本机自增 id」，对端 SQLite 的 id 完全不同。
      // 导出时附上一张 "本机 id -> uuid" 的翻译表，由接收端在落库前完成转换。
      // （不要在发送端直接改写数据：如果发送端本身是"汇聚端"，它的 id 同样是外来的，
      //  按本机连接翻译会把绑定指到错误的连接上。）
      // layoutPresets 每次同步都全量带一份（很小），保证升级后老数据也能被自动纠正一次。
      let connectionIdToUuid: Map<string, string> | null = null;
      const attachOriginConnectionMap = (raw: string): string => {
        try {
          const parsed = JSON.parse(raw);
          if (!parsed || !Array.isArray(parsed.presets)) return raw;

          const referencedIds = new Set<string>();
          for (const preset of parsed.presets) {
            if (!preset || typeof preset !== 'object') continue;
            const ids: unknown[] = Array.isArray(preset.connectionIds) ? preset.connectionIds : [];
            ids.forEach(id => referencedIds.add(String(id)));
          }
          if (parsed.connectionLayoutMap && typeof parsed.connectionLayoutMap === 'object') {
            Object.keys(parsed.connectionLayoutMap)
              .filter(key => /^\d+$/.test(key))
              .forEach(key => referencedIds.add(key));
          }
          if (referencedIds.size === 0) return raw;

          const originMap: Record<string, string> = {};
          for (const id of referencedIds) {
            const uuid = connectionIdToUuid?.get(id);
            if (uuid) originMap[id] = uuid;
          }
          parsed._originConnectionMap = originMap;
          return JSON.stringify(parsed);
        } catch {
          return raw;
        }
      };

      if (settingsRows.some(r => r.key === 'layoutPresets')) {
        const rows = await allDb<{ id: number; uuid: string }>(db, `SELECT id, uuid FROM connections WHERE uuid IS NOT NULL`);
        connectionIdToUuid = new Map(rows.map(r => [String(r.id), r.uuid]));
      }

      settings = settingsRows.map(r => ({
        uuid: r.uuid,
        updated_at: r.updated_at || Math.floor(Date.now() / 1000),
        data: {
          key: r.key,
          value: r.key === 'layoutPresets' ? attachOriginConnectionMap(r.value) : r.value
        }
      }));
    }

    // 10. 导出 appearance_settings (外观样式)
    let appearance_settings: SyncEntityItem[] = [];
    if (anyAppearance) {
      const appRows = await allDb<any>(
        db,
        `SELECT key, value, updated_at FROM appearance_settings WHERE updated_at > ?`,
        [sinceTimestamp]
      );
      appearance_settings = appRows
        .filter(r => isAppearanceKeyEnabled(enabledItems, r.key))
        .map(r => ({
          uuid: `app_${r.key}`,
          updated_at: r.updated_at || Math.floor(Date.now() / 1000),
          data: { key: r.key, value: r.value }
        }));
    }

    // 11. users (节点管理员账号密码遵循物理隔离原则，不跨节点同步)
    const users: SyncEntityItem[] = [];

    // 12. 导出 terminal_themes (仅同步自定义主题，系统内置 preset 预设主题两端一致无需同步)
    let terminal_themes: SyncEntityItem[] = [];
    if (en('appearance.terminalTheme')) {
      const themeRows = await allDb<any>(
        db,
        `SELECT * FROM terminal_themes WHERE updated_at > ? AND theme_type != 'preset'`,
        [sinceTimestamp]
      );
      terminal_themes = themeRows.map(r => ({
        uuid: `theme_${Buffer.from(r.name || '').toString('base64').replace(/=/g, '')}`,
        updated_at: r.updated_at || Math.floor(Date.now() / 1000),
        data: r
      }));
    }

    // 13. 导出 favorite_paths (常用路径，业务唯一标识 = path + 作用域 + 归属主机)
    let favorite_paths: SyncEntityItem[] = [];
    if (en('connections.favoritePaths')) {
      const favRows = await allDb<any>(
        db,
        `SELECT * FROM favorite_paths WHERE updated_at > ?`,
        [sinceTimestamp]
      );
      favorite_paths = favRows.map(r => {
        const scope = r.scope === 'host' ? 'host' : 'global';
        const connUuid = r.connection_uuid || '';
        // 同一路径可以同时存在「全局书签」和「某主机专属书签」，uuid 必须带上作用域才不撞
        const identity = scope === 'host' ? `${r.path || ''}|host|${connUuid}` : `${r.path || ''}|global`;
        return {
          uuid: `fav_${Buffer.from(identity).toString('base64').replace(/=/g, '')}`,
          updated_at: r.updated_at || Math.floor(Date.now() / 1000),
          data: { ...r, scope }
        };
      });
    }

    // 14. 导出 command_history (命令历史)
    let command_history: SyncEntityItem[] = [];
    if (en('commandHistory.history')) {
      const histRows = await allDb<any>(
        db,
        `SELECT id, uuid, command, timestamp, updated_hlc
         FROM command_history
         WHERE timestamp > ?
         ORDER BY timestamp DESC, id DESC
         LIMIT 1000`,
        [sinceTimestamp]
      );
      command_history = histRows.map(r => {
        const normalized = normalizeCommandText(r.command);
        return {
          uuid: r.uuid || generateDeterministicCommandUuid(normalized),
          updated_at: r.timestamp || Math.floor(Date.now() / 1000),
          data: { command: normalized || r.command, timestamp: r.timestamp }
        };
      });
    }

    return {
      entities: {
        folders,
        quick_command_folders,
        ssh_keys,
        proxies,
        connections,
        quick_commands,
        settings,
        appearance_settings,
        users,
        terminal_themes,
        favorite_paths,
        workspace_sync,
        command_history
      },
      tombstones
    };
  },

  /**
   * 应用传入的数据并按 LWW (Last-Write-Wins) 规则执行冲突合并 (支持按模块过滤)
   */
  async applyIncomingData(
    payload: {
      entities?: SyncExchangePayload['entities'];
      tombstones?: Array<{ entity_type: string; uuid: string; deleted_at: number }>;
    },
    apiKey: string,
    modules?: SyncModuleKey[]
  ): Promise<{ pushed: number; conflictsResolved: number }> {
    const db = await getDbInstance();
    const releaseLock = await acquireApplyLock();

    return await applyContext.run({ isApplying: true }, async () => {
      try {
        await runDb(db, 'UPDATE sync_state SET applying = 1 WHERE id = 1');
        let pushed = 0;
        let conflictsResolved = 0;

        const enabledItems = resolveSyncItems(modules as unknown as string[]);
        const en = (key: SyncItemKey) => enabledItems.has(key);
        const categoryFullyEnabled = (cat: SyncCategoryKey) =>
          CATEGORY_ITEMS[cat].every(i => enabledItems.has(i));
        const anyAppearance = CATEGORY_ITEMS.appearance.some(i => enabledItems.has(i));
        const anyLayout = CATEGORY_ITEMS.layout.some(i => enabledItems.has(i));

        const { entities = {}, tombstones = [] } = payload;

    // --- 步骤 1: 处理删除墓碑 ---
    for (const t of tombstones) {
      // 混合表不知道墓碑对应哪个 key，只勾了部分子项时不删
      if (t.entity_type === 'settings' && !categoryFullyEnabled('layout')) continue;
      if (t.entity_type === 'appearance_settings' && !categoryFullyEnabled('appearance')) continue;
      if (!isTableEnabled(enabledItems, t.entity_type)) continue;

      if (t.entity_type === 'connections') {
        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM connections WHERE uuid = ?`,
          [t.uuid]
        );
        if (local) {
          if (local.updated_at <= t.deleted_at) {
            await runDb(db, `DELETE FROM connections WHERE uuid = ?`, [t.uuid]);
            await recordTombstone('connections', t.uuid, t.deleted_at);
            pushed++;
          } else {
            conflictsResolved++; // 本地修改比远端删除更新，保留本地
          }
        }
      } else if (t.entity_type === 'proxies') {
        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM proxies WHERE uuid = ?`,
          [t.uuid]
        );
        if (local) {
          if (local.updated_at <= t.deleted_at) {
            await runDb(db, `DELETE FROM proxies WHERE uuid = ?`, [t.uuid]);
            await recordTombstone('proxies', t.uuid, t.deleted_at);
            pushed++;
          } else {
            conflictsResolved++;
          }
        }
      } else if (t.entity_type === 'ssh_keys') {
        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM ssh_keys WHERE uuid = ?`,
          [t.uuid]
        );
        if (local) {
          if (local.updated_at <= t.deleted_at) {
            await runDb(db, `DELETE FROM ssh_keys WHERE uuid = ?`, [t.uuid]);
            await recordTombstone('ssh_keys', t.uuid, t.deleted_at);
            pushed++;
          } else {
            conflictsResolved++;
          }
        }
      } else if (t.entity_type === 'folders') {
        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM folders WHERE uuid = ?`,
          [t.uuid]
        );
        if (local) {
          if (local.updated_at <= t.deleted_at) {
            await runDb(db, `DELETE FROM folders WHERE uuid = ?`, [t.uuid]);
            await recordTombstone('folders', t.uuid, t.deleted_at);
            pushed++;
          } else {
            conflictsResolved++;
          }
        }
      } else if (t.entity_type === 'quick_commands') {
        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM quick_commands WHERE uuid = ?`,
          [t.uuid]
        );
        if (local) {
          if (local.updated_at <= t.deleted_at) {
            await runDb(db, `DELETE FROM quick_commands WHERE uuid = ?`, [t.uuid]);
            await recordTombstone('quick_commands', t.uuid, t.deleted_at);
            pushed++;
          } else {
            conflictsResolved++;
          }
        }
      } else if (t.entity_type === 'quick_command_folders') {
        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM quick_command_folders WHERE uuid = ?`,
          [t.uuid]
        );
        if (local) {
          if (local.updated_at <= t.deleted_at) {
            await runDb(db, `DELETE FROM quick_command_folders WHERE uuid = ?`, [t.uuid]);
            await recordTombstone('quick_command_folders', t.uuid, t.deleted_at);
            pushed++;
          } else {
            conflictsResolved++;
          }
        }
      } else if (t.entity_type === 'command_history') {
        const local = await getDb<{ id: number; timestamp: number }>(
          db,
          `SELECT id, timestamp FROM command_history WHERE uuid = ?`,
          [t.uuid]
        );
        const deletedSec = normalizeTimestampSeconds(t.deleted_at);
        if (local) {
          if ((local.timestamp || 0) <= deletedSec) {
            await runDb(db, `DELETE FROM command_history WHERE uuid = ?`, [t.uuid]);
            await recordTombstone('command_history', t.uuid, deletedSec);
            pushed++;
          } else {
            conflictsResolved++;
          }
        }
      }
    }

    // --- 步骤 2: 合并 Folders ---
    if (en('connections.folders') && entities.folders) {
      for (const item of entities.folders) {
        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM folders WHERE uuid = ?`,
          [item.uuid]
        );
        if (!local) {
          // 检查 name 是否重复
          const existingName = await getDb<{ id: number }>(
            db,
            `SELECT id FROM folders WHERE name = ?`,
            [item.data.name]
          );
          if (existingName) {
            await runDb(db, `UPDATE folders SET uuid = ?, background_color = ?, updated_at = ? WHERE id = ?`, [
              item.uuid,
              item.data.background_color || null,
              item.updated_at,
              existingName.id
            ]);
          } else {
            await runDb(
              db,
              `INSERT INTO folders (uuid, name, background_color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
              [item.uuid, item.data.name, item.data.background_color || null, item.data.created_at || item.updated_at, item.updated_at]
            );
          }
          pushed++;
        } else if (item.updated_at > local.updated_at) {
          await runDb(db, `UPDATE folders SET name = ?, background_color = ?, updated_at = ? WHERE uuid = ?`, [
            item.data.name,
            item.data.background_color || null,
            item.updated_at,
            item.uuid
          ]);
          pushed++;
          conflictsResolved++;
        }
      }
    }

    // --- 步骤 2.5: 合并 quick_command_folders ---
    if (en('quickCommands.folders') && entities.quick_command_folders) {
      for (const item of entities.quick_command_folders) {
        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM quick_command_folders WHERE uuid = ?`,
          [item.uuid]
        );
        if (!local) {
          const existingName = await getDb<{ id: number }>(
            db,
            `SELECT id FROM quick_command_folders WHERE name = ?`,
            [item.data.name]
          );
          if (existingName) {
            await runDb(db, `UPDATE quick_command_folders SET uuid = ?, background_color = ?, updated_at = ? WHERE id = ?`, [
              item.uuid,
              item.data.background_color || null,
              item.updated_at,
              existingName.id
            ]);
          } else {
            await runDb(
              db,
              `INSERT INTO quick_command_folders (uuid, name, background_color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
              [item.uuid, item.data.name, item.data.background_color || null, item.data.created_at || item.updated_at, item.updated_at]
            );
          }
          pushed++;
        } else if (item.updated_at > local.updated_at) {
          await runDb(db, `UPDATE quick_command_folders SET name = ?, background_color = ?, updated_at = ? WHERE uuid = ?`, [
            item.data.name,
            item.data.background_color || null,
            item.updated_at,
            item.uuid
          ]);
          pushed++;
          conflictsResolved++;
        }
      }
    }

    // --- 步骤 3: 合并 SshKeys ---
    if (en('connections.keys') && entities.ssh_keys) {
      for (const item of entities.ssh_keys) {
        const localEncKey = envelopeCryptoService.convertEnvelopeToLocal(item.data.encrypted_private_key, apiKey);
        const localEncPass = envelopeCryptoService.convertEnvelopeToLocal(item.data.encrypted_passphrase, apiKey);

        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM ssh_keys WHERE uuid = ?`,
          [item.uuid]
        );
        if (!local) {
          // 检查同名
          const existingName = await getDb<{ id: number }>(
            db,
            `SELECT id FROM ssh_keys WHERE name = ?`,
            [item.data.name]
          );
          if (existingName) {
            await runDb(
              db,
              `UPDATE ssh_keys SET uuid = ?, encrypted_private_key = ?, encrypted_passphrase = ?, updated_at = ? WHERE id = ?`,
              [item.uuid, localEncKey, localEncPass, item.updated_at, existingName.id]
            );
          } else {
            await runDb(
              db,
              `INSERT INTO ssh_keys (uuid, name, encrypted_private_key, encrypted_passphrase, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
              [item.uuid, item.data.name, localEncKey, localEncPass, item.data.created_at || item.updated_at, item.updated_at]
            );
          }
          pushed++;
        } else if (item.updated_at > local.updated_at) {
          await runDb(
            db,
            `UPDATE ssh_keys SET name = ?, encrypted_private_key = ?, encrypted_passphrase = ?, updated_at = ? WHERE uuid = ?`,
            [item.data.name, localEncKey, localEncPass, item.updated_at, item.uuid]
          );
          pushed++;
          conflictsResolved++;
        }
      }
    }

    // --- 步骤 4: 合并 Proxies ---
    if (en('connections.proxies') && entities.proxies) {
      for (const item of entities.proxies) {
        const localEncPwd = envelopeCryptoService.convertEnvelopeToLocal(item.data.encrypted_password, apiKey);
        const localEncKey = envelopeCryptoService.convertEnvelopeToLocal(item.data.encrypted_private_key, apiKey);
        const localEncPass = envelopeCryptoService.convertEnvelopeToLocal(item.data.encrypted_passphrase, apiKey);

        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM proxies WHERE uuid = ?`,
          [item.uuid]
        );
        if (!local) {
          await runDb(
            db,
            `INSERT INTO proxies (uuid, name, type, host, port, username, auth_method, encrypted_password, encrypted_private_key, encrypted_passphrase, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              item.uuid,
              item.data.name,
              item.data.type,
              item.data.host,
              item.data.port,
              item.data.username || null,
              item.data.auth_method || 'none',
              localEncPwd,
              localEncKey,
              localEncPass,
              item.data.created_at || item.updated_at,
              item.updated_at
            ]
          );
          pushed++;
        } else if (item.updated_at > local.updated_at) {
          await runDb(
            db,
            `UPDATE proxies SET name = ?, type = ?, host = ?, port = ?, username = ?, auth_method = ?,
                                encrypted_password = ?, encrypted_private_key = ?, encrypted_passphrase = ?, updated_at = ?
             WHERE uuid = ?`,
            [
              item.data.name,
              item.data.type,
              item.data.host,
              item.data.port,
              item.data.username || null,
              item.data.auth_method || 'none',
              localEncPwd,
              localEncKey,
              localEncPass,
              item.updated_at,
              item.uuid
            ]
          );
          pushed++;
          conflictsResolved++;
        }
      }
    }

    // --- 步骤 5: 合并 Connections ---
    if (en('connections.hosts') && entities.connections) {
      for (const item of entities.connections) {
        const localEncPwd = envelopeCryptoService.convertEnvelopeToLocal(item.data.encrypted_password, apiKey);
        const localEncKey = envelopeCryptoService.convertEnvelopeToLocal(item.data.encrypted_private_key, apiKey);
        const localEncPass = envelopeCryptoService.convertEnvelopeToLocal(item.data.encrypted_passphrase, apiKey);
        const localEncSudo = envelopeCryptoService.convertEnvelopeToLocal(item.data.encrypted_sudo_password, apiKey);

        // 解析依赖关系 ID
        let resolvedProxyId: number | null = null;
        if (item.data.proxy_uuid) {
          const p = await getDb<{ id: number }>(db, `SELECT id FROM proxies WHERE uuid = ?`, [item.data.proxy_uuid]);
          if (p) resolvedProxyId = p.id;
        }

        let resolvedSshKeyId: number | null = null;
        if (item.data.ssh_key_uuid) {
          const k = await getDb<{ id: number }>(db, `SELECT id FROM ssh_keys WHERE uuid = ?`, [item.data.ssh_key_uuid]);
          if (k) resolvedSshKeyId = k.id;
        }

        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM connections WHERE uuid = ?`,
          [item.uuid]
        );

        let targetConnectionId: number;

        if (!local) {
          const insertResult = await runDb(
            db,
            `INSERT INTO connections (uuid, name, type, host, port, username, auth_method,
                                     encrypted_password, encrypted_private_key, encrypted_passphrase,
                                     proxy_id, proxy_type, ssh_key_id, notes, jump_chain, background_color,
                                     file_protocol, startup_command, sftp_sudo_enabled, encrypted_sudo_password,
                                     created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              item.uuid,
              item.data.name || null,
              item.data.type || 'SSH',
              item.data.host,
              item.data.port,
              item.data.username,
              item.data.auth_method,
              localEncPwd,
              localEncKey,
              localEncPass,
              resolvedProxyId,
              item.data.proxy_type || null,
              resolvedSshKeyId,
              item.data.notes || null,
              item.data.jump_chain ? JSON.stringify(item.data.jump_chain) : null,
              item.data.background_color || null,
              item.data.file_protocol || 'auto',
              item.data.startup_command || '',
              item.data.sftp_sudo_enabled ? 1 : 0,
              localEncSudo,
              item.data.created_at || item.updated_at,
              item.updated_at
            ]
          );
          targetConnectionId = insertResult.lastID;
          pushed++;
        } else if (item.updated_at > local.updated_at) {
          await runDb(
            db,
            `UPDATE connections SET name = ?, type = ?, host = ?, port = ?, username = ?, auth_method = ?,
                                   encrypted_password = ?, encrypted_private_key = ?, encrypted_passphrase = ?,
                                   proxy_id = ?, proxy_type = ?, ssh_key_id = ?, notes = ?, jump_chain = ?, background_color = ?,
                                   file_protocol = ?, startup_command = ?, sftp_sudo_enabled = ?, encrypted_sudo_password = ?, updated_at = ?
             WHERE uuid = ?`,
            [
              item.data.name || null,
              item.data.type || 'SSH',
              item.data.host,
              item.data.port,
              item.data.username,
              item.data.auth_method,
              localEncPwd,
              localEncKey,
              localEncPass,
              resolvedProxyId,
              item.data.proxy_type || null,
              resolvedSshKeyId,
              item.data.notes || null,
              item.data.jump_chain ? JSON.stringify(item.data.jump_chain) : null,
              item.data.background_color || null,
              item.data.file_protocol || 'auto',
              item.data.startup_command || '',
              item.data.sftp_sudo_enabled ? 1 : 0,
              localEncSudo,
              item.updated_at,
              item.uuid
            ]
          );
          targetConnectionId = local.id;
          pushed++;
          conflictsResolved++;
        } else {
          targetConnectionId = local.id;
        }

        // 重新对齐 connection_folders
        if (targetConnectionId && Array.isArray(item.data.folder_uuids)) {
          await runDb(db, `DELETE FROM connection_folders WHERE connection_id = ?`, [targetConnectionId]);
          for (const tUuid of item.data.folder_uuids) {
            const t = await getDb<{ id: number }>(db, `SELECT id FROM folders WHERE uuid = ?`, [tUuid]);
            if (t) {
              await runDb(db, `INSERT OR IGNORE INTO connection_folders (connection_id, folder_id) VALUES (?, ?)`, [
                targetConnectionId,
                t.id
              ]);
            }
          }
        }

        // 重新对齐 file_color_highlights 文件颜色高亮
        if (targetConnectionId && Array.isArray(item.data.file_highlights)) {
          await runDb(db, `DELETE FROM file_color_highlights WHERE connection_id = ?`, [targetConnectionId]);
          const now = Math.floor(Date.now() / 1000);
          for (const fh of item.data.file_highlights) {
            if (fh && fh.path && fh.color) {
              await runDb(
                db,
                `INSERT OR REPLACE INTO file_color_highlights (connection_id, path, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
                [targetConnectionId, fh.path, fh.color, now, now]
              );
            }
          }
        }
      }
    }

    // --- 步骤 6: 合并 QuickCommands ---
    if (en('quickCommands.items') && entities.quick_commands) {
      for (const item of entities.quick_commands) {
        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM quick_commands WHERE uuid = ?`,
          [item.uuid]
        );
        let qcPhysId: number | null = null;
        if (!local) {
          const insRes = await runDb(
            db,
            `INSERT INTO quick_commands (uuid, name, command, usage_count, variables, background_color, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              item.uuid,
              item.data.name || null,
              item.data.command,
              item.data.usage_count || 0,
              item.data.variables || null,
              item.data.background_color || null,
              item.data.created_at || item.updated_at,
              item.updated_at
            ]
          );
          qcPhysId = insRes.lastID;
          pushed++;
        } else if (item.updated_at > local.updated_at) {
          await runDb(
            db,
            `UPDATE quick_commands SET name = ?, command = ?, usage_count = ?, variables = ?, background_color = ?, updated_at = ? WHERE uuid = ?`,
            [
              item.data.name || null,
              item.data.command,
              item.data.usage_count || 0,
              item.data.variables || null,
              item.data.background_color || null,
              item.updated_at,
              item.uuid
            ]
          );
          qcPhysId = local.id;
          pushed++;
          conflictsResolved++;
        } else {
          qcPhysId = local.id;
        }

        // 对齐快捷命令文件夹关联 quick_command_folder_associations
        if (qcPhysId && Array.isArray(item.data.folder_uuids)) {
          await runDb(db, `DELETE FROM quick_command_folder_associations WHERE quick_command_id = ?`, [qcPhysId]);
          for (const tUuid of item.data.folder_uuids) {
            const t = await getDb<{ id: number }>(db, `SELECT id FROM quick_command_folders WHERE uuid = ?`, [tUuid]);
            if (t) {
              await runDb(db, `INSERT OR IGNORE INTO quick_command_folder_associations (quick_command_id, folder_id) VALUES (?, ?)`, [
                qcPhysId,
                t.id
              ]);
            }
          }
        }
      }
    }

    // --- 步骤 6.5: 合并 Settings (系统设置项整库覆盖与增量同步) ---
    if (anyLayout && entities.settings && entities.settings.length > 0) {
      const nowSec = Math.floor(Date.now() / 1000);

      /**
       * 布局预设落库前，把对方设备的"本地连接 id"翻译成跨端稳定的 uuid。
       * 导出端会附带 `_originConnectionMap`（id -> uuid），这里用它做转换，
       * 然后丢掉对本机毫无意义的 connectionIds。
       */
      const normalizeIncomingLayoutPresets = (raw: string): string => {
        try {
          const parsed = JSON.parse(raw);
          if (!parsed || !Array.isArray(parsed.presets)) return raw;
          const originMap: Record<string, string> | null =
            parsed._originConnectionMap && typeof parsed._originConnectionMap === 'object'
              ? parsed._originConnectionMap
              : null;

          for (const preset of parsed.presets) {
            if (!preset || typeof preset !== 'object') continue;
            const uuids = new Set<string>(
              Array.isArray(preset.connectionUuids)
                ? preset.connectionUuids.filter((u: unknown) => typeof u === 'string' && u.length > 0)
                : []
            );
            if (originMap) {
              const ids: unknown[] = Array.isArray(preset.connectionIds) ? preset.connectionIds : [];
              for (const id of ids) {
                const uuid = originMap[String(id)];
                if (uuid) uuids.add(uuid);
              }
            }
            if (uuids.size > 0) {
              preset.connectionUuids = Array.from(uuids);
              // 对方的自增 id 在本机没有任何意义，清掉避免以后被误用
              delete preset.connectionIds;
            }
          }

          if (parsed.connectionLayoutMap && typeof parsed.connectionLayoutMap === 'object') {
            const nextMap: Record<string, string> = {};
            for (const key of Object.keys(parsed.connectionLayoutMap)) {
              const presetId = parsed.connectionLayoutMap[key];
              const uuid = originMap?.[key] || (/^\d+$/.test(key) ? null : key);
              // 数字 key 且翻译不出 uuid（老版本发送端）：保留原样，走兼容路径
              nextMap[uuid || key] = presetId;
            }
            parsed.connectionLayoutMap = nextMap;
          }

          delete parsed._originConnectionMap;
          return JSON.stringify(parsed);
        } catch {
          return raw;
        }
      };

      for (const item of entities.settings) {
        const settingKey = item.data.key;
        if (settingKey === 'desktop_sync_config' || settingKey === 'syncApiKey' || (typeof settingKey === 'string' && settingKey.startsWith('desktop_'))) {
          continue; // 保护本地私有配置
        }
        // 只应用启用子项对应的键（布局预设 / 组件状态 / 焦点顺序 / 其它界面设置各自独立）
        if (!isSettingsKeyEnabled(enabledItems, settingKey)) continue;
        const rawSettingVal = typeof item.data.value === 'string' ? item.data.value : String(item.data.value || '');
        const settingVal = settingKey === 'layoutPresets'
          ? normalizeIncomingLayoutPresets(rawSettingVal)
          : rawSettingVal;
        const local = await getDb<{ updated_at: number }>(
          db,
          `SELECT updated_at FROM settings WHERE key = ?`,
          [settingKey]
        );
        // v1（全量/手动同步）用 updated_at（秒级）做 LWW，v2（增量）用 updated_hlc。
        // 两个引擎必须互相同步版本元数据，否则「v1 写进去的值在 v2 眼里是旧的」，
        // 下一次增量同步就会被对端的旧值按 stale 顶回来 —— 这正是「手动同步完，
        // 刷新网页又变回原来的设置」。
        const appliedHlc = `${String(Date.now()).padStart(13, '0')}-00000-v1apply`;
        if (!local) {
          await runDb(
            db,
            `INSERT INTO settings (key, value, created_at, updated_at, uuid, updated_hlc) VALUES (?, ?, ?, ?, ?, ?)`,
            [settingKey, settingVal, nowSec, item.updated_at || nowSec, item.uuid, appliedHlc]
          );
          pushed++;
        } else if ((item.updated_at || nowSec) > (local.updated_at || 0)) {
          // 注意用严格大于：秒级时间戳下两端常常落在同一秒，
          // 用 >= 会让「刚在本地改完」的值被同一秒的旧值顶回去。
          await runDb(
            db,
            `UPDATE settings SET value = ?, uuid = COALESCE(settings.uuid, ?), updated_at = ?, updated_hlc = ? WHERE key = ?`,
            [settingVal, item.uuid, item.updated_at || nowSec, appliedHlc, settingKey]
          );
          pushed++;
        } else {
          conflictsResolved++;
        }
      }
    }

    // --- 步骤 8: 合并 appearance_settings (外观样式，采用基于时间的 LWW 判定) ---
    if (anyAppearance && entities.appearance_settings && entities.appearance_settings.length > 0) {
      const nowSec = Math.floor(Date.now() / 1000);
      for (const item of entities.appearance_settings) {
        // 按 key 再细分：只应用启用子项（终端主题/字体/背景/文字特效/UI 主题/高亮…）
        if (!isAppearanceKeyEnabled(enabledItems, item.data.key)) continue;
        const local = await getDb<{ updated_at: number }>(
          db,
          `SELECT updated_at FROM appearance_settings WHERE key = ?`,
          [item.data.key]
        );
        if (!local) {
          await runDb(
            db,
            `INSERT INTO appearance_settings (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)`,
            [item.data.key, item.data.value, nowSec, item.updated_at || nowSec]
          );
          pushed++;
        } else if ((item.updated_at || nowSec) > (local.updated_at || 0)) {
          // 与 settings 一致：秒级时间戳下必须用严格大于，
          // 否则同一秒内刚改完的值会被对端的旧值顶回去
          await runDb(
            db,
            `UPDATE appearance_settings SET value = ?, updated_at = ? WHERE key = ?`,
            [item.data.value, item.updated_at || nowSec, item.data.key]
          );
          pushed++;
        } else {
          conflictsResolved++;
        }
      }
    }

    // --- 步骤 9: 账号凭据隔离 (各节点管理员 users 账号密码物理隔离，绝对不跨节点覆盖) ---

    // --- 步骤 10: 合并 terminal_themes (终端主题，保护 preset 预设，自定义主题按 name 合并) ---
    if (en('appearance.terminalTheme') && entities.terminal_themes && entities.terminal_themes.length > 0) {
      for (const item of entities.terminal_themes) {
        const d = item.data;
        if (!d || !d.name || d.theme_type === 'preset') continue; // 绝对跳过预设主题

        const local = await getDb<{ id: number; updated_at: number }>(
          db,
          `SELECT id, updated_at FROM terminal_themes WHERE name = ?`,
          [d.name]
        );

        if (!local) {
          await runDb(
            db,
            `INSERT INTO terminal_themes (
               name, theme_type, foreground, background, cursor, cursor_accent, selection_background,
               black, red, green, yellow, blue, magenta, cyan, white,
               bright_black, bright_red, bright_green, bright_yellow, bright_blue, bright_magenta, bright_cyan, bright_white,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              d.name, 'user', d.foreground, d.background, d.cursor, d.cursor_accent, d.selection_background,
              d.black, d.red, d.green, d.yellow, d.blue, d.magenta, d.cyan, d.white,
              d.bright_black, d.bright_red, d.bright_green, d.bright_yellow, d.bright_blue, d.bright_magenta, d.bright_cyan, d.bright_white,
              d.created_at || item.updated_at, d.updated_at
            ]
          );
          pushed++;
        } else if (item.updated_at > (local.updated_at || 0)) {
          await runDb(
            db,
            `UPDATE terminal_themes SET
               foreground = ?, background = ?, cursor = ?, cursor_accent = ?, selection_background = ?,
               black = ?, red = ?, green = ?, yellow = ?, blue = ?, magenta = ?, cyan = ?, white = ?,
               bright_black = ?, bright_red = ?, bright_green = ?, bright_yellow = ?, bright_blue = ?, bright_magenta = ?, bright_cyan = ?, bright_white = ?,
               updated_at = ?
             WHERE id = ?`,
            [
              d.foreground, d.background, d.cursor, d.cursor_accent, d.selection_background,
              d.black, d.red, d.green, d.yellow, d.blue, d.magenta, d.cyan, d.white,
              d.bright_black, d.bright_red, d.bright_green, d.bright_yellow, d.bright_blue, d.bright_magenta, d.bright_cyan, d.bright_white,
              item.updated_at, local.id
            ]
          );
          pushed++;
          conflictsResolved++;
        }
      }
    }

    // --- 步骤 11: 合并 favorite_paths (业务唯一标识 = path + 作用域 + 归属主机，保留本地物理自增ID) ---
    if (en('connections.favoritePaths') && entities.favorite_paths && entities.favorite_paths.length > 0) {
      for (const item of entities.favorite_paths) {
        const d = item.data;
        if (!d || !d.path) continue;

        const scope = d.scope === 'host' ? 'host' : 'global';
        const connUuid = scope === 'host' ? (d.connection_uuid || null) : null;

        const local = await getDb<{ id: number; last_used_at: number; updated_at: number }>(
          db,
          `SELECT id, last_used_at, updated_at FROM favorite_paths
           WHERE path = ? AND scope = ? AND IFNULL(connection_uuid, '') = ?`,
          [d.path, scope, connUuid || '']
        );

        if (!local) {
          await runDb(
            db,
            `INSERT INTO favorite_paths (name, path, is_file, scope, connection_uuid, last_used_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [d.name || null, d.path, d.is_file ? 1 : 0, scope, connUuid, d.last_used_at || null, d.created_at || item.updated_at, item.updated_at]
          );
          pushed++;
        } else if (item.updated_at > (local.updated_at || 0)) {
          const maxLastUsed = Math.max(local.last_used_at || 0, d.last_used_at || 0) || null;
          await runDb(
            db,
            `UPDATE favorite_paths SET name = ?, is_file = ?, scope = ?, connection_uuid = ?, last_used_at = ?, updated_at = ? WHERE id = ?`,
            [d.name || null, d.is_file ? 1 : 0, scope, connUuid, maxLastUsed, item.updated_at, local.id]
          );
          pushed++;
          conflictsResolved++;
        }
      }
    }

    // --- 步骤 12: 合并 command_history (命令历史，按 command 去重并携带确定性 UUID 与 HLC) ---
    if (en('commandHistory.history') && entities.command_history && entities.command_history.length > 0) {
      let maxV1CmdMs = 0;
      for (const item of entities.command_history) {
        const cmd = normalizeCommandText(item?.data?.command);
        if (!cmd) continue;

        const detUuid = generateDeterministicCommandUuid(cmd);
        const ts = normalizeTimestampSeconds(item.data.timestamp || item.updated_at);

        // 若本地存在不旧于该执行时间的删除墓碑，禁止逆向复活
        const tomb = await getDb<{ deleted_hlc: string; deleted_at: number }>(
          db,
          `SELECT deleted_hlc, deleted_at FROM sync_tombstones WHERE tbl = 'command_history' AND row_id = ?`,
          [detUuid]
        );
        if (tomb) {
          const tombSec = normalizeTimestampSeconds(tomb.deleted_at, 0);
          if (tombSec >= ts) {
            conflictsResolved++;
            continue;
          }
        }

        const cmdMs = ts * 1000;
        if (cmdMs > maxV1CmdMs) maxV1CmdMs = cmdMs;
        const v1Hlc = `${String(cmdMs).padStart(13, '0')}-00000-v1sync`;

        const beforeExisting = await getDb<{ id: number; timestamp: number; uuid: string | null }>(
          db,
          `SELECT id, timestamp, uuid FROM command_history WHERE command = ? LIMIT 1`,
          [cmd]
        );

        await runDb(
          db,
          `INSERT INTO command_history (uuid, command, timestamp, updated_hlc)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(command) DO UPDATE SET
             timestamp = MAX(command_history.timestamp, excluded.timestamp),
             uuid = excluded.uuid,
             updated_hlc = CASE
               WHEN command_history.updated_hlc IS NULL OR command_history.updated_hlc = '' THEN excluded.updated_hlc
               WHEN excluded.timestamp > command_history.timestamp THEN excluded.updated_hlc
               ELSE command_history.updated_hlc
             END`,
          [detUuid, cmd, ts, v1Hlc]
        );

        if (tomb) {
          await runDb(db, `DELETE FROM sync_tombstones WHERE tbl = 'command_history' AND row_id = ?`, [detUuid]);
        }

        if (!beforeExisting || ts > (beforeExisting.timestamp || 0) || beforeExisting.uuid !== detUuid) {
          pushed++;
        }
      }

      if (maxV1CmdMs > 0) {
        await runDb(db, `UPDATE sync_state SET hlc_ms = MAX(hlc_ms, ?) WHERE id = 1`, [maxV1CmdMs]);
      }
    }

    // --- 步骤 7: 合并 WorkspaceSync (工作区快照，仅在未指定特定模块的全量同步时执行) ---
    const isFullSync = !modules || modules.length === 0;
    if (isFullSync && entities.workspace_sync && entities.workspace_sync.length > 0) {
      for (const item of entities.workspace_sync) {
        const targetUserId = item.data.user_id || 1;
        const local = await getDb<{ updated_at: number }>(
          db,
          `SELECT updated_at FROM workspace_sync WHERE user_id = ?`,
          [targetUserId]
        );
        if (!local) {
          await runDb(
            db,
            `INSERT INTO workspace_sync (user_id, state, active_client_id, updated_at) VALUES (?, ?, ?, ?)`,
            [targetUserId, item.data.state || '{}', item.data.active_client_id || null, item.updated_at]
          );
          pushed++;
          if (item.data.active_client_id) {
            try {
              await workspaceSyncService.suspendOtherClientsSessions(targetUserId, item.data.active_client_id);
              workspaceSyncService.notifyOtherClientsTakeover(targetUserId, item.data.active_client_id);
            } catch (err: any) {
              console.warn('[SyncService] 广播工作区接管踢出通知失败:', err.message);
            }
          }
        } else if (item.updated_at > local.updated_at) {
          await runDb(
            db,
            `UPDATE workspace_sync SET state = ?, active_client_id = ?, updated_at = ? WHERE user_id = ?`,
            [item.data.state || '{}', item.data.active_client_id || null, item.updated_at, targetUserId]
          );
          pushed++;
          conflictsResolved++;
          if (item.data.active_client_id) {
            try {
              await workspaceSyncService.suspendOtherClientsSessions(targetUserId, item.data.active_client_id);
              workspaceSyncService.notifyOtherClientsTakeover(targetUserId, item.data.active_client_id);
            } catch (err: any) {
              console.warn('[SyncService] 广播工作区接管踢出通知失败:', err.message);
            }
          }
        }
      }
    }

        return { pushed, conflictsResolved };
      } finally {
        await runDb(db, 'UPDATE sync_state SET applying = 0 WHERE id = 1');
      }
    }).finally(() => {
      releaseLock();
    });
  },

  /**
   * 清空所有可同步的实体表与墓碑 (用于强制覆盖场景，支持按模块细粒度清空)
   * 核心铁律：必须处于 applying=1 独占锁中执行，严禁触发 SQLite 触发器生成删除墓碑或向 sync_changes 写入幽灵变更！
   */
  async clearSyncTables(modules?: SyncModuleKey[]): Promise<void> {
    const db = await getDbInstance();
    const releaseLock = await acquireApplyLock();

    return await applyContext.run({ isApplying: true }, async () => {
      try {
        await runDb(db, 'UPDATE sync_state SET applying = 1 WHERE id = 1');
        await runDb(db, 'PRAGMA foreign_keys = OFF');

        const enabledItems = resolveSyncItems(modules as unknown as string[]);
        const en = (key: SyncItemKey) => enabledItems.has(key);
        const isFullSync = !modules || modules.length === 0;

        if (en('connections.hosts')) {
          await runDb(db, 'DELETE FROM connection_folders');
          await runDb(db, 'DELETE FROM file_color_highlights');
          await runDb(db, 'DELETE FROM port_forwards');
          await runDb(db, 'DELETE FROM connections');
          await runDb(db, `DELETE FROM sync_tombstones WHERE tbl IN ('connections', 'port_forwards', 'file_color_highlights')`);
          await runDb(db, `DELETE FROM sync_changes WHERE tbl IN ('connections', 'port_forwards', 'file_color_highlights')`);
          await runDb(db, `DELETE FROM sync_pending_references WHERE child_tbl = 'connections'`);
        }
        if (en('connections.folders')) {
          await runDb(db, 'DELETE FROM connection_folders');
          await runDb(db, 'DELETE FROM folders');
          await runDb(db, `DELETE FROM sync_tombstones WHERE tbl = 'folders'`);
          await runDb(db, `DELETE FROM sync_changes WHERE tbl = 'folders'`);
        }
        if (en('connections.keys')) {
          await runDb(db, 'DELETE FROM ssh_keys');
          await runDb(db, `DELETE FROM sync_tombstones WHERE tbl = 'ssh_keys'`);
          await runDb(db, `DELETE FROM sync_changes WHERE tbl = 'ssh_keys'`);
          await runDb(db, `DELETE FROM sync_pending_references WHERE target_tbl = 'ssh_keys'`);
        }
        if (en('connections.proxies')) {
          await runDb(db, 'DELETE FROM proxies');
          await runDb(db, `DELETE FROM sync_tombstones WHERE tbl = 'proxies'`);
          await runDb(db, `DELETE FROM sync_changes WHERE tbl = 'proxies'`);
          await runDb(db, `DELETE FROM sync_pending_references WHERE target_tbl = 'proxies'`);
        }
        if (en('connections.favoritePaths')) {
          await runDb(db, 'DELETE FROM favorite_paths');
          await runDb(db, `DELETE FROM sync_tombstones WHERE tbl = 'favorite_paths'`);
          await runDb(db, `DELETE FROM sync_changes WHERE tbl = 'favorite_paths'`);
        }

        if (en('quickCommands.items')) {
          await runDb(db, 'DELETE FROM quick_command_folder_associations');
          await runDb(db, 'DELETE FROM quick_commands');
          await runDb(db, `DELETE FROM sync_tombstones WHERE tbl = 'quick_commands'`);
          await runDb(db, `DELETE FROM sync_changes WHERE tbl = 'quick_commands'`);
        }
        if (en('quickCommands.folders')) {
          await runDb(db, 'DELETE FROM quick_command_folder_associations');
          await runDb(db, 'DELETE FROM quick_command_folders');
          await runDb(db, `DELETE FROM sync_tombstones WHERE tbl = 'quick_command_folders'`);
          await runDb(db, `DELETE FROM sync_changes WHERE tbl = 'quick_command_folders'`);
        }

        // settings 是混合表：只清掉被启用子项对应的键，避免「只覆盖布局预设」把焦点切换顺序也删了
        if (CATEGORY_ITEMS.layout.some(k => en(k))) {
          const allSettingRows = await allDb<{ key: string }>(
            db,
            `SELECT key FROM settings WHERE key NOT IN ('desktop_sync_config', 'syncApiKey') AND key NOT LIKE 'desktop_%'`
          );
          for (const row of allSettingRows) {
            if (!isSettingsKeyEnabled(enabledItems, row.key)) continue;
            await runDb(db, 'DELETE FROM settings WHERE key = ?', [row.key]);
          }
          await runDb(db, `DELETE FROM sync_tombstones WHERE tbl = 'settings'`);
          await runDb(db, `DELETE FROM sync_changes WHERE tbl = 'settings'`);
        }

        if (CATEGORY_ITEMS.appearance.some(k => en(k))) {
          const allAppearanceRows = await allDb<{ key: string }>(db, 'SELECT key FROM appearance_settings');
          for (const row of allAppearanceRows) {
            if (!isAppearanceKeyEnabled(enabledItems, row.key)) continue;
            await runDb(db, 'DELETE FROM appearance_settings WHERE key = ?', [row.key]);
          }
          if (en('appearance.terminalTheme')) {
            await runDb(db, "DELETE FROM terminal_themes WHERE theme_type != 'preset'");
            await runDb(db, `DELETE FROM sync_tombstones WHERE tbl = 'terminal_themes'`);
            await runDb(db, `DELETE FROM sync_changes WHERE tbl = 'terminal_themes'`);
          }
          await runDb(db, `DELETE FROM sync_tombstones WHERE tbl = 'appearance_settings'`);
          await runDb(db, `DELETE FROM sync_changes WHERE tbl = 'appearance_settings'`);
        }

        if (en('commandHistory.history')) {
          await runDb(db, 'DELETE FROM command_history');
          await runDb(db, `DELETE FROM sync_tombstones WHERE tbl = 'command_history'`);
          await runDb(db, `DELETE FROM sync_changes WHERE tbl = 'command_history'`);
        }

        if (isFullSync) {
          // 注意：全量覆盖场景下保留本地独立的管理员 users 表，绝不物理清空 users！
          await runDb(db, 'DELETE FROM workspace_sync');
          await runDb(db, 'DELETE FROM sync_tombstones');
          await runDb(db, 'DELETE FROM sync_changes');
          await runDb(db, 'DELETE FROM sync_pending_references');
        }

        await runDb(db, 'PRAGMA foreign_keys = ON');
        console.log(`[SyncService] 受管业务数据表已根据同步范围 [${describeSyncItems(enabledItems)}] 安全原子清空完毕 (触发器已静音且幽灵变更已清除)`);
      } finally {
        await runDb(db, 'UPDATE sync_state SET applying = 0 WHERE id = 1');
      }
    }).finally(() => {
      releaseLock();
    });
  },

  /**
   * 服务端处理双向数据交换 (支持按模块过滤与清空)
   */
  async processExchange(payload: SyncExchangePayload, apiKey?: string): Promise<SyncExchangeResult> {
    const key = (apiKey && apiKey.trim()) || (await getServerSyncApiKey());
    if (!key) {
      throw new Error('服务端同步 API Key 未初始化');
    }
    const serverTime = Math.floor(Date.now() / 1000);
    const clientLastSyncTime = payload.lastSyncTime || 0;
    const mode = payload.mode || 'bidirectional';
    const modules = payload.modules;

    let pushed = 0;
    let conflictsResolved = 0;

    // 若客户端指定“以本地为准覆盖云端”：服务端先清空已有实体库（按 modules）
    if (mode === 'local_to_cloud') {
      console.log(`[SyncService] 收到强制以本地覆盖云端请求，正在安全清空服务端存量数据 (模块: ${modules && modules.length > 0 ? modules.join(', ') : 'ALL'})...`);
      syncThrottleScheduler.pause();
      try {
        await this.clearSyncTables(modules);
        const db = await getDbInstance();
        await runDb(db, 'UPDATE sync_state SET push_cursor = 0, pull_cursor = 0 WHERE id = 1');
      } finally {
        syncThrottleScheduler.resume();
      }
    }

    // 1. 应用客户端推送过来的数据：
    // 若为 cloud_to_local 模式，服务端严格忽略客户端传来的任何实体与墓碑，绝对杜绝逆向抹除云端！
    if (mode !== 'cloud_to_local') {
      const applyRes = await this.applyIncomingData(payload, key, modules);
      pushed = applyRes.pushed;
      conflictsResolved = applyRes.conflictsResolved;
    }

    // 若为 local_to_cloud，服务端写入完成后安全推进游标对齐
    if (mode === 'local_to_cloud') {
      const db = await getDbInstance();
      const maxSeqRow = await getDb<{ maxSeq: number }>(db, 'SELECT COALESCE(MAX(seq), 0) as maxSeq FROM sync_changes');
      const maxSeq = maxSeqRow?.maxSeq || 0;
      await runDb(db, 'UPDATE sync_state SET push_cursor = ?, pull_cursor = 0 WHERE id = 1', [maxSeq]);
    }

    // 2. 导出服务端自 clientLastSyncTime 之后更新的数据并返回
    // 若为 cloud_to_local，客户端需要获取服务端全量数据 (sinceTimestamp = 0)
    const exportSince = (mode === 'cloud_to_local') ? 0 : clientLastSyncTime;
    const exportResult = await this.exportIncrementalData(exportSince, key, modules);

    let pulledCount = 0;
    Object.values(exportResult.entities).forEach(list => {
      if (Array.isArray(list)) pulledCount += list.length;
    });

    return {
      serverTime,
      syncedEntities: exportResult.entities,
      tombstones: exportResult.tombstones,
      stats: {
        pulled: pulledCount,
        pushed,
        conflictsResolved
      }
    };
  },

  /**
   * 客户端发送 HTTP/HTTPS JSON 请求辅助函数
   */
  async makeHttpRequest(urlStr: string, options: { method: string; headers?: Record<string, string>; body?: any; timeoutMs?: number }): Promise<any> {
    const parsedUrl = assertSafeSyncOutboundUrl(urlStr);
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const postData = options.body ? JSON.stringify(options.body) : '';

    const reqOptions: http.RequestOptions = {
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: options.method,
      timeout: options.timeoutMs || 10000,
      headers: {
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
        ...options.headers
      }
    };

    return new Promise((resolve, reject) => {
      const req = client.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              reject(new Error(parsed.message || parsed.error || `HTTP ${res.statusCode}: ${data}`));
            }
          } catch {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          }
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('请求远程 VPS 超时'));
      });

      if (postData) {
        req.write(postData);
      }
      req.end();
    });
  },

  /**
   * 客户端主动测试 VPS 连通性
   */
  async testRemoteConnection(vpsUrl: string, apiKey: string): Promise<{ success: boolean; latencyMs: number; data?: any }> {
    const cleanUrl = vpsUrl.replace(/\/+$/, '');
    const pingEndpoint = `${cleanUrl}/api/v1/sync/ping`;
    const startTime = Date.now();

    const response = await this.makeHttpRequest(pingEndpoint, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey
      },
      timeoutMs: 8000
    });

    const latencyMs = Date.now() - startTime;
    return {
      success: true,
      latencyMs,
      data: response
    };
  },

  /**
   * 客户端主动向 VPS 触发全量或按需同步 (支持 bidirectional, cloud_to_local, local_to_cloud 以及按模块过滤)
   */
  async triggerClientSync(
    vpsUrl: string,
    apiKey: string,
    lastSyncTime: number = 0,
    mode: 'bidirectional' | 'cloud_to_local' | 'local_to_cloud' = 'bidirectional',
    modules?: SyncModuleKey[]
  ): Promise<{
    success: boolean;
    serverTime: number;
    stats: {
      pushed: number;
      pulled: number;
      conflictsResolved: number;
    };
  }> {
    const cleanUrl = vpsUrl.replace(/\/+$/, '');
    const exchangeEndpoint = `${cleanUrl}/api/v1/sync/exchange`;

    let clientEntities: SyncExchangePayload['entities'] = {};
    let clientTombstones: Array<{ entity_type: string; uuid: string; deleted_at: number }> = [];

    // 若不是“以云端为准”，客户端搜集并推送数据
    if (mode !== 'cloud_to_local') {
      const exportSince = (mode === 'local_to_cloud') ? 0 : lastSyncTime;
      const clientIncremental = await this.exportIncrementalData(exportSince, apiKey, modules);
      clientEntities = clientIncremental.entities;
      clientTombstones = clientIncremental.tombstones;
    }

    const payload: SyncExchangePayload = {
      clientTime: Math.floor(Date.now() / 1000),
      lastSyncTime: (mode === 'bidirectional') ? lastSyncTime : 0,
      mode,
      modules,
      entities: clientEntities,
      tombstones: clientTombstones
    };

    // 2. 发起 HTTP 请求到 VPS exchange 接口
    const res = await this.makeHttpRequest(exchangeEndpoint, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey
      },
      body: payload,
      timeoutMs: 30000
    });

    if (!res || !res.success || !res.data) {
      throw new Error(res?.error || '远程同步响应格式不正确');
    }

    const exchangeData: SyncExchangeResult = res.data;

    // 3. 客户端本地应用变更：
    // 若用户选择“以云端为准覆盖本地”，本地先清空再全量写入云端数据
    if (mode === 'cloud_to_local') {
      console.log(`[SyncService:Client] 正在以云端为准清空本地并写入数据 (模块: ${modules && modules.length > 0 ? modules.join(', ') : 'ALL'})...`);
      syncThrottleScheduler.pause();
      try {
        await this.clearSyncTables(modules);
        const applyStats = await this.applyIncomingData(
          {
            entities: exchangeData.syncedEntities,
            tombstones: exchangeData.tombstones
          },
          apiKey,
          modules
        );

        // 核心安全屏障：覆盖完成后将 push_cursor 对齐到本地最新 seq，避免任何反向推送
        const db = await getDbInstance();
        const maxSeqRow = await getDb<{ maxSeq: number }>(db, 'SELECT COALESCE(MAX(seq), 0) as maxSeq FROM sync_changes');
        const maxSeq = maxSeqRow?.maxSeq || 0;
        await runDb(db, 'UPDATE sync_state SET push_cursor = ?, pull_cursor = 0 WHERE id = 1', [maxSeq]);
        console.log(`[SyncService:Client] 覆盖对齐完成，本地同步游标已安全对齐至 seq=${maxSeq}。`);

        return {
          success: true,
          serverTime: exchangeData.serverTime,
          stats: {
            pushed: 0,
            pulled: applyStats.pushed,
            conflictsResolved: exchangeData.stats.conflictsResolved + applyStats.conflictsResolved
          }
        };
      } finally {
        syncThrottleScheduler.resume();
      }
    }

    const applyStats = await this.applyIncomingData(
      {
        entities: exchangeData.syncedEntities,
        tombstones: exchangeData.tombstones
      },
      apiKey,
      modules
    );

    // 若为以本地覆盖云端模式，本地同样推进 push_cursor
    if (mode === 'local_to_cloud') {
      const db = await getDbInstance();
      const maxSeqRow = await getDb<{ maxSeq: number }>(db, 'SELECT COALESCE(MAX(seq), 0) as maxSeq FROM sync_changes');
      const maxSeq = maxSeqRow?.maxSeq || 0;
      await runDb(db, 'UPDATE sync_state SET push_cursor = ?, pull_cursor = 0 WHERE id = 1', [maxSeq]);
    }

    return {
      success: true,
      serverTime: exchangeData.serverTime,
      stats: {
        pushed: exchangeData.stats.pushed,
        pulled: applyStats.pushed,
        conflictsResolved: exchangeData.stats.conflictsResolved + applyStats.conflictsResolved
      }
    };
  }
};
