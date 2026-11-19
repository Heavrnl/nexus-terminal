export interface CommandHistoryEntryLike {
  id: number;
  command: string;
  timestamp: number;
}

export interface PendingCommandAdd {
  command: string;
  tempId: number;
  timestamp: number;
  opSeq: number;
  status: 'in_flight' | 'failed';
  attempts: number;
}

export interface PendingCommandDelete {
  id: number;
  command: string;
  opSeq: number;
}

/**
 * 对历史命令列表按规范化命令文本去重、按最新时间戳降序排列并截断至 maxItems。
 * 同命令出现多条时，优先保留 timestamp 较大者；同 timestamp 时优先保留正数正式 ID。
 */
export function deduplicateAndSortHistory<T extends CommandHistoryEntryLike>(
  entries: readonly T[],
  maxItems: number = 300
): CommandHistoryEntryLike[] {
  const byCommand = new Map<string, CommandHistoryEntryLike>();

  for (const raw of entries) {
    const normalized = typeof raw?.command === 'string' ? raw.command.trim() : '';
    if (!normalized) {
      continue;
    }

    const ts = typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp) ? raw.timestamp : 0;
    const id = typeof raw.id === 'number' && Number.isFinite(raw.id) ? raw.id : 0;

    const existing = byCommand.get(normalized);
    if (!existing) {
      byCommand.set(normalized, { id, command: normalized, timestamp: ts });
      continue;
    }

    const existingPositive = existing.id > 0;
    const candidatePositive = id > 0;
    const shouldReplace =
      ts > existing.timestamp ||
      (ts === existing.timestamp &&
        ((candidatePositive && !existingPositive) ||
          (candidatePositive === existingPositive && id > existing.id)));

    if (shouldReplace) {
      byCommand.set(normalized, { id, command: normalized, timestamp: ts });
    }
  }

  const sorted = Array.from(byCommand.values()).sort((a, b) => {
    if (b.timestamp !== a.timestamp) {
      return b.timestamp - a.timestamp;
    }
    return b.id - a.id;
  });

  if (maxItems > 0 && sorted.length > maxItems) {
    sorted.length = maxItems;
  }
  return sorted;
}

/**
 * 将后端拉取的快照与前端本地进行中的乐观新增 / 删除 / 清空状态安全合并：
 * - 若正在清空历史，直接返回 null 避免旧快照闪回
 * - 若命令处于待删除状态且删除操作晚于任何新增，剔除服务端残留旧行
 * - 若命令处于待新增或重试状态，确保不会被较旧的 GET 快照抹掉，且优先保留正式正数 ID
 */
export function reconcileHistoryWithPending(
  serverEntries: readonly CommandHistoryEntryLike[],
  pendingAdds: ReadonlyMap<string, PendingCommandAdd>,
  pendingDeletes: ReadonlyMap<string, PendingCommandDelete>,
  isClearing: boolean,
  maxItems: number = 300
): CommandHistoryEntryLike[] | null {
  if (isClearing) {
    return null;
  }

  const mergedByCommand = new Map<string, CommandHistoryEntryLike>();

  for (const raw of serverEntries) {
    const cmd = typeof raw?.command === 'string' ? raw.command.trim() : '';
    if (!cmd) continue;

    const pendingDel = pendingDeletes.get(cmd);
    const pendingAdd = pendingAdds.get(cmd);
    if (pendingDel && (!pendingAdd || pendingAdd.opSeq < pendingDel.opSeq)) {
      continue;
    }

    const ts = typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp) ? raw.timestamp : 0;
    const id = typeof raw.id === 'number' && Number.isFinite(raw.id) ? raw.id : 0;

    const prev = mergedByCommand.get(cmd);
    if (!prev || ts > prev.timestamp || (ts === prev.timestamp && id > prev.id)) {
      mergedByCommand.set(cmd, { id, command: cmd, timestamp: ts });
    }
  }

  for (const add of pendingAdds.values()) {
    const pendingDel = pendingDeletes.get(add.command);
    if (pendingDel && pendingDel.opSeq > add.opSeq) {
      continue;
    }

    const serverItem = mergedByCommand.get(add.command);
    if (!serverItem) {
      mergedByCommand.set(add.command, {
        id: add.tempId,
        command: add.command,
        timestamp: add.timestamp,
      });
    } else if (serverItem.timestamp < add.timestamp) {
      // GET 结果落后于本地刚触发的 addCommand：保留服务端正式正数 ID（若有），采用最新时间戳
      mergedByCommand.set(add.command, {
        id: serverItem.id > 0 ? serverItem.id : add.tempId,
        command: add.command,
        timestamp: add.timestamp,
      });
    }
  }

  return deduplicateAndSortHistory(Array.from(mergedByCommand.values()), maxItems);
}
