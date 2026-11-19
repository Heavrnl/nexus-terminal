// packages/backend/src/sync/sync.v2.service.ts
import { getDbInstance, runDb, getDb, allDb, acquireApplyLock, applyContext } from '../database/connection';
import { envelopeCryptoService } from './envelope-crypto.service';
import { syncEventsManager } from './sync.events';
import { broadcastSyncInvalidated } from './sync.ws-broadcaster';
import { broadcastFrontendEvent } from '../websocket/frontend-events';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import {
  CATEGORY_ITEMS,
  isAppearanceKeyEnabled,
  isSettingsKeyEnabled,
  isTableEnabled,
  resolveSyncItems,
  SyncItemKey
} from './sync.items';
import {
  collapseSyncChangeRows,
  generateDeterministicCommandUuid,
  normalizeCommandText,
  normalizeTimestampSeconds,
} from '../command-history/command-history.pure';

export interface SyncV2ChangeItem {
  seq?: number;
  tbl: string;
  row_id: string; // UUID
  op: 'U' | 'D';
  hlc: string;
  data?: any;     // 当 op='U' 时携带白名单字段；当 op='D' 时为 null
}

/** terminal_themes 表里的配色列（结构化传输时压成一个 colors 字典，避免 20 个字段各写一遍） */
const TERMINAL_THEME_COLOR_KEYS = [
  'foreground', 'background', 'cursor', 'cursor_accent', 'selection_background',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'bright_black', 'bright_red', 'bright_green', 'bright_yellow',
  'bright_blue', 'bright_magenta', 'bright_cyan', 'bright_white'
] as const;

/**
 * settings / appearance_settings 是「一张表装多种内容」的混合表，
 * 在同步范围里要按 key 再分一次组；其余表整表对应一个子项。
 */
const MIXED_TABLE_CATEGORY_ITEMS: Record<string, readonly SyncItemKey[]> = {
  settings: CATEGORY_ITEMS.layout,
  appearance_settings: CATEGORY_ITEMS.appearance,
};

function isMixedTable(table: string): boolean {
  return table === 'settings' || table === 'appearance_settings';
}

/** 混合表的删除墓碑里没有 key，只有当整个大类都启用时才敢删（否则可能删掉用户保留了的数据） */
function isMixedCategoryFullyEnabled(enabled: Set<SyncItemKey>, table: string): boolean {
  const items = MIXED_TABLE_CATEGORY_ITEMS[table];
  return !!items && items.every(i => enabled.has(i));
}

/**
 * 这条变更是否落在本次同步范围内。
 * 混合表按 key 细分（settings → 布局预设/组件状态/焦点切换顺序/界面设置），
 * 普通表整表对应一个子项；未登记的表一律放行（宁可多同步，也不要静默丢数据）。
 */
function isChangeInScope(enabled: Set<SyncItemKey>, tbl: string, op: 'U' | 'D', data?: any): boolean {
  if (isMixedTable(tbl)) {
    const key = op === 'U' ? String(data?.key || '') : '';
    if (!key) return isMixedCategoryFullyEnabled(enabled, tbl);
    return tbl === 'settings' ? isSettingsKeyEnabled(enabled, key) : isAppearanceKeyEnabled(enabled, key);
  }
  return isTableEnabled(enabled, tbl);
}

/** 参与双端同步且受 sync_tombstones 管理的实体表白名单 */
const SYNC_ENTITY_TABLES = new Set([
  'connections',
  'proxies',
  'ssh_keys',
  'folders',
  'quick_commands',
  'quick_command_folders',
  'settings',
  'port_forwards',
  'command_history',
  'appearance_settings',
  'terminal_themes',
  'favorite_paths',
]);

/**
 * 解析历史 DELETE 变更应当下发或上报的真实删除 HLC：
 * - 若实体已被后续复活（表中存在存活行且无更晚墓碑，或后续有 op='U' 覆盖），返回 null 以跳过作废的 DELETE
 * - 严禁在墓碑缺失时使用 Date.now() 伪造高水位 HLC 反杀存活数据
 */
async function resolveDeleteChangeHlc(
  db: any,
  tbl: string,
  rowId: string,
  seq: number
): Promise<string | null> {
  const tomb = await getDb<{ deleted_hlc: string }>(
    db,
    `SELECT deleted_hlc FROM sync_tombstones WHERE tbl = ? AND row_id = ?`,
    [tbl, rowId]
  );

  if (SYNC_ENTITY_TABLES.has(tbl)) {
    const live = await getDb<{ updated_hlc: string | null }>(
      db,
      `SELECT updated_hlc FROM ${tbl} WHERE uuid = ? LIMIT 1`,
      [rowId]
    );
    if (live) {
      const liveHlc = live.updated_hlc || '';
      if (!tomb?.deleted_hlc || liveHlc > tomb.deleted_hlc) {
        return null;
      }
    }
  }

  if (tomb?.deleted_hlc) {
    return tomb.deleted_hlc;
  }

  const newerUpsert = await getDb<{ seq: number }>(
    db,
    `SELECT seq FROM sync_changes WHERE seq > ? AND tbl = ? AND row_id = ? AND op = 'U' LIMIT 1`,
    [seq, tbl, rowId]
  );
  if (newerUpsert) {
    return null;
  }

  return '0000000000001-00000-expired';
}


export interface PushRequestPayload {
  device_id: string;
  changes: SyncV2ChangeItem[];
}

export interface PushResponseResult {
  accepted: Array<{ tbl: string; row_id: string; seq?: number }>;
  stale: Array<{ tbl: string; row_id: string; reason?: string }>;
  rejected: Array<{ tbl: string; row_id: string; reason: string }>;
  server_time: number;
}

export interface PullResponseResult {
  changes: SyncV2ChangeItem[];
  next_cursor: number;
  has_more: boolean;
  min_valid_cursor: number;
  server_time: number;
}

export interface SnapshotResponseResult {
  snapshot_cursor: number;
  page: number;
  page_size: number;
  total_count: number;
  has_more: boolean;
  entities: {
    folders: Array<{ uuid: string; name: string; background_color?: string | null; updated_hlc: string }>;
    quick_command_folders: Array<{ uuid: string; name: string; background_color?: string | null; updated_hlc: string }>;
    ssh_keys: Array<{ uuid: string; name: string; encrypted_private_key: string | null; encrypted_passphrase: string | null; updated_hlc: string }>;
    proxies: Array<{
      uuid: string;
      name: string;
      type: string;
      host: string;
      port: number;
      username?: string | null;
      auth_method?: string;
      encrypted_password?: string | null;
      encrypted_private_key?: string | null;
      encrypted_passphrase?: string | null;
      updated_hlc: string;
    }>;
    quick_commands: Array<{
      uuid: string;
      name?: string | null;
      command: string;
      variables?: string | null;
      background_color?: string | null;
      folder_uuids: string[];
      updated_hlc: string;
    }>;
    connections: Array<{
      uuid: string;
      name?: string | null;
      type: string;
      host: string;
      port: number;
      username: string;
      auth_method: string;
      encrypted_password?: string | null;
      encrypted_private_key?: string | null;
      encrypted_passphrase?: string | null;
      proxy_uuid?: string | null;
      proxy_type?: string | null;
      ssh_key_uuid?: string | null;
      notes?: string | null;
      jump_chain?: any;
      background_color?: string | null;
      file_protocol?: 'sftp' | 'scp' | 'auto';
      folder_uuids: string[];
      updated_hlc: string;
    }>;
    settings: Array<{
      uuid: string;
      key: string;
      value: string;
      updated_hlc: string;
    }>;
    command_history?: Array<{
      uuid: string;
      command: string;
      timestamp: number;
      updated_hlc: string;
    }>;
    port_forwards?: Array<{
      uuid: string;
      connection_uuid: string | null;
      type: 'local' | 'remote' | 'dynamic';
      bind_host: string;
      bind_port: number;
      target_host: string | null;
      target_port: number | null;
      auto_start: number;
      updated_hlc: string;
    }>;
    appearance_settings?: Array<{
      uuid: string;
      key: string;
      value: string;
      updated_hlc: string;
    }>;
    terminal_themes?: Array<{
      uuid: string;
      name: string;
      theme_type: 'preset' | 'user';
      colors: Record<string, string | null>;
      updated_hlc: string;
    }>;
    favorite_paths?: Array<{
      uuid: string;
      name: string | null;
      path: string;
      is_file: number;
      scope: 'global' | 'host';
      connection_uuid: string | null;
      last_used_at: number | null;
      updated_hlc: string;
    }>;
  };
  tombstones: Array<{ tbl: string; row_id: string; deleted_hlc: string; deleted_at: number }>;
  server_time: number;
}

export const syncV2Service = {
  /**
   * 待解析外键引用解析：当父记录到达后，回填挂起引用并清除登记
   */
  async resolvePendingReferences(targetTbl: string, targetUuid: string, targetPhysId: number): Promise<void> {
    const db = await getDbInstance();
    try {
      const pendings = await allDb<{ id: number; child_tbl: string; child_uuid: string; fk_field: string }>(
        db,
        `SELECT id, child_tbl, child_uuid, fk_field FROM sync_pending_references WHERE target_tbl = ? AND target_uuid = ?`,
        [targetTbl, targetUuid]
      );

      for (const p of pendings) {
        if (p.child_tbl === 'connections' && (p.fk_field === 'proxy_id' || p.fk_field === 'ssh_key_id')) {
          await runDb(db, `UPDATE connections SET ${p.fk_field} = ? WHERE uuid = ?`, [targetPhysId, p.child_uuid]);
        }
        // 端口转发规则绑定的是连接：父连接到达后把 connection_id 缝回去
        if (p.child_tbl === 'port_forwards' && p.fk_field === 'connection_id') {
          await runDb(db, `UPDATE port_forwards SET connection_id = ? WHERE uuid = ?`, [targetPhysId, p.child_uuid]);
        }
      }

      if (pendings.length > 0) {
        await runDb(db, `DELETE FROM sync_pending_references WHERE target_tbl = ? AND target_uuid = ?`, [targetTbl, targetUuid]);
        console.log(`[SyncV2] 成功为 ${targetTbl}:${targetUuid} 缝合了 ${pendings.length} 条待解析外键关联。`);
      }
    } catch (err: any) {
      console.warn(`[SyncV2] 外键引用缝合时发生告警:`, err.message);
    }
  },

  /**
   * 应用远端变更集 (核心幂等应用与单条 SAVEPOINT 隔离)
   */
  async applyRemoteChanges(
    changes: SyncV2ChangeItem[],
    originDeviceId: string,
    pairingSecret: string,
    isServerSide: boolean = false,
    modules?: readonly string[] | null
  ): Promise<{ accepted: PushResponseResult['accepted']; stale: PushResponseResult['stale']; rejected: PushResponseResult['rejected'] }> {
    const db = await getDbInstance();
    const releaseLock = await acquireApplyLock();

    const accepted: PushResponseResult['accepted'] = [];
    const stale: PushResponseResult['stale'] = [];
    const rejected: PushResponseResult['rejected'] = [];
    // 同步范围（细项）。不传 = 全开，兼容老客户端。
    const enabledItems = resolveSyncItems(modules);

    const nowMs = Date.now();
    const fiveMinutesMs = 5 * 60 * 1000;

    try {
      await applyContext.run({ isApplying: true }, async () => {
        await runDb(db, 'BEGIN IMMEDIATE');
        await runDb(db, 'PRAGMA defer_foreign_keys = ON');
        await runDb(db, 'UPDATE sync_state SET applying = 1 WHERE id = 1');

        // 记录本批远端变更里最大的 HLC 时间戳。收尾时必须并进本机 hlc_ms：
        // HLC 的作用是「逻辑时钟」，收到别人的时间戳就要把自己的拨到不比它小。
        // 否则一旦某台机器系统时钟比云端慢（Windows 常见），它此后产生的每个 HLC
        // 都永远小于云端已存版本，push 会在对端被静默判为 stale —— 表现就是
        // 「这台机器怎么改，另一边都收不到」，而且刷新也回退成旧值。
        let maxRemoteHlcMs = 0;

        for (let i = 0; i < changes.length; i++) {
          const item = changes[i];
          // 不在本次同步范围内：既不落库也不算失败，直接跳过
          if (!isChangeInScope(enabledItems, item.tbl, item.op, item.data)) continue;
          const savepointName = `sp_sync_${i}`;
          // NOT NULL 外键的子表（如 port_forwards.connection_id）在父记录没到时就落不了库，
          // 本条注定回滚。待解析登记必须活到回滚之后，所以先攒在这里，catch 里再写。
          const deferredPendingRefs: Array<{
            childTbl: string;
            childUuid: string;
            fkField: string;
            targetTbl: string;
            targetUuid: string;
          }> = [];
          await runDb(db, `SAVEPOINT ${savepointName}`);

          try {
            // 1. HLC 5 分钟上限检测与服务端自动时钟钳制
            let effectiveHlc = item.hlc;
            const hlcParts = effectiveHlc.split('-');
            const itemTimeMs = parseInt(hlcParts[0] || '0', 10);
            if (itemTimeMs > maxRemoteHlcMs) maxRemoteHlcMs = itemTimeMs; // 时钟吸收在下面统一提交
            if (itemTimeMs > nowMs + fiveMinutesMs) {
              console.warn(`[SyncV2] 远端记录 ${item.tbl}:${item.row_id} HLC 超前超过 5 分钟 (${itemTimeMs} > ${nowMs})，执行时钟钳制！`);
              effectiveHlc = `${String(nowMs + 1).padStart(13, '0')}-00000-${originDeviceId}`;
            }

            // 2. 处理删除变更 (op === 'D')
            if (item.op === 'D') {
              const localTombstone = await getDb<{ deleted_hlc: string }>(
                db,
                `SELECT deleted_hlc FROM sync_tombstones WHERE tbl = ? AND row_id = ?`,
                [item.tbl, item.row_id]
              );

              // 检查本地存活记录
              const localLive = await getDb<{ updated_hlc: string }>(
                db,
                `SELECT updated_hlc FROM ${item.tbl} WHERE uuid = ?`,
                [item.row_id]
              );

              if (localLive && localLive.updated_hlc > effectiveHlc) {
                // 本地修改新于远端删除：保留本地
                stale.push({ tbl: item.tbl, row_id: item.row_id, reason: '本地修改版本更新于远端删除' });
              } else if (localTombstone && localTombstone.deleted_hlc >= effectiveHlc) {
                // 已有相同或更新的墓碑
                accepted.push({ tbl: item.tbl, row_id: item.row_id });
              } else {
                // 执行删除并写墓碑
                await runDb(db, `DELETE FROM ${item.tbl} WHERE uuid = ?`, [item.row_id]);
                await runDb(
                  db,
                  `INSERT OR REPLACE INTO sync_tombstones (tbl, row_id, deleted_hlc, deleted_at) VALUES (?, ?, ?, ?)`,
                  [item.tbl, item.row_id, effectiveHlc, nowMs]
                );

                // 若在 VPS 服务端，记入服务端 sync_changes 供其他设备拉取
                if (isServerSide) {
                  const insChange = await runDb(
                    db,
                    `INSERT INTO sync_changes (tbl, row_id, op, origin) VALUES (?, ?, 'D', ?)`,
                    [item.tbl, item.row_id, originDeviceId]
                  );
                  accepted.push({ tbl: item.tbl, row_id: item.row_id, seq: insChange.lastID });
                } else {
                  accepted.push({ tbl: item.tbl, row_id: item.row_id });
                }
              }
              await runDb(db, `RELEASE SAVEPOINT ${savepointName}`);
              continue;
            }

            // 3. 处理更新/插入变更 (op === 'U')
            // 3.1 检查墓碑与本地存活版本的 HLC
            const existingTombstone = await getDb<{ deleted_hlc: string }>(
              db,
              `SELECT deleted_hlc FROM sync_tombstones WHERE tbl = ? AND row_id = ?`,
              [item.tbl, item.row_id]
            );
            if (existingTombstone && existingTombstone.deleted_hlc >= effectiveHlc) {
              stale.push({ tbl: item.tbl, row_id: item.row_id, reason: '本地已存在更新的删除墓碑' });
              await runDb(db, `RELEASE SAVEPOINT ${savepointName}`);
              continue;
            }

            // 主键是 `key` 的表（settings / appearance_settings）不能查 id
            const usesKeyPk = item.tbl === 'settings' || item.tbl === 'appearance_settings';
            const existingLive = await getDb<{ id?: number; key?: string; updated_hlc: string }>(
              db,
              usesKeyPk
                ? `SELECT key, updated_hlc FROM ${item.tbl} WHERE uuid = ?`
                : `SELECT id, updated_hlc FROM ${item.tbl} WHERE uuid = ?`,
              [item.row_id]
            );
            if (existingLive && existingLive.updated_hlc >= effectiveHlc) {
              stale.push({ tbl: item.tbl, row_id: item.row_id, reason: '本地数据版本较新或一致' });
              await runDb(db, `RELEASE SAVEPOINT ${savepointName}`);
              continue;
            }

            // 3.2 准备写入数据并解封凭据字段
            const data = item.data || {};
            let targetPhysId = existingLive ? existingLive.id : null;
            let syncedRowId = item.row_id;

            if (item.tbl === 'settings') {
              const settingKey = data.key;
              if (settingKey === 'desktop_sync_config' || settingKey === 'syncApiKey' || (typeof settingKey === 'string' && settingKey.startsWith('desktop_'))) {
                continue; // 保护本地私有配置
              }
              const settingValue = typeof data.value === 'string' ? data.value : String(data.value || '');
              const nowSec = Math.floor(nowMs / 1000);
              // updated_at 必须表示「这条值是什么时候变成这样的」，而不是「本机什么时候收到」。
              // 以前这里填本机 nowSec，等于每次 v2 应用都把本地行的时间戳抬到比云端还新，
              // 于是 v1 全量同步（它只看 updated_at 秒级 LWW）之后永远认为本地更新、
              // 一直拒收云端值 —— 手动同步完再刷新，界面就「变回原来的设置」。
              // 用远端 HLC 的毫秒位换算成秒，两个引擎的版本元数据才对得上。
              const settingUpdatedSec = itemTimeMs > 0 ? Math.floor(itemTimeMs / 1000) : nowSec;
              if (existingLive) {
                await runDb(
                  db,
                  `UPDATE settings SET value = ?, updated_hlc = ?, updated_at = ? WHERE uuid = ?`,
                  [settingValue, effectiveHlc, settingUpdatedSec, item.row_id]
                );
              } else {
                // 若 uuid 未命中，检查 key 是否存在
                const existingByKey = await getDb<{ key: string }>(db, `SELECT key FROM settings WHERE key = ?`, [settingKey]);
                if (existingByKey) {
                  await runDb(
                    db,
                    `UPDATE settings SET value = ?, uuid = ?, updated_hlc = ?, updated_at = ? WHERE key = ?`,
                    [settingValue, item.row_id, effectiveHlc, settingUpdatedSec, settingKey]
                  );
                } else {
                  await runDb(
                    db,
                    `INSERT INTO settings (key, value, created_at, updated_at, uuid, updated_hlc) VALUES (?, ?, ?, ?, ?, ?)`,
                    [settingKey, settingValue, nowSec, settingUpdatedSec, item.row_id, effectiveHlc]
                  );
                }
              }
            } else if (item.tbl === 'folders' || item.tbl === 'quick_command_folders') {
              if (existingLive) {
                await runDb(db, `UPDATE ${item.tbl} SET name = ?, background_color = ?, updated_hlc = ? WHERE uuid = ?`, [
                  data.name,
                  data.background_color || null,
                  effectiveHlc,
                  item.row_id
                ]);
              } else {
                const ins = await runDb(
                  db,
                  `INSERT INTO ${item.tbl} (uuid, name, background_color, updated_hlc) VALUES (?, ?, ?, ?)`,
                  [item.row_id, data.name, data.background_color || null, effectiveHlc]
                );
                targetPhysId = ins.lastID;
              }
            } else if (item.tbl === 'ssh_keys') {
              const encKey = envelopeCryptoService.convertEnvelopeToLocal(data.encrypted_private_key, pairingSecret);
              const encPass = envelopeCryptoService.convertEnvelopeToLocal(data.encrypted_passphrase, pairingSecret);
              if (existingLive) {
                await runDb(
                  db,
                  `UPDATE ssh_keys SET name = ?, encrypted_private_key = ?, encrypted_passphrase = ?, updated_hlc = ? WHERE uuid = ?`,
                  [data.name, encKey, encPass, effectiveHlc, item.row_id]
                );
              } else {
                const ins = await runDb(
                  db,
                  `INSERT INTO ssh_keys (uuid, name, encrypted_private_key, encrypted_passphrase, updated_hlc) VALUES (?, ?, ?, ?, ?)`,
                  [item.row_id, data.name, encKey, encPass, effectiveHlc]
                );
                targetPhysId = ins.lastID;
              }
              if (targetPhysId) {
                await this.resolvePendingReferences('ssh_keys', item.row_id, targetPhysId);
              }
            } else if (item.tbl === 'proxies') {
              const encPwd = envelopeCryptoService.convertEnvelopeToLocal(data.encrypted_password, pairingSecret);
              const encKey = envelopeCryptoService.convertEnvelopeToLocal(data.encrypted_private_key, pairingSecret);
              const encPass = envelopeCryptoService.convertEnvelopeToLocal(data.encrypted_passphrase, pairingSecret);
              if (existingLive) {
                await runDb(
                  db,
                  `UPDATE proxies SET name = ?, type = ?, host = ?, port = ?, username = ?, auth_method = ?,
                                      encrypted_password = ?, encrypted_private_key = ?, encrypted_passphrase = ?, updated_hlc = ?
                   WHERE uuid = ?`,
                  [data.name, data.type, data.host, data.port, data.username || null, data.auth_method || 'none', encPwd, encKey, encPass, effectiveHlc, item.row_id]
                );
              } else {
                const ins = await runDb(
                  db,
                  `INSERT INTO proxies (uuid, name, type, host, port, username, auth_method, encrypted_password, encrypted_private_key, encrypted_passphrase, updated_hlc)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  [item.row_id, data.name, data.type, data.host, data.port, data.username || null, data.auth_method || 'none', encPwd, encKey, encPass, effectiveHlc]
                );
                targetPhysId = ins.lastID;
              }
              if (targetPhysId) {
                await this.resolvePendingReferences('proxies', item.row_id, targetPhysId);
              }
            } else if (item.tbl === 'quick_commands') {
              if (existingLive) {
                await runDb(
                  db,
                  `UPDATE quick_commands SET name = ?, command = ?, variables = ?, background_color = ?, updated_hlc = ? WHERE uuid = ?`,
                  [data.name || null, data.command, data.variables || null, data.background_color || null, effectiveHlc, item.row_id]
                );
              } else {
                const ins = await runDb(
                  db,
                  `INSERT INTO quick_commands (uuid, name, command, usage_count, variables, background_color, updated_hlc)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`,
                  [item.row_id, data.name || null, data.command, data.usage_count || 0, data.variables || null, data.background_color || null, effectiveHlc]
                );
                targetPhysId = ins.lastID;
              }

              // 对齐 quick_command_folder_associations 关联
              if (targetPhysId && Array.isArray(data.folder_uuids)) {
                await runDb(db, `DELETE FROM quick_command_folder_associations WHERE quick_command_id = ?`, [targetPhysId]);
                for (const tUuid of data.folder_uuids) {
                  const tRow = await getDb<{ id: number }>(db, `SELECT id FROM quick_command_folders WHERE uuid = ?`, [tUuid]);
                  if (tRow) {
                    await runDb(db, `INSERT OR IGNORE INTO quick_command_folder_associations (quick_command_id, folder_id) VALUES (?, ?)`, [targetPhysId, tRow.id]);
                  }
                }
              }
            } else if (item.tbl === 'connections') {
              const encPwd = envelopeCryptoService.convertEnvelopeToLocal(data.encrypted_password, pairingSecret);
              const encKey = envelopeCryptoService.convertEnvelopeToLocal(data.encrypted_private_key, pairingSecret);
              const encPass = envelopeCryptoService.convertEnvelopeToLocal(data.encrypted_passphrase, pairingSecret);

              // 解析 proxy_uuid 物理外键
              let resolvedProxyId: number | null = null;
              if (data.proxy_uuid) {
                const p = await getDb<{ id: number }>(db, `SELECT id FROM proxies WHERE uuid = ?`, [data.proxy_uuid]);
                if (p) {
                  resolvedProxyId = p.id;
                } else {
                  // 父记录未到达，记入待解析挂起表
                  await runDb(
                    db,
                    `INSERT INTO sync_pending_references (child_tbl, child_uuid, fk_field, target_tbl, target_uuid) VALUES ('connections', ?, 'proxy_id', 'proxies', ?)`,
                    [item.row_id, data.proxy_uuid]
                  );
                }
              }

              // 解析 ssh_key_uuid 物理外键
              let resolvedSshKeyId: number | null = null;
              if (data.ssh_key_uuid) {
                const k = await getDb<{ id: number }>(db, `SELECT id FROM ssh_keys WHERE uuid = ?`, [data.ssh_key_uuid]);
                if (k) {
                  resolvedSshKeyId = k.id;
                } else {
                  await runDb(
                    db,
                    `INSERT INTO sync_pending_references (child_tbl, child_uuid, fk_field, target_tbl, target_uuid) VALUES ('connections', ?, 'ssh_key_id', 'ssh_keys', ?)`,
                    [item.row_id, data.ssh_key_uuid]
                  );
                }
              }

              if (existingLive) {
                await runDb(
                  db,
                  `UPDATE connections SET name = ?, type = ?, host = ?, port = ?, username = ?, auth_method = ?,
                                         encrypted_password = ?, encrypted_private_key = ?, encrypted_passphrase = ?,
                                         proxy_id = ?, proxy_type = ?, ssh_key_id = ?, notes = ?, jump_chain = ?,
                                         background_color = ?, file_protocol = ?, updated_hlc = ?
                   WHERE uuid = ?`,
                  [
                    data.name || null,
                    data.type || 'SSH',
                    data.host,
                    data.port,
                    data.username,
                    data.auth_method,
                    encPwd,
                    encKey,
                    encPass,
                    resolvedProxyId,
                    data.proxy_type || null,
                    resolvedSshKeyId,
                    data.notes || null,
                    data.jump_chain ? JSON.stringify(data.jump_chain) : null,
                    data.background_color || null,
                    data.file_protocol || 'auto',
                    effectiveHlc,
                    item.row_id
                  ]
                );
                targetPhysId = existingLive.id;
              } else {
                const ins = await runDb(
                  db,
                  `INSERT INTO connections (uuid, name, type, host, port, username, auth_method,
                                           encrypted_password, encrypted_private_key, encrypted_passphrase,
                                           proxy_id, proxy_type, ssh_key_id, notes, jump_chain, background_color,
                                           file_protocol, updated_hlc)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  [
                    item.row_id,
                    data.name || null,
                    data.type || 'SSH',
                    data.host,
                    data.port,
                    data.username,
                    data.auth_method,
                    encPwd,
                    encKey,
                    encPass,
                    resolvedProxyId,
                    data.proxy_type || null,
                    resolvedSshKeyId,
                    data.notes || null,
                    data.jump_chain ? JSON.stringify(data.jump_chain) : null,
                    data.background_color || null,
                    data.file_protocol || 'auto',
                    effectiveHlc
                  ]
                );
                targetPhysId = ins.lastID;
              }

              // 对齐 connection_folders 折叠关联
              if (targetPhysId && Array.isArray(data.folder_uuids)) {
                await runDb(db, `DELETE FROM connection_folders WHERE connection_id = ?`, [targetPhysId]);
                for (const tUuid of data.folder_uuids) {
                  const tRow = await getDb<{ id: number }>(db, `SELECT id FROM folders WHERE uuid = ?`, [tUuid]);
                  if (tRow) {
                    await runDb(db, `INSERT OR IGNORE INTO connection_folders (connection_id, folder_id) VALUES (?, ?)`, [targetPhysId, tRow.id]);
                  }
                }
              }

              // 对齐 file_color_highlights 文件颜色高亮关联
              if (targetPhysId && Array.isArray(data.file_highlights)) {
                await runDb(db, `DELETE FROM file_color_highlights WHERE connection_id = ?`, [targetPhysId]);
                const nowMs = Math.floor(Date.now() / 1000);
                for (const fh of data.file_highlights) {
                  if (fh && fh.path && fh.color) {
                    await runDb(
                      db,
                      `INSERT OR REPLACE INTO file_color_highlights (connection_id, path, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
                      [targetPhysId, fh.path, fh.color, nowMs, nowMs]
                    );
                  }
                }
              }
            } else if (item.tbl === 'port_forwards') {
              // 规则绑定的是连接：跨端用 connection_uuid 表达，落地时解析成本机自增 id
              const connRow = data.connection_uuid
                ? await getDb<{ id: number }>(db, `SELECT id FROM connections WHERE uuid = ?`, [data.connection_uuid])
                : undefined;
              if (!connRow) {
                // connection_id 是 NOT NULL，父连接没到就没法落库。登记待解析，父到达后缝合；
                // 本条先跳过，下次全量快照/该连接再次变更时会补上。
                if (data.connection_uuid) {
                  deferredPendingRefs.push({
                    childTbl: 'port_forwards',
                    childUuid: item.row_id,
                    fkField: 'connection_id',
                    targetTbl: 'connections',
                    targetUuid: data.connection_uuid,
                  });
                }
                throw new Error('端口转发规则的连接尚未同步到本机');
              }
              if (existingLive) {
                await runDb(
                  db,
                  `UPDATE port_forwards SET connection_id = ?, type = ?, bind_host = ?, bind_port = ?,
                                            target_host = ?, target_port = ?, auto_start = ?, updated_hlc = ?
                   WHERE uuid = ?`,
                  [
                    connRow.id,
                    data.type,
                    data.bind_host || '127.0.0.1',
                    data.bind_port,
                    data.target_host || null,
                    data.target_port || null,
                    data.auto_start ? 1 : 0,
                    effectiveHlc,
                    item.row_id
                  ]
                );
                targetPhysId = existingLive.id;
              } else {
                const ins = await runDb(
                  db,
                  `INSERT INTO port_forwards (uuid, connection_id, type, bind_host, bind_port, target_host, target_port, auto_start, updated_hlc)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  [
                    item.row_id,
                    connRow.id,
                    data.type,
                    data.bind_host || '127.0.0.1',
                    data.bind_port,
                    data.target_host || null,
                    data.target_port || null,
                    data.auto_start ? 1 : 0,
                    effectiveHlc
                  ]
                );
                targetPhysId = ins.lastID;
              }
            } else if (item.tbl === 'command_history') {
              const cmdText = normalizeCommandText(data.command);
              if (!cmdText) {
                stale.push({ tbl: item.tbl, row_id: item.row_id, reason: '空命令跳过' });
                await runDb(db, `RELEASE SAVEPOINT ${savepointName}`);
                continue;
              }

              const canonicalUuid = generateDeterministicCommandUuid(cmdText);
              // 若传入的 UUID 不是规范确定性 UUID，额外检查规范 UUID 是否已有更新删除墓碑
              if (canonicalUuid !== item.row_id) {
                const canonicalTomb = await getDb<{ deleted_hlc: string }>(
                  db,
                  `SELECT deleted_hlc FROM sync_tombstones WHERE tbl = 'command_history' AND row_id = ?`,
                  [canonicalUuid]
                );
                if (canonicalTomb && canonicalTomb.deleted_hlc >= effectiveHlc) {
                  stale.push({ tbl: item.tbl, row_id: item.row_id, reason: '本地已存在更新的删除墓碑' });
                  await runDb(db, `RELEASE SAVEPOINT ${savepointName}`);
                  continue;
                }
              }

              const fallbackSec = itemTimeMs > 0 ? Math.floor(itemTimeMs / 1000) : Math.floor(nowMs / 1000);
              const cmdTs = normalizeTimestampSeconds(data.timestamp, fallbackSec);

              if (existingLive) {
                // 避免更新后与表内同 command 的其他残余行撞 UNIQUE(command) 索引
                const conflictOther = await getDb<{ id: number }>(
                  db,
                  `SELECT id FROM command_history WHERE command = ? AND id != ? LIMIT 1`,
                  [cmdText, existingLive.id]
                );
                if (conflictOther) {
                  await runDb(db, `DELETE FROM command_history WHERE id = ?`, [conflictOther.id]);
                }
                const targetUuid = item.row_id === canonicalUuid ? canonicalUuid : item.row_id;
                syncedRowId = targetUuid;
                await runDb(
                  db,
                  `UPDATE command_history SET command = ?, timestamp = MAX(timestamp, ?), uuid = ?, updated_hlc = ? WHERE id = ?`,
                  [cmdText, cmdTs, targetUuid, effectiveHlc, existingLive.id]
                );
              } else {
                // 按 command 业务唯一键去重归并（不再错误依赖 timestamp 相等）
                const matchByCommand = await getDb<{
                  id: number;
                  uuid: string | null;
                  timestamp: number;
                  updated_hlc: string | null;
                }>(
                  db,
                  `SELECT id, uuid, timestamp, updated_hlc FROM command_history WHERE command = ? LIMIT 1`,
                  [cmdText]
                );

                if (matchByCommand) {
                  const localHlc = matchByCommand.updated_hlc || '';
                  if (localHlc >= effectiveHlc) {
                    // 本地 HLC 更新或一致：若远端已采用规范确定性 UUID 且本地仍是旧随机 UUID，顺手对齐 UUID 并清规范墓碑
                    if (matchByCommand.uuid !== canonicalUuid && item.row_id === canonicalUuid) {
                      await runDb(db, `UPDATE command_history SET uuid = ? WHERE id = ?`, [canonicalUuid, matchByCommand.id]);
                      await runDb(db, `DELETE FROM sync_tombstones WHERE tbl = 'command_history' AND row_id = ?`, [canonicalUuid]);
                    }
                    stale.push({ tbl: item.tbl, row_id: item.row_id, reason: '本地数据版本较新或一致' });
                    await runDb(db, `RELEASE SAVEPOINT ${savepointName}`);
                    continue;
                  }

                  const finalUuid =
                    item.row_id === canonicalUuid
                      ? canonicalUuid
                      : matchByCommand.uuid === canonicalUuid
                        ? canonicalUuid
                        : item.row_id;
                  syncedRowId = finalUuid;
                  await runDb(
                    db,
                    `UPDATE command_history SET timestamp = MAX(timestamp, ?), uuid = ?, updated_hlc = ? WHERE id = ?`,
                    [cmdTs, finalUuid, effectiveHlc, matchByCommand.id]
                  );
                } else {
                  const insertUuid = item.row_id || canonicalUuid;
                  syncedRowId = insertUuid;
                  await runDb(
                    db,
                    `INSERT INTO command_history (uuid, command, timestamp, updated_hlc) VALUES (?, ?, ?, ?)`,
                    [insertUuid, cmdText, cmdTs, effectiveHlc]
                  );
                }
              }
            } else if (item.tbl === 'appearance_settings') {
              const appearanceKey = data.key;
              if (typeof appearanceKey !== 'string' || appearanceKey === '') {
                throw new Error('外观设置缺少 key');
              }
              const appearanceValue = typeof data.value === 'string' ? data.value : String(data.value || '');
              const appearanceUpdatedSec = itemTimeMs > 0 ? Math.floor(itemTimeMs / 1000) : Math.floor(nowMs / 1000);
              if (existingLive) {
                await runDb(
                  db,
                  `UPDATE appearance_settings SET value = ?, updated_hlc = ?, updated_at = ? WHERE uuid = ?`,
                  [appearanceValue, effectiveHlc, appearanceUpdatedSec, item.row_id]
                );
              } else {
                // uuid 没命中就按 key 对齐（老库 uuid 是后补的，或对方先建了这个键）
                const byKey = await getDb<{ key: string }>(db, `SELECT key FROM appearance_settings WHERE key = ?`, [appearanceKey]);
                if (byKey) {
                  await runDb(
                    db,
                    `UPDATE appearance_settings SET value = ?, uuid = ?, updated_hlc = ?, updated_at = ? WHERE key = ?`,
                    [appearanceValue, item.row_id, effectiveHlc, appearanceUpdatedSec, appearanceKey]
                  );
                } else {
                  await runDb(
                    db,
                    `INSERT INTO appearance_settings (key, value, created_at, updated_at, uuid, updated_hlc) VALUES (?, ?, ?, ?, ?, ?)`,
                    [appearanceKey, appearanceValue, Math.floor(nowMs / 1000), appearanceUpdatedSec, item.row_id, effectiveHlc]
                  );
                }
              }
            } else if (item.tbl === 'terminal_themes') {
              const themeName = typeof data.name === 'string' ? data.name : '';
              if (!themeName) throw new Error('终端主题缺少 name');
              const themeType = data.theme_type === 'preset' ? 'preset' : 'user';
              if (themeType === 'preset') {
                // 内置预设两端一致，写进去只会用对端 seed 的配色覆盖本机 seed
                stale.push({ tbl: item.tbl, row_id: item.row_id, reason: '内置预设主题不参与同步' });
                await runDb(db, `RELEASE SAVEPOINT ${savepointName}`);
                continue;
              }
              const colors = (data.colors && typeof data.colors === 'object') ? data.colors : {};
              const colorCols = TERMINAL_THEME_COLOR_KEYS.join(', ');
              // UPDATE 的 SET 子句必须是 `col = ?`，只拼列名会变成 `SET a, b, c` 语法错误
              const colorSet = TERMINAL_THEME_COLOR_KEYS.map(k => `${k} = ?`).join(', ');
              const colorMarks = TERMINAL_THEME_COLOR_KEYS.map(() => '?').join(', ');
              const colorValues = TERMINAL_THEME_COLOR_KEYS.map(k => (colors[k] ?? null) as string | null);

              // name 上有 UNIQUE 约束：uuid 没命中时必须按 name 对齐，否则同名主题 INSERT 会失败
              let themeId: number | null = existingLive ? (existingLive.id ?? null) : null;
              if (!themeId) {
                const byName = await getDb<{ id: number }>(db, `SELECT id FROM terminal_themes WHERE name = ?`, [themeName]);
                if (byName) themeId = byName.id;
              }

              if (themeId) {
                await runDb(
                  db,
                  `UPDATE terminal_themes SET name = ?, theme_type = ?, ${colorSet}, uuid = ?, updated_hlc = ?, updated_at = ? WHERE id = ?`,
                  [themeName, themeType, ...colorValues, item.row_id, effectiveHlc, Math.floor(nowMs / 1000), themeId]
                );
              } else {
                await runDb(
                  db,
                  `INSERT INTO terminal_themes (name, theme_type, ${colorCols}, uuid, updated_hlc, created_at, updated_at)
                   VALUES (?, ?, ${colorMarks}, ?, ?, ?, ?)`,
                  [
                    themeName, themeType, ...colorValues, item.row_id, effectiveHlc,
                    Math.floor(nowMs / 1000), Math.floor(nowMs / 1000)
                  ]
                );
              }
            } else if (item.tbl === 'favorite_paths') {
              const favPath = typeof data.path === 'string' ? data.path : '';
              if (!favPath) throw new Error('常用路径缺少 path');
              const favName = data.name ?? null;
              const favIsFile = data.is_file ? 1 : 0;
              const favLastUsed = data.last_used_at ?? null;
              // 作用域随行同步：global 对所有主机可见，host 只归属某台主机
              const favScope = data.scope === 'host' ? 'host' : 'global';
              const favConnUuid = favScope === 'host' ? (data.connection_uuid ?? null) : null;

              let favId: number | null = existingLive ? (existingLive.id ?? null) : null;
              if (!favId) {
                // 同一条记录在两端各自生成过不同 uuid：按「路径 + 作用域 + 归属主机」对齐，
                // 只按 path 会把 A 机专属书签和全局书签合并成一条
                const byPath = await getDb<{ id: number }>(
                  db,
                  `SELECT id FROM favorite_paths WHERE path = ? AND scope = ? AND IFNULL(connection_uuid, '') = ? LIMIT 1`,
                  [favPath, favScope, favConnUuid ?? '']
                );
                if (byPath) favId = byPath.id;
              }

              if (favId) {
                await runDb(
                  db,
                  `UPDATE favorite_paths SET name = ?, path = ?, is_file = ?, scope = ?, connection_uuid = ?, last_used_at = ?, uuid = ?, updated_hlc = ?, updated_at = ?
                   WHERE id = ?`,
                  [favName, favPath, favIsFile, favScope, favConnUuid, favLastUsed, item.row_id, effectiveHlc, Math.floor(nowMs / 1000), favId]
                );
              } else {
                await runDb(
                  db,
                  `INSERT INTO favorite_paths (name, path, is_file, scope, connection_uuid, last_used_at, uuid, updated_hlc, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  [
                    favName, favPath, favIsFile, favScope, favConnUuid, favLastUsed, item.row_id, effectiveHlc,
                    Math.floor(nowMs / 1000), Math.floor(nowMs / 1000)
                  ]
                );
              }
            }

            // 清理墓碑
            await runDb(db, `DELETE FROM sync_tombstones WHERE tbl = ? AND row_id = ?`, [item.tbl, item.row_id]);
            if (item.tbl === 'command_history') {
              const canonical = generateDeterministicCommandUuid(normalizeCommandText(data.command));
              if (canonical && canonical !== item.row_id) {
                await runDb(db, `DELETE FROM sync_tombstones WHERE tbl = 'command_history' AND row_id = ?`, [canonical]);
              }
              if (syncedRowId && syncedRowId !== item.row_id && syncedRowId !== canonical) {
                await runDb(db, `DELETE FROM sync_tombstones WHERE tbl = 'command_history' AND row_id = ?`, [syncedRowId]);
              }
            }

            // 若在 VPS 服务端，向服务端 sync_changes 记一行，origin 填发送端 ID
            if (isServerSide) {
              const insChange = await runDb(
                db,
                `INSERT INTO sync_changes (tbl, row_id, op, origin) VALUES (?, ?, 'U', ?)`,
                [item.tbl, syncedRowId, originDeviceId]
              );
              accepted.push({ tbl: item.tbl, row_id: item.row_id, seq: insChange.lastID });
            } else {
              accepted.push({ tbl: item.tbl, row_id: item.row_id });
            }

            await runDb(db, `RELEASE SAVEPOINT ${savepointName}`);
          } catch (itemErr: any) {
            console.error(`[SyncV2] 应用单条记录 ${item.tbl}:${item.row_id} 失败，回滚该条保存点:`, itemErr.message);
            await runDb(db, `ROLLBACK TO SAVEPOINT ${savepointName}`);
            for (const p of deferredPendingRefs) {
              try {
                await runDb(
                  db,
                  `INSERT INTO sync_pending_references (child_tbl, child_uuid, fk_field, target_tbl, target_uuid) VALUES (?, ?, ?, ?, ?)`,
                  [p.childTbl, p.childUuid, p.fkField, p.targetTbl, p.targetUuid]
                );
              } catch (pendingErr: any) {
                console.warn(`[SyncV2] 登记待解析外键失败 ${p.childTbl}:${p.childUuid}:`, pendingErr.message);
              }
            }
            rejected.push({ tbl: item.tbl, row_id: item.row_id, reason: itemErr.message });
          }
        }

        // 4. 推进本机 HLC 状态：
        //    hlc_ms 必须同时并上「本批收到的最大远端时间戳」与「本机当前时间」。
        //    只并本机时间的话，时钟偏慢的一端永远不会前进到云端水位，
        //    之后它推上去的每条变更都会被对端按 stale 丢掉。
        await runDb(
          db,
          `UPDATE sync_state SET
            hlc_ms = MAX(hlc_ms, ?, ?),
            applying = 0
           WHERE id = 1`,
          [maxRemoteHlcMs, nowMs]
        );

        await runDb(db, 'COMMIT');
      });
    } catch (txErr: any) {
      console.error('[SyncV2] 应用远端事务严重异常，整体回滚:', txErr.message);
      await runDb(db, 'UPDATE sync_state SET applying = 0 WHERE id = 1');
      await runDb(db, 'ROLLBACK');
      throw txErr;
    } finally {
      releaseLock();
    }

    return { accepted, stale, rejected };
  },

  /**
   * 服务端处理桌面端的 PUSH 请求
   */
  async handlePush(payload: PushRequestPayload, pairingSecret: string, modules?: readonly string[] | null): Promise<PushResponseResult> {
    const { device_id, changes } = payload;
    const serverTime = Math.floor(Date.now() / 1000);

    const { accepted, stale, rejected } = await this.applyRemoteChanges(changes, device_id, pairingSecret, true, modules);

    // 统计本次变更入库产生的最大 seq 并通过 SSE 广播通知其他在线客户端
    let maxSeq = 0;
    for (const a of accepted) {
      if (a.seq && a.seq > maxSeq) {
        maxSeq = a.seq;
      }
    }
    if (maxSeq > 0) {
      syncEventsManager.broadcastChange(maxSeq, device_id);
      broadcastSyncInvalidated(maxSeq);
      // ★ 关键补充：这个节点上可能还挂着浏览器（web 版）。
      // 远端（桌面客户端）推上来的变更此刻已经落库，但以前只通知了 /ws/sync 上的
      // 后端客户端，网页侧收不到任何信号 —— 必须整页刷新才能看到新值，
      // 也就是「桌面端改了，web 端没及时变化」。
      // 只在这里补一次（远端变更入站），不要塞进 broadcastSyncInvalidated：
      // 那个函数被每次本地写库唤醒，会给前端造成每条命令都全量刷新的抖动。
      broadcastFrontendEvent({
        type: 'sync:invalidated',
        seq: maxSeq,
        origin: device_id
      });
    }

    return {
      accepted,
      stale,
      rejected,
      server_time: serverTime
    };
  },

  /**
   * 服务端处理桌面端的 PULL 请求 (基于单调递增 seq 游标)
   */
  async handlePull(deviceId: string, cursor: number, limit: number = 200, pairingSecret: string, modules?: readonly string[] | null): Promise<PullResponseResult> {
    const db = await getDbInstance();
    const serverTime = Math.floor(Date.now() / 1000);

    // 检查游标有效性 (410 判定)
    const stateRow = await getDb<{ min_valid_cursor: number }>(db, `SELECT min_valid_cursor FROM sync_state WHERE id = 1`);
    const minValid = stateRow?.min_valid_cursor || 0;
    if (cursor > 0 && cursor < minValid) {
      const err: any = new Error('游标已过期 (410 Gone)，请执行快照重建');
      err.statusCode = 410;
      throw err;
    }

    // 查询 seq > cursor 且 origin 不是请求设备的变更日志
    const changesRows = await allDb<{ seq: number; tbl: string; row_id: string; op: 'U' | 'D' }>(
      db,
      `SELECT seq, tbl, row_id, op FROM sync_changes
       WHERE seq > ? AND (origin IS NULL OR origin != ?)
       ORDER BY seq ASC LIMIT ?`,
      [cursor, deviceId, limit + 1]
    );

    const hasMore = changesRows.length > limit;
    const itemsToProcess = hasMore ? changesRows.slice(0, limit) : changesRows;

    const enabledItems = resolveSyncItems(modules);
    let nextCursor = cursor;
    for (const row of itemsToProcess) {
      nextCursor = Math.max(nextCursor, row.seq);
    }
    // 折叠同一批次中针对同一实体的多次连续变更，仅传输最终状态
    const collapsedItems = collapseSyncChangeRows(itemsToProcess);
    const resultChanges: SyncV2ChangeItem[] = [];

    // 去重并提取记录当前完整状态
    for (const row of collapsedItems) {
      nextCursor = Math.max(nextCursor, row.seq);

      // 同步范围过滤。游标照常前进：这些变更对「这台设备」来说属于有意不同步的内容，
      // 停在这里只会把后面所有真实变更一起堵死。
      if (!isTableEnabled(enabledItems, row.tbl)) continue;
      if (isMixedTable(row.tbl)) {
        // 混合表要先拿到 key 才能判断；墓碑拿不到 key，只有整个大类全开时才下发
        if (row.op === 'D') {
          if (!isMixedCategoryFullyEnabled(enabledItems, row.tbl)) continue;
        } else {
          const keyRow = await getDb<{ key: string }>(db, `SELECT key FROM ${row.tbl} WHERE uuid = ?`, [row.row_id]);
          const key = keyRow?.key || '';
          // 值已被本地清掉（例如云端删了行但墓碑丢了）：按删除处理，同样受大类全开限制
          if (!key) {
            if (!isMixedCategoryFullyEnabled(enabledItems, row.tbl)) continue;
          } else if (
            row.tbl === 'settings'
              ? !isSettingsKeyEnabled(enabledItems, key)
              : !isAppearanceKeyEnabled(enabledItems, key)
          ) {
            continue;
          }
        }
      }

      if (row.op === 'D') {
        const deleteHlc = await resolveDeleteChangeHlc(db, row.tbl, row.row_id, row.seq);
        if (!deleteHlc) continue;
        resultChanges.push({
          seq: row.seq,
          tbl: row.tbl,
          row_id: row.row_id,
          op: 'D',
          hlc: deleteHlc
        });
      } else {
        // op === 'U'
        if (row.tbl === 'connections') {
          const c = await getDb<any>(
            db,
            `SELECT c.*, p.uuid as proxy_uuid, sk.uuid as ssh_key_uuid
             FROM connections c
             LEFT JOIN proxies p ON c.proxy_id = p.id
             LEFT JOIN ssh_keys sk ON c.ssh_key_id = sk.id
             WHERE c.uuid = ?`,
            [row.row_id]
          );
          if (c) {
            const tagRows = await allDb<{ uuid: string }>(
              db,
              `SELECT t.uuid FROM connection_folders ct JOIN folders t ON ct.folder_id = t.id WHERE ct.connection_id = ?`,
              [c.id]
            );
            const tagUuids = tagRows.map(t => t.uuid).filter(Boolean);
            const highlightRows = await allDb<{ path: string; color: string }>(
              db,
              `SELECT path, color FROM file_color_highlights WHERE connection_id = ?`,
              [c.id]
            );

            resultChanges.push({
              seq: row.seq,
              tbl: row.tbl,
              row_id: row.row_id,
              op: 'U',
              hlc: c.updated_hlc || `${Date.now()}-00000-server`,
              data: {
                name: c.name,
                type: c.type,
                host: c.host,
                port: c.port,
                username: c.username,
                auth_method: c.auth_method,
                encrypted_password: envelopeCryptoService.convertLocalToEnvelope(c.encrypted_password, pairingSecret),
                encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(c.encrypted_private_key, pairingSecret),
                encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(c.encrypted_passphrase, pairingSecret),
                proxy_uuid: c.proxy_uuid || null,
                proxy_type: c.proxy_type || null,
                ssh_key_uuid: c.ssh_key_uuid || null,
                notes: c.notes || null,
                jump_chain: c.jump_chain ? JSON.parse(c.jump_chain) : null,
                background_color: c.background_color || null,
                file_protocol: c.file_protocol || 'auto',
                folder_uuids: tagUuids,
                file_highlights: highlightRows
              }
            });
          }
        } else if (row.tbl === 'proxies') {
          const p = await getDb<any>(db, `SELECT * FROM proxies WHERE uuid = ?`, [row.row_id]);
          if (p) {
            resultChanges.push({
              seq: row.seq,
              tbl: row.tbl,
              row_id: row.row_id,
              op: 'U',
              hlc: p.updated_hlc,
              data: {
                name: p.name,
                type: p.type,
                host: p.host,
                port: p.port,
                username: p.username,
                auth_method: p.auth_method,
                encrypted_password: envelopeCryptoService.convertLocalToEnvelope(p.encrypted_password, pairingSecret),
                encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(p.encrypted_private_key, pairingSecret),
                encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(p.encrypted_passphrase, pairingSecret)
              }
            });
          }
        } else if (row.tbl === 'ssh_keys') {
          const k = await getDb<any>(db, `SELECT * FROM ssh_keys WHERE uuid = ?`, [row.row_id]);
          if (k) {
            resultChanges.push({
              seq: row.seq,
              tbl: row.tbl,
              row_id: row.row_id,
              op: 'U',
              hlc: k.updated_hlc,
              data: {
                name: k.name,
                encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(k.encrypted_private_key, pairingSecret),
                encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(k.encrypted_passphrase, pairingSecret)
              }
            });
          }
        } else if (row.tbl === 'folders' || row.tbl === 'quick_command_folders') {
          const t = await getDb<any>(db, `SELECT * FROM ${row.tbl} WHERE uuid = ?`, [row.row_id]);
          if (t) {
            resultChanges.push({
              seq: row.seq,
              tbl: row.tbl,
              row_id: row.row_id,
              op: 'U',
              hlc: t.updated_hlc,
              data: {
                name: t.name,
                background_color: t.background_color || null
              }
            });
          }
        } else if (row.tbl === 'quick_commands') {
          const q = await getDb<any>(db, `SELECT * FROM quick_commands WHERE uuid = ?`, [row.row_id]);
          if (q) {
            const tagRows = await allDb<{ uuid: string }>(
              db,
              `SELECT qt.uuid FROM quick_command_folder_associations qa JOIN quick_command_folders qt ON qa.folder_id = qt.id WHERE qa.quick_command_id = ?`,
              [q.id]
            );
            const tagUuids = tagRows.map(t => t.uuid).filter(Boolean);

            resultChanges.push({
              seq: row.seq,
              tbl: row.tbl,
              row_id: row.row_id,
              op: 'U',
              hlc: q.updated_hlc,
              data: {
                name: q.name,
                command: q.command,
                variables: q.variables,
                background_color: q.background_color || null,
                folder_uuids: tagUuids
              }
            });
          }
        } else if (row.tbl === 'settings') {
          const s = await getDb<any>(db, `SELECT * FROM settings WHERE uuid = ?`, [row.row_id]);
          if (s && s.key !== 'desktop_sync_config' && s.key !== 'syncApiKey' && !String(s.key || '').startsWith('desktop_')) {
            resultChanges.push({
              seq: row.seq,
              tbl: row.tbl,
              row_id: row.row_id,
              op: 'U',
              hlc: s.updated_hlc || `${Date.now()}-00000-server`,
              data: {
                key: s.key,
                value: s.value
              }
            });
          }
        } else if (row.tbl === 'port_forwards') {
          const pf = await getDb<any>(
            db,
            `SELECT pf.*, c.uuid AS connection_uuid
             FROM port_forwards pf
             LEFT JOIN connections c ON pf.connection_id = c.id
             WHERE pf.uuid = ?`,
            [row.row_id]
          );
          if (pf) {
            resultChanges.push({
              seq: row.seq,
              tbl: row.tbl,
              row_id: row.row_id,
              op: 'U',
              hlc: pf.updated_hlc || `${Date.now()}-00000-server`,
              data: {
                connection_uuid: pf.connection_uuid || null,
                type: pf.type,
                bind_host: pf.bind_host,
                bind_port: pf.bind_port,
                target_host: pf.target_host || null,
                target_port: pf.target_port || null,
                auto_start: pf.auto_start ? 1 : 0
              }
            });
          }
        } else if (row.tbl === 'command_history') {
          const ch = await getDb<any>(db, `SELECT * FROM command_history WHERE uuid = ?`, [row.row_id]);
          if (ch) {
            resultChanges.push({
              seq: row.seq,
              tbl: row.tbl,
              row_id: row.row_id,
              op: 'U',
              hlc: ch.updated_hlc || `${Date.now()}-00000-server`,
              data: {
                command: ch.command,
                timestamp: ch.timestamp
              }
            });
          }
        } else if (row.tbl === 'appearance_settings') {
          const s = await getDb<any>(db, `SELECT * FROM appearance_settings WHERE uuid = ?`, [row.row_id]);
          if (s) {
            resultChanges.push({
              seq: row.seq,
              tbl: row.tbl,
              row_id: row.row_id,
              op: 'U',
              hlc: s.updated_hlc || `${Date.now()}-00000-server`,
              data: { key: s.key, value: s.value }
            });
          }
        } else if (row.tbl === 'terminal_themes') {
          const t = await getDb<any>(db, `SELECT * FROM terminal_themes WHERE uuid = ?`, [row.row_id]);
          if (t && t.theme_type === 'user') {
            const colors: Record<string, string | null> = {};
            for (const k of TERMINAL_THEME_COLOR_KEYS) colors[k] = t[k] ?? null;
            resultChanges.push({
              seq: row.seq,
              tbl: row.tbl,
              row_id: row.row_id,
              op: 'U',
              hlc: t.updated_hlc || `${Date.now()}-00000-server`,
              data: { name: t.name, theme_type: t.theme_type, colors }
            });
          }
        } else if (row.tbl === 'favorite_paths') {
          const f = await getDb<any>(db, `SELECT * FROM favorite_paths WHERE uuid = ?`, [row.row_id]);
          if (f) {
            resultChanges.push({
              seq: row.seq,
              tbl: row.tbl,
              row_id: row.row_id,
              op: 'U',
              hlc: f.updated_hlc || `${Date.now()}-00000-server`,
              data: {
                name: f.name ?? null,
                path: f.path,
                is_file: f.is_file ? 1 : 0,
                scope: f.scope === 'host' ? 'host' : 'global',
                connection_uuid: f.connection_uuid ?? null,
                last_used_at: f.last_used_at ?? null
              }
            });
          }
        }
      }
    }

    return {
      changes: resultChanges,
      next_cursor: nextCursor,
      has_more: hasMore,
      min_valid_cursor: minValid,
      server_time: serverTime
    };
  },

  /**
   * 桌面端提取本地未确认的变更 (seq > push_cursor) 并打包
   */
  async extractLocalChangesToPush(pairingSecret: string, modules?: readonly string[] | null): Promise<{ changes: SyncV2ChangeItem[]; maxSeq: number }> {
    const db = await getDbInstance();
    const state = await getDb<{ push_cursor: number }>(db, `SELECT push_cursor FROM sync_state WHERE id = 1`);
    const pushCursor = state?.push_cursor || 0;

    const rows = await allDb<{ seq: number; tbl: string; row_id: string; op: 'U' | 'D' }>(
      db,
      `SELECT seq, tbl, row_id, op FROM sync_changes
       WHERE seq > ? AND origin IS NULL
       ORDER BY seq ASC LIMIT 200`,
      [pushCursor]
    );

    const enabledItems = resolveSyncItems(modules);
    let maxSeq = pushCursor;
    for (const r of rows) {
      maxSeq = Math.max(maxSeq, r.seq);
    }
    // 折叠同批次针对同一条记录的连续多次操作（如重复执行 50 次同一条命令），减少无效流量
    const collapsedRows = collapseSyncChangeRows(rows);
    const list: SyncV2ChangeItem[] = [];

    for (const r of collapsedRows) {
      maxSeq = Math.max(maxSeq, r.seq);

      // 同步范围过滤：maxSeq 仍然覆盖这些被跳过的行，
      // 否则游标会卡在一条永远不推的变更上，后面的数据全部堵死。
      if (!isTableEnabled(enabledItems, r.tbl)) continue;
      if (isMixedTable(r.tbl)) {
        if (r.op === 'D') {
          if (!isMixedCategoryFullyEnabled(enabledItems, r.tbl)) continue;
        } else {
          const keyRow = await getDb<{ key: string }>(db, `SELECT key FROM ${r.tbl} WHERE uuid = ?`, [r.row_id]);
          const key = keyRow?.key || '';
          if (!key) {
            if (!isMixedCategoryFullyEnabled(enabledItems, r.tbl)) continue;
          } else if (r.tbl === 'settings' ? !isSettingsKeyEnabled(enabledItems, key) : !isAppearanceKeyEnabled(enabledItems, key)) {
            continue;
          }
        }
      }

      if (r.op === 'D') {
        const deleteHlc = await resolveDeleteChangeHlc(db, r.tbl, r.row_id, r.seq);
        if (!deleteHlc) continue;
        list.push({
          seq: r.seq,
          tbl: r.tbl,
          row_id: r.row_id,
          op: 'D',
          hlc: deleteHlc
        });
      } else {
        // op === 'U'
        if (r.tbl === 'connections') {
          const c = await getDb<any>(
            db,
            `SELECT c.*, p.uuid as proxy_uuid, sk.uuid as ssh_key_uuid
             FROM connections c
             LEFT JOIN proxies p ON c.proxy_id = p.id
             LEFT JOIN ssh_keys sk ON c.ssh_key_id = sk.id
             WHERE c.uuid = ?`,
            [r.row_id]
          );
          if (c) {
            const tagRows = await allDb<{ uuid: string }>(
              db,
              `SELECT t.uuid FROM connection_folders ct JOIN folders t ON ct.folder_id = t.id WHERE ct.connection_id = ?`,
              [c.id]
            );
            const highlightRows = await allDb<{ path: string; color: string }>(
              db,
              `SELECT path, color FROM file_color_highlights WHERE connection_id = ?`,
              [c.id]
            );
            list.push({
              seq: r.seq,
              tbl: r.tbl,
              row_id: r.row_id,
              op: 'U',
              hlc: c.updated_hlc,
              data: {
                name: c.name,
                type: c.type,
                host: c.host,
                port: c.port,
                username: c.username,
                auth_method: c.auth_method,
                encrypted_password: envelopeCryptoService.convertLocalToEnvelope(c.encrypted_password, pairingSecret),
                encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(c.encrypted_private_key, pairingSecret),
                encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(c.encrypted_passphrase, pairingSecret),
                proxy_uuid: c.proxy_uuid || null,
                proxy_type: c.proxy_type || null,
                ssh_key_uuid: c.ssh_key_uuid || null,
                notes: c.notes || null,
                jump_chain: c.jump_chain ? JSON.parse(c.jump_chain) : null,
                background_color: c.background_color || null,
                file_protocol: c.file_protocol || 'auto',
                folder_uuids: tagRows.map(t => t.uuid).filter(Boolean),
                file_highlights: highlightRows
              }
            });
          }
        } else if (r.tbl === 'proxies') {
          const p = await getDb<any>(db, `SELECT * FROM proxies WHERE uuid = ?`, [r.row_id]);
          if (p) {
            list.push({
              seq: r.seq,
              tbl: r.tbl,
              row_id: r.row_id,
              op: 'U',
              hlc: p.updated_hlc,
              data: {
                name: p.name,
                type: p.type,
                host: p.host,
                port: p.port,
                username: p.username,
                auth_method: p.auth_method,
                encrypted_password: envelopeCryptoService.convertLocalToEnvelope(p.encrypted_password, pairingSecret),
                encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(p.encrypted_private_key, pairingSecret),
                encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(p.encrypted_passphrase, pairingSecret)
              }
            });
          }
        } else if (r.tbl === 'ssh_keys') {
          const k = await getDb<any>(db, `SELECT * FROM ssh_keys WHERE uuid = ?`, [r.row_id]);
          if (k) {
            list.push({
              seq: r.seq,
              tbl: r.tbl,
              row_id: r.row_id,
              op: 'U',
              hlc: k.updated_hlc,
              data: {
                name: k.name,
                encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(k.encrypted_private_key, pairingSecret),
                encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(k.encrypted_passphrase, pairingSecret)
              }
            });
          }
        } else if (r.tbl === 'folders' || r.tbl === 'quick_command_folders') {
          const t = await getDb<any>(db, `SELECT * FROM ${r.tbl} WHERE uuid = ?`, [r.row_id]);
          if (t) {
            list.push({
              seq: r.seq,
              tbl: r.tbl,
              row_id: r.row_id,
              op: 'U',
              hlc: t.updated_hlc,
              data: {
                name: t.name,
                background_color: t.background_color || null
              }
            });
          }
        } else if (r.tbl === 'quick_commands') {
          const q = await getDb<any>(db, `SELECT * FROM quick_commands WHERE uuid = ?`, [r.row_id]);
          if (q) {
            const tagRows = await allDb<{ uuid: string }>(
              db,
              `SELECT qt.uuid FROM quick_command_folder_associations qa JOIN quick_command_folders qt ON qa.folder_id = qt.id WHERE qa.quick_command_id = ?`,
              [q.id]
            );
            list.push({
              seq: r.seq,
              tbl: r.tbl,
              row_id: r.row_id,
              op: 'U',
              hlc: q.updated_hlc,
              data: {
                name: q.name,
                command: q.command,
                variables: q.variables,
                background_color: q.background_color || null,
                folder_uuids: tagRows.map(t => t.uuid).filter(Boolean)
              }
            });
          }
        } else if (r.tbl === 'settings') {
          const s = await getDb<any>(db, `SELECT * FROM settings WHERE uuid = ?`, [r.row_id]);
          if (s) {
            list.push({
              seq: r.seq,
              tbl: r.tbl,
              row_id: r.row_id,
              op: 'U',
              hlc: s.updated_hlc || `${Date.now()}-00000-local`,
              data: {
                key: s.key,
                value: s.value
              }
            });
          }
        } else if (r.tbl === 'port_forwards') {
          const pf = await getDb<any>(
            db,
            `SELECT pf.*, c.uuid AS connection_uuid
             FROM port_forwards pf
             LEFT JOIN connections c ON pf.connection_id = c.id
             WHERE pf.uuid = ?`,
            [r.row_id]
          );
          if (pf) {
            list.push({
              seq: r.seq,
              tbl: r.tbl,
              row_id: r.row_id,
              op: 'U',
              hlc: pf.updated_hlc || `${Date.now()}-00000-local`,
              data: {
                connection_uuid: pf.connection_uuid || null,
                type: pf.type,
                bind_host: pf.bind_host,
                bind_port: pf.bind_port,
                target_host: pf.target_host || null,
                target_port: pf.target_port || null,
                auto_start: pf.auto_start ? 1 : 0
              }
            });
          }
        } else if (r.tbl === 'command_history') {
          const ch = await getDb<any>(db, `SELECT * FROM command_history WHERE uuid = ?`, [r.row_id]);
          if (ch) {
            list.push({
              seq: r.seq,
              tbl: r.tbl,
              row_id: r.row_id,
              op: 'U',
              hlc: ch.updated_hlc || `${Date.now()}-00000-local`,
              data: {
                command: ch.command,
                timestamp: ch.timestamp
              }
            });
          }
        } else if (r.tbl === 'appearance_settings') {
          const s = await getDb<any>(db, `SELECT * FROM appearance_settings WHERE uuid = ?`, [r.row_id]);
          if (s) {
            list.push({
              seq: r.seq,
              tbl: r.tbl,
              row_id: r.row_id,
              op: 'U',
              hlc: s.updated_hlc || `${Date.now()}-00000-local`,
              data: { key: s.key, value: s.value }
            });
          }
        } else if (r.tbl === 'terminal_themes') {
          const t = await getDb<any>(db, `SELECT * FROM terminal_themes WHERE uuid = ?`, [r.row_id]);
          if (t && t.theme_type === 'user') {
            const colors: Record<string, string | null> = {};
            for (const k of TERMINAL_THEME_COLOR_KEYS) colors[k] = t[k] ?? null;
            list.push({
              seq: r.seq,
              tbl: r.tbl,
              row_id: r.row_id,
              op: 'U',
              hlc: t.updated_hlc || `${Date.now()}-00000-local`,
              data: { name: t.name, theme_type: t.theme_type, colors }
            });
          }
        } else if (r.tbl === 'favorite_paths') {
          const f = await getDb<any>(db, `SELECT * FROM favorite_paths WHERE uuid = ?`, [r.row_id]);
          if (f) {
            list.push({
              seq: r.seq,
              tbl: r.tbl,
              row_id: r.row_id,
              op: 'U',
              hlc: f.updated_hlc || `${Date.now()}-00000-local`,
              data: {
                name: f.name ?? null,
                path: f.path,
                is_file: f.is_file ? 1 : 0,
                scope: f.scope === 'host' ? 'host' : 'global',
                connection_uuid: f.connection_uuid ?? null,
                last_used_at: f.last_used_at ?? null
              }
            });
          }
        }
      }
    }

    return { changes: list, maxSeq };
  },

  /**
   * 桌面端执行一轮完整的 PUSH + PULL 双向增量同步
   */
  async executeSyncCycle(
    vpsUrl: string,
    deviceToken: string,
    pairingSecret: string,
    modules?: readonly string[] | null
  ): Promise<{ pushed: number; pulled: number; conflicts: number }> {
    const db = await getDbInstance();
    const state = await getDb<{ device_id: string; pull_cursor: number }>(db, `SELECT device_id, pull_cursor FROM sync_state WHERE id = 1`);
    const deviceId = state?.device_id || 'desktop-client';
    let pullCursor = state?.pull_cursor || 0;

    const cleanUrl = vpsUrl.replace(/\/+$/, '');
    // 同步范围（细项）。空 = 全开，老版本客户端不带这个参数时行为不变。
    const scopeParam = modules && modules.length > 0 ? `&modules=${encodeURIComponent(modules.join(','))}` : '';
    let totalPushed = 0;
    let totalPulled = 0;

    // --- 步骤 1: PUSH 本地变更 (循环排空所有积压变更 + 安全切片分批与 413 弹性防护) ---
    try {
      const MAX_PUSH_ROUNDS = 50;
      for (let round = 0; round < MAX_PUSH_ROUNDS; round++) {
        const beforeState = await getDb<{ push_cursor: number }>(db, `SELECT push_cursor FROM sync_state WHERE id = 1`);
        const beforeCursor = beforeState?.push_cursor || 0;
        const { changes: localChanges, maxSeq: scannedMaxSeq } = await this.extractLocalChangesToPush(pairingSecret, modules);

        if (scannedMaxSeq <= beforeCursor) {
          break;
        }

        if (localChanges.length > 0) {
          console.log(`[SyncV2:Client] 第 ${round + 1} 轮检测到 ${localChanges.length} 条本地变更待推送，采用小批次切片防溢出传输...`);

          // 设置安全单批条数 (每批 25 条，严格低于 Express/Nginx 默认限制)
          const CHUNK_SIZE = 25;
          for (let i = 0; i < localChanges.length; i += CHUNK_SIZE) {
            const chunk = localChanges.slice(i, i + CHUNK_SIZE);

            // 尝试推送该批次，若遭遇 413 则二分降级重试
            let subBatchSize = chunk.length;
            let subIdx = 0;

            while (subIdx < chunk.length) {
              const subChunk = chunk.slice(subIdx, subIdx + subBatchSize);
              try {
                const pushRes = await this.sendHttpJson(`${cleanUrl}/api/sync/v2/push`, {
                  method: 'POST',
                  headers: { 'x-device-token': deviceToken },
                  body: { device_id: deviceId, changes: subChunk, modules: modules && modules.length > 0 ? [...modules] : undefined }
                });

                if (pushRes && pushRes.success && pushRes.data) {
                  const data: PushResponseResult = pushRes.data;
                  totalPushed += (data.accepted || []).length;
                  // 吸收云端 server_time 推进本地 HLC，防止本机时钟偏慢导致新变更持续被云端判为 stale
                  if (typeof data.server_time === 'number' && data.server_time > 0) {
                    const serverMs = Math.floor(data.server_time) * 1000 + 999;
                    await runDb(db, `UPDATE sync_state SET hlc_ms = MAX(hlc_ms, ?) WHERE id = 1`, [serverMs]);
                  }
                  if ((data.stale || []).length > 0 && (data.accepted || []).length === 0) {
                    // 全部被判旧版本 = 云端已有更新的 HLC。
                    console.warn(
                      `[SyncV2:Client] 本批 ${data.stale.length} 条变更被云端判为旧版本(stale)，未落库：` +
                      `${data.stale.slice(0, 3).map(s => `${s.tbl}:${s.row_id}`).join(', ')}` +
                      `（若持续出现，多半是本机系统时钟比云端慢）`
                    );
                  }
                  // 推进该批次中最大的 seq
                  const batchMaxSeq = Math.max(...subChunk.map(c => c.seq || 0));
                  if (batchMaxSeq > 0) {
                    await runDb(db, `UPDATE sync_state SET push_cursor = MAX(push_cursor, ?) WHERE id = 1`, [batchMaxSeq]);
                  }
                  subIdx += subBatchSize;
                } else {
                  throw new Error(pushRes?.error || '推送响应未成功');
                }
              } catch (postErr: any) {
                const is413 = postErr.message && (postErr.message.includes('413') || postErr.message.includes('Payload Too Large'));
                if (is413 && subBatchSize > 5) {
                  // 遇到 413 且批次大于 5，立即二分降级重试该段
                  console.warn(`[SyncV2:Client] 遭遇云端 413 限制，自动降级批次大小 (${subBatchSize} -> ${Math.floor(subBatchSize / 2)}) 重试...`);
                  subBatchSize = Math.max(1, Math.floor(subBatchSize / 2));
                } else if (is413) {
                  // 单条也超限：这一行永远推不上去，只能跳过，否则会堵死后续所有变更
                  console.warn(`[SyncV2:Client] 单条变更体积超限，跳过 seq=${subChunk[0]?.seq} 避免阻塞:`, postErr.message);
                  const failedSeq = subChunk[0]?.seq;
                  if (failedSeq) {
                    await runDb(db, `UPDATE sync_state SET push_cursor = MAX(push_cursor, ?) WHERE id = 1`, [failedSeq]);
                  }
                  subIdx += 1;
                } else {
                  // 网络中断 / 鉴权失败 / 云端 5xx 都是可恢复的：游标绝不能动，
                  // 否则这批变更会永久跳过（sync_changes 已落在游标下面，再也不会被取出）。
                  // 抛出去结束本轮 PUSH，下一轮从同一条重试。
                  console.warn(`[SyncV2:Client] 推送批次 (偏移 ${i + subIdx}) 失败，保留游标待下轮重试:`, postErr.message);
                  throw postErr;
                }
              }
            }
          }
        }

        // 被同步范围过滤掉的变更或被折叠掉的更早 seq 不会出现在 localChanges 尾部，
        // 整批推完后必须推进到本轮扫描到的最大 seq，否则下一轮还会扫相同范围或停止排空。
        if (scannedMaxSeq > beforeCursor) {
          await runDb(db, `UPDATE sync_state SET push_cursor = MAX(push_cursor, ?) WHERE id = 1`, [scannedMaxSeq]);
        }
      }
    } catch (pushErr: any) {
      console.warn('[SyncV2:Client] PUSH 本地变更流程遇到告警，已安全隔离，继续执行 PULL 拉取:', pushErr.message);
    }

    // --- 步骤 2: PULL 云端变更并循环排空 ---
    let hasMore = true;
    while (hasMore) {
      let pullRes: any;
      try {
        pullRes = await this.sendHttpJson(`${cleanUrl}/api/sync/v2/pull?device_id=${deviceId}&cursor=${pullCursor}&limit=200${scopeParam}`, {
          method: 'GET',
          headers: { 'x-device-token': deviceToken }
        });
      } catch (pullErr: any) {
        const msg = String(pullErr?.message || '');
        // 410 是「云端把老变更日志 GC 掉了，游标已不可用」。以前这里直接 throw，
        // 调度器只会不停退避重试同一个废游标 —— 拉取永久卡死（表现就是「另一边改了，
        // 这台机器永远收不到」）。必须走一次快照重建把状态对齐并换新游标。
        if (msg.includes('410') || msg.includes('CURSOR_EXPIRED') || msg.includes('游标已过期')) {
          console.warn('[SyncV2:Client] 拉取游标已过期 (410)，开始执行全量快照重建...');
          const rebuilt = await this.rebuildFromSnapshot(cleanUrl, deviceToken, pairingSecret, modules);
          totalPulled += rebuilt.applied;
          pullCursor = rebuilt.cursor;
          break;
        }
        throw pullErr;
      }

      if (!pullRes || !pullRes.success || !pullRes.data) {
        break;
      }

      const pullData: PullResponseResult = pullRes.data;
      if (pullData.changes.length > 0) {
        console.log(`[SyncV2:Client] 收到云端 ${pullData.changes.length} 条变更，正在应用...`);
        const applyRes = await this.applyRemoteChanges(pullData.changes, 'vps-server', pairingSecret, false, modules);
        totalPulled += applyRes.accepted.length;
      }

      pullCursor = pullData.next_cursor;
      hasMore = pullData.has_more;

      // 推进 pull_cursor
      await runDb(db, `UPDATE sync_state SET pull_cursor = ? WHERE id = 1`, [pullCursor]);
    }

    return { pushed: totalPushed, pulled: totalPulled, conflicts: 0 };
  },

  /**
   * 把 PUSH / PULL 游标退回原点，强制下一轮重新对齐一次完整增量。
   *
   * 用在「同步范围（细项）发生变化」时：增量游标是按 seq 单向前进的，
   * 某子项关闭期间产生的变更早已被跳过，重新勾上时如果不退游标，
   * 就得等到下一次全量快照/重建才会有数据回来。
   */
  async resetSyncCursors(): Promise<void> {
    const db = await getDbInstance();
    await runDb(db, `UPDATE sync_state SET push_cursor = 0, pull_cursor = 0 WHERE id = 1`);
    console.log('[SyncV2] 同步范围已变化，PUSH/PULL 游标已归零，下一轮将重新对齐完整增量');
  },

  /**
   * 全量快照重建 (客户端侧)：把云端快照当成一整批「远端变更」应用，
   * 再把 pull_cursor 换成快照游标。用于初次加入集群或拉取游标过期 (410) 后的自愈。
   *
   * 幂等：每个实体都带 updated_hlc，应用时仍走 HLC 比较，本地更新的行不会被降级。
   */
  async rebuildFromSnapshot(
    cleanUrl: string,
    deviceToken: string,
    pairingSecret: string,
    modules?: readonly string[] | null
  ): Promise<{ applied: number; cursor: number }> {
    const db = await getDbInstance();
    let page = 1;
    let applied = 0;
    let cursor = 0;
    const scopeParam = modules && modules.length > 0 ? `&modules=${encodeURIComponent(modules.join(','))}` : '';

    for (;;) {
      const res = await this.sendHttpJson(`${cleanUrl}/api/sync/v2/snapshot?page=${page}&page_size=200${scopeParam}`, {
        method: 'GET',
        headers: { 'x-device-token': deviceToken }
      });
      if (!res || !res.success || !res.data) throw new Error('快照重建失败：云端响应异常');

      const snap = res.data as SnapshotResponseResult;
      cursor = snap.snapshot_cursor || cursor;

      const changes: SyncV2ChangeItem[] = [];
      for (const [tbl, rows] of Object.entries(snap.entities || {})) {
        if (!Array.isArray(rows)) continue;
        for (const row of rows as any[]) {
          if (!row?.uuid || !row?.updated_hlc) continue;
          changes.push({ tbl, row_id: row.uuid, op: 'U', hlc: row.updated_hlc, data: row });
        }
      }
      for (const t of snap.tombstones || []) {
        changes.push({ tbl: t.tbl, row_id: t.row_id, op: 'D', hlc: t.deleted_hlc });
      }

      if (changes.length > 0) {
        // 分片应用，避免单个事务过大
        for (let i = 0; i < changes.length; i += 100) {
          const r = await this.applyRemoteChanges(changes.slice(i, i + 100), 'vps-snapshot', pairingSecret, false, modules);
          applied += r.accepted.length;
        }
      }

      if (!snap.has_more) break;
      page += 1;
      if (page > 200) break; // 防御：异常分页保护
    }

    await runDb(db, `UPDATE sync_state SET pull_cursor = ? WHERE id = 1`, [cursor]);
    console.log(`[SyncV2:Client] 快照重建完成：应用 ${applied} 条，新游标 ${cursor}`);
    return { applied, cursor };
  },

  /**
   * HTTP 客户端辅助请求
   */
  async sendHttpJson(urlStr: string, options: { method: string; headers?: Record<string, string>; body?: any }): Promise<any> {
    const parsedUrl = new URL(urlStr);
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;
    const postData = options.body ? JSON.stringify(options.body) : '';

    const reqOptions: http.RequestOptions = {
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: options.method,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
        ...options.headers
      }
    };

    return new Promise((resolve, reject) => {
      const req = client.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
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
              resolve({ success: true, data });
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('请求超时'));
      });

      if (postData) req.write(postData);
      req.end();
    });
  },

  /**
   * 服务端快照接口：用于客户端初次同步或 410 游标过期后的全量状态重建
   */
  async getSnapshot(page: number = 1, pageSize: number = 200, pairingSecret: string, modules?: readonly string[] | null): Promise<SnapshotResponseResult> {
    const db = await getDbInstance();
    const serverTime = Math.floor(Date.now() / 1000);
    const enabledItems = resolveSyncItems(modules);
    const want = (tbl: string) => isTableEnabled(enabledItems, tbl);
    const wantKey = (tbl: string, key: string) =>
      tbl === 'settings' ? isSettingsKeyEnabled(enabledItems, key) : isAppearanceKeyEnabled(enabledItems, key);

    // 1. 获取当前系统最新 seq 作为快照游标
    const maxSeqRow = await getDb<{ maxSeq: number }>(db, `SELECT COALESCE(MAX(seq), 0) as maxSeq FROM sync_changes`);
    const snapshotCursor = maxSeqRow?.maxSeq || 0;

    // 2. 提取有效墓碑列表 (仅第 1 页携带)
    let tombstones: Array<{ tbl: string; row_id: string; deleted_hlc: string; deleted_at: number }> = [];
    if (page === 1) {
      const allTombstones = await allDb<{ tbl: string; row_id: string; deleted_hlc: string; deleted_at: number }>(
        db,
        `SELECT tbl, row_id, deleted_hlc, deleted_at FROM sync_tombstones ORDER BY deleted_at DESC`
      );
      // 混合表的墓碑没有 key，只有整个大类全开时才下发
      tombstones = allTombstones.filter(t =>
        isMixedTable(t.tbl)
          ? isMixedCategoryFullyEnabled(enabledItems, t.tbl)
          : isTableEnabled(enabledItems, t.tbl)
      );
    }

    // 3. 提取 folders 文件夹 (确定性 UUID)
    const folders = await allDb<{ uuid: string; name: string; background_color?: string | null; updated_hlc: string }>(
      db,
      `SELECT uuid, name, background_color, updated_hlc FROM folders ORDER BY id ASC`
    );

    // 4. 提取 quick_command_folders
    const quickCommandFolders = await allDb<{ uuid: string; name: string; background_color?: string | null; updated_hlc: string }>(
      db,
      `SELECT uuid, name, background_color, updated_hlc FROM quick_command_folders ORDER BY id ASC`
    );

    // 5. 提取 ssh_keys (信封加密)
    const rawSshKeys = await allDb<any>(db, `SELECT * FROM ssh_keys ORDER BY id ASC`);
    const sshKeys = rawSshKeys.map(k => ({
      uuid: k.uuid,
      name: k.name,
      encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(k.encrypted_private_key, pairingSecret),
      encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(k.encrypted_passphrase, pairingSecret),
      updated_hlc: k.updated_hlc
    }));

    // 6. 提取 proxies (信封加密)
    const rawProxies = await allDb<any>(db, `SELECT * FROM proxies ORDER BY id ASC`);
    const proxies = rawProxies.map(p => ({
      uuid: p.uuid,
      name: p.name,
      type: p.type,
      host: p.host,
      port: p.port,
      username: p.username || null,
      auth_method: p.auth_method || 'none',
      encrypted_password: envelopeCryptoService.convertLocalToEnvelope(p.encrypted_password, pairingSecret),
      encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(p.encrypted_private_key, pairingSecret),
      encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(p.encrypted_passphrase, pairingSecret),
      updated_hlc: p.updated_hlc
    }));

    // 7. 提取 quick_commands (折叠文件夹)
    const rawQuickCommands = await allDb<any>(db, `SELECT * FROM quick_commands ORDER BY id ASC`);
    const quickCommands = [];
    for (const q of rawQuickCommands) {
      const tagRows = await allDb<{ uuid: string }>(
        db,
        `SELECT qt.uuid FROM quick_command_folder_associations qa JOIN quick_command_folders qt ON qa.folder_id = qt.id WHERE qa.quick_command_id = ?`,
        [q.id]
      );
      quickCommands.push({
        uuid: q.uuid,
        name: q.name || null,
        command: q.command,
        variables: q.variables || null,
        background_color: q.background_color || null,
        folder_uuids: tagRows.map(t => t.uuid).filter(Boolean),
        updated_hlc: q.updated_hlc
      });
    }

    // 8. 提取 connections (折叠文件夹、解析外键 UUID、信封加密)
    const rawConnections = await allDb<any>(
      db,
      `SELECT c.*, p.uuid as proxy_uuid, sk.uuid as ssh_key_uuid
       FROM connections c
       LEFT JOIN proxies p ON c.proxy_id = p.id
       LEFT JOIN ssh_keys sk ON c.ssh_key_id = sk.id
       ORDER BY c.id ASC`
    );
    const connections = [];
    for (const c of rawConnections) {
      const tagRows = await allDb<{ uuid: string }>(
        db,
        `SELECT t.uuid FROM connection_folders ct JOIN folders t ON ct.folder_id = t.id WHERE ct.connection_id = ?`,
        [c.id]
      );
      const highlightRows = await allDb<{ path: string; color: string }>(
        db,
        `SELECT path, color FROM file_color_highlights WHERE connection_id = ?`,
        [c.id]
      );
      connections.push({
        uuid: c.uuid,
        name: c.name || null,
        type: c.type || 'SSH',
        host: c.host,
        port: c.port,
        username: c.username,
        auth_method: c.auth_method,
        encrypted_password: envelopeCryptoService.convertLocalToEnvelope(c.encrypted_password, pairingSecret),
        encrypted_private_key: envelopeCryptoService.convertLocalToEnvelope(c.encrypted_private_key, pairingSecret),
        encrypted_passphrase: envelopeCryptoService.convertLocalToEnvelope(c.encrypted_passphrase, pairingSecret),
        proxy_uuid: c.proxy_uuid || null,
        proxy_type: c.proxy_type || null,
        ssh_key_uuid: c.ssh_key_uuid || null,
        notes: c.notes || null,
        jump_chain: c.jump_chain ? JSON.parse(c.jump_chain) : null,
        background_color: c.background_color || null,
        file_protocol: c.file_protocol || 'auto',
        folder_uuids: tagRows.map(t => t.uuid).filter(Boolean),
        file_highlights: highlightRows,
        updated_hlc: c.updated_hlc
      });
    }

    // 9. 提取 settings (严格排除本地私有配置)
    const rawSettings = await allDb<any>(
      db,
      `SELECT * FROM settings 
       WHERE key NOT IN ('desktop_sync_config', 'syncApiKey') 
         AND key NOT LIKE 'desktop_%' 
       ORDER BY key ASC`
    );
    const settings = rawSettings.map(s => ({
      uuid: s.uuid,
      key: s.key,
      value: s.value,
      updated_hlc: s.updated_hlc || `${Date.now()}-00000-server`
    }));

    // 10. 提取 command_history (按最近使用时间提取最近 1000 条，防止高频执行的老 id 命令被截断)
    const rawCmdHist = await allDb<any>(
      db,
      `SELECT uuid, command, timestamp, updated_hlc
       FROM command_history
       WHERE uuid IS NOT NULL AND uuid != ''
       ORDER BY timestamp DESC, id DESC
       LIMIT 1000`
    );
    const command_history = rawCmdHist.map(ch => ({
      uuid: ch.uuid,
      command: ch.command,
      timestamp: ch.timestamp,
      updated_hlc: ch.updated_hlc || `${Date.now()}-00000-server`
    }));

    // 10.5 提取 port_forwards（连接外键转 uuid）
    const rawPortForwards = await allDb<any>(
      db,
      `SELECT pf.*, c.uuid AS connection_uuid
       FROM port_forwards pf
       LEFT JOIN connections c ON pf.connection_id = c.id
       ORDER BY pf.id ASC`
    );
    const portForwards = rawPortForwards
      .filter(pf => !!pf.uuid)
      .map(pf => ({
        uuid: pf.uuid,
        connection_uuid: pf.connection_uuid || null,
        type: pf.type,
        bind_host: pf.bind_host,
        bind_port: pf.bind_port,
        target_host: pf.target_host || null,
        target_port: pf.target_port || null,
        auto_start: pf.auto_start ? 1 : 0,
        updated_hlc: pf.updated_hlc || `${Date.now()}-00000-server`
      }));

    // 10.6 提取 appearance_settings（终端背景图/字体/自定义 UI 主题等按 key 存的项）
    const rawAppearance = await allDb<any>(db, `SELECT * FROM appearance_settings ORDER BY key ASC`);
    const appearanceSettings = rawAppearance
      .filter(s => !!s.uuid)
      .map(s => ({
        uuid: s.uuid,
        key: s.key,
        value: s.value,
        updated_hlc: s.updated_hlc || `${Date.now()}-00000-server`
      }));

    // 10.7 提取 terminal_themes（只含自定义主题；preset 两端一致，不进快照）
    const rawThemes = await allDb<any>(db, `SELECT * FROM terminal_themes WHERE theme_type = 'user' ORDER BY id ASC`);
    const terminalThemes = rawThemes
      .filter(t => !!t.uuid)
      .map(t => {
        const colors: Record<string, string | null> = {};
        for (const k of TERMINAL_THEME_COLOR_KEYS) colors[k] = t[k] ?? null;
        return {
          uuid: t.uuid,
          name: t.name,
          theme_type: t.theme_type,
          colors,
          updated_hlc: t.updated_hlc || `${Date.now()}-00000-server`
        };
      });

    // 10.8 提取 favorite_paths（常用路径，身份是 path + scope + 归属主机）
    const rawFavoritePaths = await allDb<any>(db, `SELECT * FROM favorite_paths ORDER BY id ASC`);
    const favoritePaths = rawFavoritePaths
      .filter(f => !!f.uuid)
      .map(f => ({
        uuid: f.uuid,
        name: f.name ?? null,
        path: f.path,
        is_file: f.is_file ? 1 : 0,
        scope: (f.scope === 'host' ? 'host' : 'global') as 'global' | 'host',
        connection_uuid: f.connection_uuid ?? null,
        last_used_at: f.last_used_at ?? null,
        updated_hlc: f.updated_hlc || `${Date.now()}-00000-server`
      }));

    // 11. 按同步范围（细项）裁剪
    //     混合表 settings / appearance_settings 再按 key 分一次组，
    //     其余表整表开或整表关。关闭的子项返回空数组，不参与 total_count。
    const scoped = {
      folders: want('folders') ? folders : [],
      quick_command_folders: want('quick_command_folders') ? quickCommandFolders : [],
      ssh_keys: want('ssh_keys') ? sshKeys : [],
      proxies: want('proxies') ? proxies : [],
      quick_commands: want('quick_commands') ? quickCommands : [],
      connections: want('connections') ? connections : [],
      settings: settings.filter(s => wantKey('settings', s.key)),
      command_history: want('command_history') ? command_history : [],
      port_forwards: want('port_forwards') ? portForwards : [],
      appearance_settings: appearanceSettings.filter(s => wantKey('appearance_settings', s.key)),
      terminal_themes: want('terminal_themes') ? terminalThemes : [],
      favorite_paths: want('favorite_paths') ? favoritePaths : []
    };

    const totalCount = Object.values(scoped).reduce((sum, list) => sum + list.length, 0);

    return {
      snapshot_cursor: snapshotCursor,
      page,
      page_size: pageSize,
      total_count: totalCount,
      has_more: false,
      entities: {
        folders: scoped.folders,
        quick_command_folders: scoped.quick_command_folders,
        ssh_keys: scoped.ssh_keys,
        proxies: scoped.proxies,
        quick_commands: scoped.quick_commands,
        connections: scoped.connections,
        settings: scoped.settings,
        command_history: scoped.command_history,
        port_forwards: scoped.port_forwards,
        appearance_settings: scoped.appearance_settings,
        terminal_themes: scoped.terminal_themes,
        favorite_paths: scoped.favorite_paths
      },
      tombstones,
      server_time: serverTime
    };
  },

  /**
   * 墓碑定期 GC 与 sync_changes 冗余压缩
   * 默认清理 30 天以前的墓碑并推进 min_valid_cursor
   */
  async cleanOldTombstonesAndCompressChanges(retentionDays: number = 30): Promise<{ purgedTombstones: number; compressedChanges: number }> {
    const db = await getDbInstance();
    const now = Date.now();
    const cutoff = now - retentionDays * 86400 * 1000;

    // 1. 查找超期墓碑
    const oldTombstones = await allDb<{ tbl: string; row_id: string }>(
      db,
      `SELECT tbl, row_id FROM sync_tombstones WHERE deleted_at < ?`,
      [cutoff]
    );

    let purgedCount = 0;
    if (oldTombstones.length > 0) {
      const rowIds = oldTombstones.map(t => t.row_id);
      const placeholders = rowIds.map(() => '?').join(',');
      const maxSeqRow = await getDb<{ maxSeq: number }>(
        db,
        `SELECT COALESCE(MAX(seq), 0) as maxSeq FROM sync_changes WHERE op = 'D' AND row_id IN (${placeholders})`,
        rowIds
      );
      const maxPurgedSeq = maxSeqRow?.maxSeq || 0;

      await runDb(db, `DELETE FROM sync_tombstones WHERE deleted_at < ?`, [cutoff]);
      if (maxPurgedSeq > 0) {
        await runDb(db, `UPDATE sync_state SET min_valid_cursor = MAX(min_valid_cursor, ?) WHERE id = 1`, [maxPurgedSeq]);
      }
      purgedCount = oldTombstones.length;
      console.log(`[SyncV2:GC] 成功清理 ${purgedCount} 条过期墓碑，推进 min_valid_cursor 至 ${maxPurgedSeq}`);
    }

    // 2. 压缩 sync_changes 表中的历史冗余行 (仅保留每条实体的最大 seq)
    const totalChangesRow = await getDb<{ count: number }>(db, `SELECT COUNT(*) as count FROM sync_changes`);
    let compressedCount = 0;
    if ((totalChangesRow?.count || 0) > 1000) {
      const minCursorRow = await getDb<{ min_valid_cursor: number }>(db, `SELECT min_valid_cursor FROM sync_state WHERE id = 1`);
      const minCursor = minCursorRow?.min_valid_cursor || 0;

      const delRes = await runDb(
        db,
        `DELETE FROM sync_changes
         WHERE seq < ? AND seq NOT IN (
           SELECT MAX(seq) FROM sync_changes GROUP BY tbl, row_id
         )`,
        [minCursor > 0 ? minCursor : 999999999]
      );
      compressedCount = delRes.changes || 0;
      console.log(`[SyncV2:GC] 压缩历史变更日志，移除了 ${compressedCount} 条历史冗余行。`);
    }

    return { purgedTombstones: purgedCount, compressedChanges: compressedCount };
  }
};
