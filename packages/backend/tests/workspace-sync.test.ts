import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateLeaseWrite,
  removeSessionFromSnapshot,
  isForeignWorkspaceClient,
  shouldPruneTakeoverSuspend,
  shouldHandoverToSuspend,
  chooseSuspendLogBuffer,
} from '../src/workspace-sync/workspace-sync.pure.ts';

// --- 租约判定 ---

test('evaluateLeaseWrite：无持有者时首个写入者获得租约', () => {
  assert.deepEqual(evaluateLeaseWrite(null, 'tab-a'), { accepted: true, activeClientId: 'tab-a' });
  assert.deepEqual(evaluateLeaseWrite(undefined, 'tab-a'), { accepted: true, activeClientId: 'tab-a' });
  assert.deepEqual(evaluateLeaseWrite('', 'tab-a'), { accepted: true, activeClientId: 'tab-a' });
});

test('evaluateLeaseWrite：持有者自己写入始终可写', () => {
  assert.deepEqual(evaluateLeaseWrite('tab-a', 'tab-a'), { accepted: true, activeClientId: 'tab-a' });
});

test('evaluateLeaseWrite：被接管后旧客户端的写入必须被拒，并回传持有者', () => {
  // 这是"关闭会话后刷新又复活"的根因：旧页面自动保存把会话写回去了
  const decision = evaluateLeaseWrite('tab-b', 'tab-a');
  assert.equal(decision.accepted, false);
  assert.equal(decision.activeClientId, 'tab-b');
});

// --- 快照剔除会话 ---

const baseSnapshot = () => ({
  sessions: [
    { sessionId: 's1', connectionId: 7 },
    { sessionId: 's2', connectionId: 7 },
    { sessionId: 's3', connectionId: 9 },
  ],
  sessionOrder: ['s1', 's2', 's3'],
  activeSessionId: 's2',
  fileManagers: {
    's1:terminal-0': { currentPath: '/' },
    's2:default': { currentPath: '/root' },
    's3:terminal-0': { currentPath: '/etc' },
  },
});

test('removeSessionFromSnapshot：只删目标会话，同连接的其他会话必须保留', () => {
  const result = removeSessionFromSnapshot(baseSnapshot(), 's1');
  assert.deepEqual(result.state.sessions!.map((s) => s.sessionId), ['s2', 's3']);
  assert.equal(result.remainingSessionsCount, 2);
  assert.equal(result.notFound, false);
});

test('removeSessionFromSnapshot：同步维护 sessionOrder 与 activeSessionId', () => {
  const result = removeSessionFromSnapshot(baseSnapshot(), 's2');
  assert.deepEqual(result.state.sessionOrder, ['s1', 's3']);
  // 删的是当前活动会话 → 回落到剩余列表最后一个
  assert.equal(result.state.activeSessionId, 's3');
});

test('removeSessionFromSnapshot：删到最后一个会话时 activeSessionId 置空', () => {
  const snap = {
    sessions: [{ sessionId: 'only' }],
    sessionOrder: ['only'],
    activeSessionId: 'only',
    fileManagers: { 'only:default': {} },
  };
  const result = removeSessionFromSnapshot(snap, 'only');
  assert.equal(result.remainingSessionsCount, 0);
  assert.equal(result.state.activeSessionId, null);
  assert.deepEqual(result.state.sessionOrder, []);
});

test('removeSessionFromSnapshot：只清理该会话的文件管理器实例状态', () => {
  const result = removeSessionFromSnapshot(baseSnapshot(), 's2');
  assert.deepEqual(Object.keys(result.state.fileManagers!), ['s1:terminal-0', 's3:terminal-0']);
});

test('removeSessionFromSnapshot：不修改入参（快照可安全用于回滚）', () => {
  const snap = baseSnapshot();
  const before = JSON.stringify(snap);
  removeSessionFromSnapshot(snap, 's1');
  assert.equal(JSON.stringify(snap), before);
});

test('removeSessionFromSnapshot：目标不存在时保持原样并标记 notFound', () => {
  const result = removeSessionFromSnapshot(baseSnapshot(), 'missing');
  assert.equal(result.notFound, true);
  assert.equal(result.remainingSessionsCount, 3);
});

test('removeSessionFromSnapshot：快照没有 sessions 字段时不抛错', () => {
  const result = removeSessionFromSnapshot({}, 's1');
  assert.equal(result.notFound, true);
  assert.equal(result.remainingSessionsCount, 0);
});

// --- 接管时「谁算别人」 ---

test('isForeignWorkspaceClient：绑了别的 clientId 才算别人', () => {
  assert.equal(isForeignWorkspaceClient('client_b', 'client_a'), true);
});

test('isForeignWorkspaceClient：没绑 clientId 的会话不算别人（桌面端 / 旧客户端 / 竞态窗口）', () => {
  // 这些会话不属于这个工作区，接管时如果顺手挂走，用户就会看到
  // 「挂起池里出现了一个我根本没打开过的连接」
  assert.equal(isForeignWorkspaceClient(undefined, 'client_a'), false);
  assert.equal(isForeignWorkspaceClient(null, 'client_a'), false);
  assert.equal(isForeignWorkspaceClient('', 'client_a'), false);
  assert.equal(isForeignWorkspaceClient('   ', 'client_a'), false);
});

test('isForeignWorkspaceClient：自己不算别人', () => {
  assert.equal(isForeignWorkspaceClient('client_a', 'client_a'), false);
  assert.equal(isForeignWorkspaceClient(' client_a ', 'client_a'), false);
});

// --- 接管遗留挂起条目的清理 ---

const keep = new Set(['live-1', 'live-2']);

test('shouldPruneTakeoverSuspend：上一轮接管留下、快照里已经没有 → 清掉', () => {
  assert.equal(
    shouldPruneTakeoverSuspend({ takeoverRound: 2, originalSessionId: 'gone-1' }, 3, keep),
    true
  );
});

test('shouldPruneTakeoverSuspend：本轮刚挂起来的必须留着（新端马上要 resume）', () => {
  assert.equal(
    shouldPruneTakeoverSuspend({ takeoverRound: 3, originalSessionId: 'gone-1' }, 3, keep),
    false
  );
});

test('shouldPruneTakeoverSuspend：快照里还在的会话不清（可能是快照滞后）', () => {
  assert.equal(
    shouldPruneTakeoverSuspend({ takeoverRound: 2, originalSessionId: 'live-1' }, 3, keep),
    false
  );
});

test('shouldPruneTakeoverSuspend：用户手动挂起的永远不动', () => {
  assert.equal(
    shouldPruneTakeoverSuspend(
      { takeoverRound: 1, originalSessionId: 'gone-1', manuallySuspended: true },
      3,
      keep
    ),
    false
  );
});

test('shouldPruneTakeoverSuspend：不是接管产生的（断线/刷新自动挂起）不动', () => {
  assert.equal(shouldPruneTakeoverSuspend({ originalSessionId: 'gone-1' }, 3, keep), false);
  assert.equal(
    shouldPruneTakeoverSuspend({ takeoverRound: Number.NaN, originalSessionId: 'gone-1' }, 3, keep),
    false
  );
});

test('shouldPruneTakeoverSuspend：没有 originalSessionId 的不动（信息不全就别删）', () => {
  assert.equal(shouldPruneTakeoverSuspend({ takeoverRound: 1 }, 3, keep), false);
});

test('shouldPruneTakeoverSuspend：多端并发抢接管时，宽限保护期内刚挂起的会话不误杀，超期后正常清理', () => {
  const now = Date.parse('2026-11-19T08:00:00.000Z');
  const justSuspended = new Date(now - 500).toISOString();
  const expiredSuspended = new Date(now - 20_000).toISOString();

  assert.equal(
    shouldPruneTakeoverSuspend(
      { takeoverRound: 1, originalSessionId: 'fresh-live', suspendStartTime: justSuspended },
      2,
      keep,
      now
    ),
    false
  );
  assert.equal(
    shouldPruneTakeoverSuspend(
      { takeoverRound: 1, originalSessionId: 'stale-orphan', suspendStartTime: expiredSuspended },
      2,
      keep,
      now
    ),
    true
  );
});

// --- 接管时该不该把会话移交挂起 ---

const liveSession = { hasSshClient: true, hasShellStream: true };

test('shouldHandoverToSuspend：普通活动会话移交挂起', () => {
  assert.equal(shouldHandoverToSuspend({ ...liveSession }), true);
});

test('shouldHandoverToSuspend：无终端会话不移交（否则挂起池里冒出没打开过的连接）', () => {
  assert.equal(shouldHandoverToSuspend({ ...liveSession, isHeadless: true }), false);
});

test('shouldHandoverToSuspend：已标记挂起的不重复移交', () => {
  assert.equal(shouldHandoverToSuspend({ ...liveSession, isMarkedForSuspend: true }), false);
});

test('shouldHandoverToSuspend：SSH 还没建好 / 没有 shell 通道的不移交', () => {
  assert.equal(shouldHandoverToSuspend({ hasSshClient: false, hasShellStream: true }), false);
  assert.equal(shouldHandoverToSuspend({ hasSshClient: true, hasShellStream: false }), false);
});

// --- 移交挂起时用哪份终端历史写日志 ---

test('chooseSuspendLogBuffer：优先用本端内存里的输出（不受会话 id 换代影响）', () => {
  assert.deepEqual(
    chooseSuspendLogBuffer({
      recentOutput: 'flood line 1\r\n',
      snapshotExact: { terminalBuffer: 'snapshot-old' },
      snapshotSameConnection: [{ terminalBuffer: 'snapshot-conn' }],
    }),
    { buffer: 'flood line 1\r\n', source: 'recent' }
  );
});

test('chooseSuspendLogBuffer：内存为空时用快照里 id 一致的那条', () => {
  assert.deepEqual(
    chooseSuspendLogBuffer({
      recentOutput: '',
      snapshotExact: { terminalBuffer: 'snapshot-same-id' },
      snapshotSameConnection: [{ terminalBuffer: 'snapshot-conn' }],
    }),
    { buffer: 'snapshot-same-id', source: 'snapshot' }
  );
});

test('chooseSuspendLogBuffer：id 换代了（快照里只有旧 id）时按连接兜底', () => {
  assert.deepEqual(
    chooseSuspendLogBuffer({
      snapshotExact: null,
      snapshotSameConnection: [{ terminalBuffer: 'prev-generation' }],
    }),
    { buffer: 'prev-generation', source: 'connection' }
  );
});

test('chooseSuspendLogBuffer：同一连接有多条时不敢乱选', () => {
  assert.deepEqual(
    chooseSuspendLogBuffer({
      snapshotSameConnection: [{ terminalBuffer: 'a' }, { terminalBuffer: 'b' }],
    }),
    { buffer: '', source: 'none' }
  );
});

test('chooseSuspendLogBuffer：空内容绝不能当成"可用历史"（写下去就是清屏）', () => {
  assert.deepEqual(
    chooseSuspendLogBuffer({
      recentOutput: '',
      snapshotExact: { terminalBuffer: '' },
      snapshotSameConnection: [{ terminalBuffer: '' }],
    }),
    { buffer: '', source: 'none' }
  );
});
