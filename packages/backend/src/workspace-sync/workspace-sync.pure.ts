/**
 * 工作区快照的纯判定逻辑（不含 IO）。
 *
 * 这两段以前直接写在 WorkspaceSyncService 里，只能靠"打开两个浏览器窗口手动试"来验证。
 * 但它们恰恰是"会话莫名复活 / 被接管后还在写"这类问题的根源，所以抽出来做单测。
 */

export interface LeaseDecision {
  /** 本次写入是否被接受 */
  accepted: boolean;
  /** 当前租约持有者（被拒时前端据此进入接管遮罩） */
  activeClientId: string | null;
}

/**
 * 租约判定：只有持有租约的客户端能写快照。
 *
 * - 没有持有者（首次写入 / 记录被清）→ 任何人可写，并顺势成为持有者。
 * - 持有者就是自己 → 可写。
 * - 别人持有 → 拒绝，并把持有者回传。
 *
 * 为什么必须拒绝而不是"顺手改成本人"：被接管的旧页面只要触发一次自动保存
 * （关标签、改布局都会），就能把已关闭的会话写回快照，下次刷新又"复活"。
 */
export function evaluateLeaseWrite(
  leaseOwner: string | null | undefined,
  clientId: string
): LeaseDecision {
  const owner = leaseOwner || null;
  if (owner && owner !== clientId) {
    return { accepted: false, activeClientId: owner };
  }
  return { accepted: true, activeClientId: clientId };
}

interface SnapshotLike {
  sessions?: Array<{ sessionId: string }>;
  sessionOrder?: string[];
  activeSessionId?: string | null;
  fileManagers?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * 这条会话属于「另一个参与工作区同步的客户端」吗？
 *
 * 只有**绑过** clientId 的 ws 才算。`workspace:bind_client` 是所有终端 ws 在 onopen 时
 * 无条件发的，没绑上说明它根本不参与工作区同步：
 *   - 桌面端（工作区同步恒为关）
 *   - 旧版本 / 第三方客户端
 *   - ws 抢在 workspaceSync store 初始化（生成 clientId）之前就连上的窗口期
 * 这些会话绝不能因为「另开一个网页接管工作区」就被移交挂起 —— 用户看到的现象就是
 * 「挂起池里出现了一个我根本没在这个工作区打开过的连接」。
 */
export function isForeignWorkspaceClient(
  wsClientId: string | null | undefined,
  currentClientId: string
): boolean {
  if (typeof wsClientId !== 'string') return false;
  const id = wsClientId.trim();
  if (!id) return false;
  return id !== currentClientId;
}

/** 参与「该不该清掉这条接管遗留挂起」判定的字段（结构类型，便于单测） */
export interface TakeoverSuspendLike {
  /** 由第几轮工作区接管创建（手动挂起 / 断线自动挂起没有这个值） */
  takeoverRound?: number;
  manuallySuspended?: boolean;
  originalSessionId?: string;
  /** 挂起开始时间（ISO 字符串），用于在多端并发抢接管时提供短暂宽限期，防止误杀刚移交的活会话 */
  suspendStartTime?: string;
}

/** 接管遗留挂起清理的默认宽限保护期（15 秒，覆盖多端并发抢接管与弱网恢复认领窗口） */
export const TAKEOVER_PRUNE_GRACE_MS = 15_000;

/**
 * 「上一轮接管留下的、这一轮恢复再也用不到的」自动挂起条目 → 该清掉。
 *
 * 背景：`claimLease` 每换一次租约就把旧端在跑的会话移交给挂起池。新端恢复时只认领
 * **云端快照里还有的**那些会话，剩下的（旧端自己那一代会话、开出来还没等快照落库的、
 * 不参与同步的客户端会话）永远没人认领 —— 反复接管几次，挂起面板里就堆出一串
 * 看起来毫无缘由的会话。
 *
 * 只清四类都不满足的条目：
 *   1. 用户手动挂起的（关标签右键「挂起会话」）→ 永远归挂起面板
 *   2. 不是接管产生的（断线 / 刷新自动挂起）→ 有 `originalSessionId`，刷新时还要认领
 *   3. 本轮刚挂起来的 → 新端马上要 resume 它
 *   4. 仍在宽限保护期内（刚挂起不到 graceMs）→ 防止多端同时发 claim 时后一轮瞬间杀掉前一轮刚移交的活会话
 */
export function shouldPruneTakeoverSuspend(
  entry: TakeoverSuspendLike,
  currentRound: number,
  keepOriginalSessionIds: ReadonlySet<string>,
  nowMs: number = Date.now(),
  graceMs: number = TAKEOVER_PRUNE_GRACE_MS
): boolean {
  if (entry.manuallySuspended === true) return false;
  const round = entry.takeoverRound;
  if (typeof round !== 'number' || !Number.isFinite(round)) return false;
  if (round >= currentRound) return false;
  const original = entry.originalSessionId;
  if (!original) return false;
  if (keepOriginalSessionIds.has(original)) return false;

  if (entry.suspendStartTime && graceMs > 0) {
    const startedAt = Date.parse(entry.suspendStartTime);
    if (Number.isFinite(startedAt) && nowMs - startedAt < graceMs) {
      return false;
    }
  }
  return true;
}

/** 参与「该不该在接管时移交挂起」判定的字段（结构类型，便于单测） */
export interface TakeoverCandidates {
  /** 无终端会话（文件管理器绑定的私有 SFTP 通道） */
  isHeadless?: boolean;
  /** 已经被标记过挂起（正在移交 / 用户已请求） */
  isMarkedForSuspend?: boolean;
  /** 是否已经建立了 SSH 客户端与 shell 通道 */
  hasSshClient: boolean;
  hasShellStream: boolean;
}

/**
 * 接管工作区时，这条会话该不该移交到挂起池？
 *
 * 无终端会话**不移交**：它不在标签栏里、不承载任何工作区状态，用户也从没打开过它。
 * 把它挂进池子，就是「挂起会话里多出一条我没打开过的连接」——
 * 而新端接管后自己的文件管理器会重新建一条通道，旧的那条留着只会占着 SSH。
 */
export function shouldHandoverToSuspend(entry: TakeoverCandidates): boolean {
  if (entry.isHeadless === true) return false;
  if (entry.isMarkedForSuspend === true) return false;
  return Boolean(entry.hasSshClient && entry.hasShellStream);
}

export interface SuspendBufferChoice {
  /** 写进挂起日志的内容（空字符串 = 拿不到，不要动现有日志） */
  buffer: string;
  /** 来源：recent=本端内存、snapshot=快照同 id、connection=快照同连接、none=无 */
  source: 'recent' | 'snapshot' | 'connection' | 'none';
}

/**
 * 移交挂起时，用哪一份内容写挂起日志？
 *
 * 新端恢复这条会话时，屏幕上有什么**完全取决于这份日志**（回放它）。
 * 所以只要写了空内容，用户看到的就是整屏被清空 —— 反复接管就会一轮比一轮干净。
 *
 * 难点在会话 id 会变：每次 resume 拿到的都是新的后端 SID，而云端快照是按「当时的 id」
 * 存的。接管发生得快时，新端还没来得及把快照按新 id 落库，按 id 就找不到这一条。
 *
 * 取值顺序：
 *   1. 本端内存里攒下的输出 —— resume 时就是用整份日志初始化的（> `fullLogData`），
 *      之后持续追加，既不受 id 变化影响，也最新；
 *   2. 快照里 id 完全一致的那条（前端序列化过的屏幕内容，带 SGR）；
 *   3. 快照里**同一连接且只有一条**的那条 —— id 换代后的兜底；
 *   4. 都没有 → 返回空，调用方必须保留原日志（绝不能写空去截断）。
 */
export function chooseSuspendLogBuffer(input: {
  recentOutput?: string | null;
  snapshotExact?: { terminalBuffer?: string } | null;
  snapshotSameConnection?: Array<{ terminalBuffer?: string }>;
}): SuspendBufferChoice {
  const recent = typeof input.recentOutput === 'string' ? input.recentOutput : '';
  if (recent.length > 0) return { buffer: recent, source: 'recent' };

  const exact = input.snapshotExact?.terminalBuffer;
  if (typeof exact === 'string' && exact.length > 0) return { buffer: exact, source: 'snapshot' };

  const sameConn = (input.snapshotSameConnection ?? []).filter(
    (s) => typeof s?.terminalBuffer === 'string' && s.terminalBuffer.length > 0
  );
  // 同一连接上开着两条标签时无从判断是哪一条，宁可不覆盖
  if (sameConn.length === 1) return { buffer: sameConn[0].terminalBuffer as string, source: 'connection' };

  return { buffer: '', source: 'none' };
}

export interface RemoveSessionResult {
  /** 处理后的快照（输入不会被修改） */
  state: SnapshotLike;
  /** 剩余会话数 */
  remainingSessionsCount: number;
  /** 快照里本来就没有这个会话 */
  notFound: boolean;
}

/**
 * 从快照里精确剔除一个会话。
 *
 * 【铁律】只按 sessionId 匹配，绝不能因 connectionId 相同而误伤同连接下的其他会话。
 * 同时要维护 sessionOrder / activeSessionId / fileManagers，否则：
 * - sessionOrder 残留 → 恢复时按顺序找会话，找到不存在的 id 就中断
 * - activeSessionId 指向已删会话 → 刷新后打开一个空标签
 * - fileManagers 残留 → 组件状态内存泄漏（key 是 `${sessionId}:${instanceId}`）
 */
export function removeSessionFromSnapshot(
  state: SnapshotLike,
  targetSessionId: string
): RemoveSessionResult {
  if (!Array.isArray(state.sessions)) {
    return { state, remainingSessionsCount: 0, notFound: true };
  }

  const remaining = state.sessions.filter((s) => s?.sessionId !== targetSessionId);
  const notFound = remaining.length === state.sessions.length;
  const next: SnapshotLike = { ...state, sessions: remaining };

  if (Array.isArray(state.sessionOrder)) {
    next.sessionOrder = state.sessionOrder.filter((id) => id !== targetSessionId);
  }

  if (state.activeSessionId === targetSessionId) {
    next.activeSessionId = remaining.length > 0 ? remaining[remaining.length - 1].sessionId : null;
  }

  if (state.fileManagers) {
    const cleaned: Record<string, unknown> = {};
    for (const key of Object.keys(state.fileManagers)) {
      if (!key.startsWith(`${targetSessionId}:`)) {
        cleaned[key] = state.fileManagers[key];
      }
    }
    next.fileManagers = cleaned;
  }

  return { state: next, remainingSessionsCount: remaining.length, notFound };
}
