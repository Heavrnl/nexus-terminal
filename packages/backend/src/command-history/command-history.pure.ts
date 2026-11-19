import crypto from 'crypto';

export interface CommandHistoryRowLike {
  id: number;
  command: string;
  timestamp: number;
  uuid?: string | null;
  updated_hlc?: string | null;
}

export interface NormalizedCommandHistoryKeepRow {
  id: number;
  command: string;
  timestamp: number;
  uuid: string;
  updated_hlc: string;
}

export interface DeduplicateCommandHistoryResult {
  deleteIds: number[];
  keepRows: NormalizedCommandHistoryKeepRow[];
}

export interface SyncChangeRowLike {
  seq: number;
  tbl: string;
  row_id: string;
  op: 'U' | 'D';
}

/**
 * 规范化命令文本：非字符串统一视为空串，字符串则去除首尾空白。
 */
export function normalizeCommandText(command: unknown): string {
  if (typeof command !== 'string') {
    return '';
  }
  return command.trim();
}

/**
 * 将毫秒或秒级时间戳统一归一化为秒级整型时间戳。
 */
export function normalizeTimestampSeconds(raw: number | null | undefined, fallbackSec?: number): number {
  const defaultSec =
    typeof fallbackSec === 'number' && Number.isFinite(fallbackSec) && fallbackSec > 0
      ? Math.floor(fallbackSec)
      : Math.floor(Date.now() / 1000);

  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return defaultSec;
  }

  // 大于 1e12 基本可以确定是毫秒时间戳（对应 2001 年以后的毫秒值）
  if (raw > 1e12) {
    return Math.floor(raw / 1000);
  }
  return Math.floor(raw);
}

/**
 * 基于 SHA-1 与固定命名空间生成全局确定性的 RFC4122 UUID v5。
 * 保证同一条命令在桌面端、Web 端及任意恢复库中的 UUID 完全一致，从源头杜绝分身重复。
 */
export function generateDeterministicCommandUuid(command: string): string {
  const normalized = normalizeCommandText(command);
  const hash = crypto
    .createHash('sha1')
    .update('nexus-cmd-history-ns:' + normalized, 'utf8')
    .digest('hex');
  const p1 = hash.substring(0, 8);
  const p2 = hash.substring(8, 12);
  const p3 = '5' + hash.substring(13, 16); // RFC4122 Version 5
  const p4 =
    ((parseInt(hash.substring(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') +
    hash.substring(18, 20); // RFC4122 Variant
  const p5 = hash.substring(20, 32);
  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

/**
 * 对存量命令历史行按规范化后的 command 分组去重：
 * - 空白命令一律剔除进 deleteIds
 * - 同组优先保留 timestamp 最大，其次 updated_hlc 字典序最大，再次 id 最大的行
 * - 保留行聚合组内最大 timestamp 与最大非空 updated_hlc，并生成确定性 UUID
 */
export function deduplicateCommandHistoryRows<T extends CommandHistoryRowLike>(
  rows: T[],
  fallbackHlcBuilder: (ts: number) => string
): DeduplicateCommandHistoryResult {
  const deleteIds: number[] = [];
  const groups = new Map<string, T[]>();

  for (const row of rows) {
    const normalized = normalizeCommandText(row.command);
    if (!normalized) {
      deleteIds.push(row.id);
      continue;
    }
    const list = groups.get(normalized);
    if (list) {
      list.push(row);
    } else {
      groups.set(normalized, [row]);
    }
  }

  const keepRows: NormalizedCommandHistoryKeepRow[] = [];

  for (const [normalizedCmd, group] of groups) {
    let bestRow = group[0];
    let maxTimestamp = normalizeTimestampSeconds(bestRow.timestamp, 0);
    let maxHlc = typeof bestRow.updated_hlc === 'string' ? bestRow.updated_hlc.trim() : '';

    for (let i = 1; i < group.length; i++) {
      const candidate = group[i];
      const candTs = normalizeTimestampSeconds(candidate.timestamp, 0);
      const candHlc = typeof candidate.updated_hlc === 'string' ? candidate.updated_hlc.trim() : '';

      if (candTs > maxTimestamp) {
        maxTimestamp = candTs;
      }
      if (candHlc && candHlc > maxHlc) {
        maxHlc = candHlc;
      }

      const bestTs = normalizeTimestampSeconds(bestRow.timestamp, 0);
      const bestHlc = typeof bestRow.updated_hlc === 'string' ? bestRow.updated_hlc.trim() : '';

      const isBetter =
        candTs > bestTs ||
        (candTs === bestTs && candHlc > bestHlc) ||
        (candTs === bestTs && candHlc === bestHlc && candidate.id > bestRow.id);

      if (isBetter) {
        bestRow = candidate;
      }
    }

    for (const row of group) {
      if (row.id !== bestRow.id) {
        deleteIds.push(row.id);
      }
    }

    const finalTimestamp = maxTimestamp > 0 ? maxTimestamp : Math.floor(Date.now() / 1000);
    const finalHlc = maxHlc || fallbackHlcBuilder(finalTimestamp);

    keepRows.push({
      id: bestRow.id,
      command: normalizedCmd,
      timestamp: finalTimestamp,
      uuid: generateDeterministicCommandUuid(normalizedCmd),
      updated_hlc: finalHlc,
    });
  }

  return { deleteIds, keepRows };
}

/**
 * 对同一批次的增量变更行按 (tbl, row_id) 折叠，只保留 seq 最大的那条并保持 seq 升序输出。
 * 既避免连续多次执行同一命令重复推送/拉取，又保证先改后删正确折叠为 D。
 */
export function collapseSyncChangeRows<T extends SyncChangeRowLike>(rows: T[]): T[] {
  if (rows.length <= 1) {
    return [...rows];
  }

  const latestByKey = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.tbl}\0${row.row_id}`;
    const prev = latestByKey.get(key);
    if (!prev || row.seq >= prev.seq) {
      latestByKey.set(key, row);
    }
  }

  return Array.from(latestByKey.values()).sort((a, b) => a.seq - b.seq);
}
