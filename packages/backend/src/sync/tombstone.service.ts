// packages/backend/src/sync/tombstone.service.ts
import { getDbInstance, runDb, allDb } from '../database/connection';
import { normalizeTimestampSeconds } from '../command-history/command-history.pure';

export interface TombstoneRecord {
  entity_type: string;
  uuid: string;
  deleted_at: number; // 统一返回秒级时间戳
}

export async function recordTombstone(entityType: string, uuid: string, deletedAt?: number): Promise<void> {
  if (!uuid) return;
  try {
    const db = await getDbInstance();
    const nowMs = Date.now();
    // 兼容传入秒级或毫秒级的时间戳，库内统一规范为毫秒存储、13 位 HLC
    const msToRecord =
      typeof deletedAt === 'number' && Number.isFinite(deletedAt) && deletedAt > 0
        ? deletedAt > 1e12
          ? Math.floor(deletedAt)
          : Math.floor(deletedAt * 1000)
        : nowMs;
    const deletedHlc = `${String(msToRecord).padStart(13, '0')}-00000-del`;
    await runDb(
      db,
      `INSERT OR REPLACE INTO sync_tombstones (tbl, row_id, deleted_hlc, deleted_at) VALUES (?, ?, ?, ?)`,
      [entityType, uuid, deletedHlc, msToRecord]
    );
  } catch (err: any) {
    console.warn(`[Tombstone] 记录实体 ${entityType}:${uuid} 删除墓碑失败:`, err.message);
  }
}

export async function getTombstonesSince(sinceTimestamp: number = 0): Promise<TombstoneRecord[]> {
  try {
    const db = await getDbInstance();
    const sinceSec = normalizeTimestampSeconds(sinceTimestamp, 0);
    const filterSec = sinceTimestamp > 0 ? sinceSec : 0;
    const rows = await allDb<{ tbl: string; row_id: string; deleted_sec: number }>(
      db,
      `SELECT tbl, row_id,
              CASE WHEN deleted_at > 1000000000000 THEN CAST(deleted_at / 1000 AS INTEGER) ELSE deleted_at END AS deleted_sec
       FROM sync_tombstones
       WHERE (CASE WHEN deleted_at > 1000000000000 THEN CAST(deleted_at / 1000 AS INTEGER) ELSE deleted_at END) > ?
       ORDER BY deleted_sec ASC`,
      [filterSec]
    );
    return rows.map(r => ({
      entity_type: r.tbl,
      uuid: r.row_id,
      deleted_at: Number(r.deleted_sec) || 0
    }));
  } catch (err: any) {
    console.warn('[Tombstone] 获取墓碑列表失败:', err.message);
    return [];
  }
}

export async function cleanOldTombstones(daysToKeep: number = 30): Promise<void> {
  try {
    const db = await getDbInstance();
    const cutoffSec = Math.floor(Date.now() / 1000) - daysToKeep * 86400;
    await runDb(
      db,
      `DELETE FROM sync_tombstones
       WHERE (CASE WHEN deleted_at > 1000000000000 THEN CAST(deleted_at / 1000 AS INTEGER) ELSE deleted_at END) < ?`,
      [cutoffSec]
    );
  } catch (err: any) {}
}
