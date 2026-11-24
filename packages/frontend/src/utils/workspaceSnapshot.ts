/**
 * 工作区快照的纯变换函数（不碰 localStorage / 网络 / Pinia）。
 *
 * 抽出来的原因：这里承载的是"关掉会话后立刻刷新，它又回来了"这类最招人烦的 bug，
 * 判断过程却埋在 1400 行的 store 闭包里，只能靠手动刷页面验证。
 */

export interface SnapshotSessionLike {
  sessionId: string;
}

export interface SnapshotWithSessions {
  sessions: SnapshotSessionLike[];
  sessionOrder?: string[];
  activeSessionId?: string | null;
}

export interface FilterRemovedResult<T> {
  snapshot: T;
  /** 实际剔除的会话数，0 表示原样返回（引用不变） */
  removedCount: number;
}

/**
 * 按"已关闭待清理"清单剔除快照里的会话。
 *
 * 用户关掉会话后立刻刷新时，云端 GET 往往还返回旧快照（删除/保存请求还在路上），
 * 直接恢复就等于"关掉的会话又回来了"。恢复前用本地同步写入的清单过滤一次。
 *
 * 同时维护 `sessionOrder` 与 `activeSessionId`：
 * 被删的会话若正好是活动会话，回落到剩下列表的最后一个（与前端关标签的行为一致）。
 */
export function filterRemovedSessions<T extends SnapshotWithSessions>(
  snapshot: T,
  pendingIds: readonly string[]
): FilterRemovedResult<T> {
  if (!snapshot || !Array.isArray(snapshot.sessions) || pendingIds.length === 0) {
    return { snapshot, removedCount: 0 };
  }

  const pendingSet = new Set(pendingIds);
  const sessions = snapshot.sessions.filter((s) => !pendingSet.has(s.sessionId));
  const removedCount = snapshot.sessions.length - sessions.length;
  if (removedCount <= 0) {
    return { snapshot, removedCount: 0 };
  }

  const sessionOrder = Array.isArray(snapshot.sessionOrder)
    ? snapshot.sessionOrder.filter((id) => !pendingSet.has(id))
    : snapshot.sessionOrder;

  const activeSessionId =
    snapshot.activeSessionId && pendingSet.has(snapshot.activeSessionId)
      ? (sessions[sessions.length - 1]?.sessionId ?? null)
      : snapshot.activeSessionId;

  return {
    snapshot: { ...snapshot, sessions, sessionOrder, activeSessionId },
    removedCount,
  };
}

/**
 * 把"本地当前会话 ID"翻译回快照里的旧 ID。
 *
 * 刷新恢复出来的会话是新建的本地 ID，而快照要等恢复收尾才沉淀新 ID。
 * 这中间的窗口里关闭会话，只记本地 ID 是匹配不到快照的，需要借助别名表。
 */
export function resolveSnapshotSessionId(
  localSessionId: string,
  aliases: Record<string, string> | null | undefined
): string | null {
  if (!localSessionId || !aliases) return null;
  const mapped = aliases[localSessionId];
  if (!mapped || mapped === localSessionId) return null;
  return mapped;
}

/**
 * 把「按 paneId 索引的分屏 buffer」规整成快照存储格式。
 *
 * 做两件事：
 * 1. key 换成跨刷新稳定的先序序号（`pane#0` / `pane#1`）——会话树的 paneId 每次刷新都会
 *    重新生成，直接存 paneId 恢复时必然全部 miss。
 * 2. **摘掉主终端**。主终端内容由 `terminalBuffer` 单独承载，两处都存会让快照凭空大一倍
 *    （实测 1.12MB 里约 0.5MB 是同一份 ANSI 文本）。
 *
 * 只剩主终端时返回 undefined（不写空对象），调用方据此省略字段。
 */
export function normalizePaneBuffers(
  panesBuf: Record<string, string> | null | undefined,
  paneOrder: string[] | null | undefined,
  primaryPaneId?: string | null
): Record<string, string> | undefined {
  if (!panesBuf) return undefined;
  const order = Array.isArray(paneOrder) ? paneOrder : [];
  const normalized: Record<string, string> = {};

  for (const [paneId, buffer] of Object.entries(panesBuf)) {
    if (primaryPaneId && paneId === primaryPaneId) continue;
    const index = order.indexOf(paneId);
    normalized[index >= 0 ? `pane#${index}` : paneId] = buffer;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * 从已有的稳定键字典里再摘一次主终端。
 *
 * 用于兜底缓存（`lastTerminalPanesBuffer`）：它可能来自升级前的版本，那时字典里还带着主终端。
 */
export function stripPrimaryPaneBuffer(
  panesBuf: Record<string, string> | null | undefined,
  primaryPaneKey?: string | null
): Record<string, string> | undefined {
  if (!panesBuf) return undefined;
  const next: Record<string, string> = { ...panesBuf };
  if (primaryPaneKey && next[primaryPaneKey] !== undefined) {
    delete next[primaryPaneKey];
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * 把「按运行时 paneId 索引的分屏目标机托管会话 ID」规整为跨刷新稳定的先序序号键（`pane#1` / `pane#2`）。
 *
 * 规整规则：
 * 1. 剔除主终端（主终端由 `remoteSessionId` 单独承载）；
 * 2. 若 key 已经是 `pane#N` 且不是主终端的序号，原样保留（用于离线占位或副终端尚未挂载时的透传保护）；
 * 3. 若运行时 paneId 在 `paneOrder` 中找到索引 `idx`，统一改写为 `pane#${idx}`；
 * 4. 空字典返回 `undefined`，避免污染快照 JSON。
 */
export function normalizeRemotePaneSessionIds(
  paneSessionIds: Record<string, string> | null | undefined,
  paneOrder: string[] | null | undefined,
  primaryPaneId?: string | null
): Record<string, string> | undefined {
  if (!paneSessionIds) return undefined;
  const order = Array.isArray(paneOrder) ? paneOrder : [];
  const primaryIndex = primaryPaneId ? order.indexOf(primaryPaneId) : -1;
  const primaryStableKey = primaryIndex >= 0 ? `pane#${primaryIndex}` : null;
  const normalized: Record<string, string> = {};

  for (const [rawKey, remoteId] of Object.entries(paneSessionIds)) {
    const trimmedId = typeof remoteId === 'string' ? remoteId.trim() : '';
    if (!trimmedId) continue;
    if (primaryPaneId && rawKey === primaryPaneId) continue;
    if (primaryStableKey && rawKey === primaryStableKey) continue;

    if (rawKey.startsWith('pane#')) {
      // 只有还没有运行时新值覆盖同一序号时才回填旧稳定键
      if (!normalized[rawKey]) {
        normalized[rawKey] = trimmedId;
      }
      continue;
    }

    const idx = order.indexOf(rawKey);
    const stableKey = idx >= 0 ? `pane#${idx}` : rawKey;
    normalized[stableKey] = trimmedId;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
