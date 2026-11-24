import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  filterRemovedSessions,
  normalizePaneBuffers,
  normalizeRemotePaneSessionIds,
  resolveSnapshotSessionId,
  stripPrimaryPaneBuffer,
} from '../src/utils/workspaceSnapshot.ts';

/**
 * 这组用例守护的是"关掉会话后立刻刷新，它又回来了"这个反复出现的 bug。
 * 关键点：快照里还是旧数据（删除请求在路上），必须靠本地清单在恢复前剔除。
 */
function snapshot() {
  return {
    sessions: [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }],
    sessionOrder: ['a', 'b', 'c'],
    activeSessionId: 'b',
    layout: null,
  };
}

test('没有任何待清理记录时原样返回（引用不变）', () => {
  const snap = snapshot();
  const result = filterRemovedSessions(snap, []);
  assert.equal(result.snapshot, snap);
  assert.equal(result.removedCount, 0);
});

test('只剔除命中的会话，其余顺序不变', () => {
  const result = filterRemovedSessions(snapshot(), ['b']);
  assert.deepEqual(result.snapshot.sessions.map((s) => s.sessionId), ['a', 'c']);
  assert.deepEqual(result.snapshot.sessionOrder, ['a', 'c']);
  assert.equal(result.removedCount, 1);
});

test('被剔除的正好是活动会话时，回落到剩下的最后一个', () => {
  const result = filterRemovedSessions(snapshot(), ['c']);
  assert.equal(result.snapshot.activeSessionId, 'b');

  const second = filterRemovedSessions(snapshot(), ['b']);
  assert.equal(second.snapshot.activeSessionId, 'c');
});

test('活动会话没被剔除时保持不变', () => {
  const result = filterRemovedSessions(snapshot(), ['a']);
  assert.equal(result.snapshot.activeSessionId, 'b');
});

test('全部会话都被剔除时 activeSessionId 置空', () => {
  const result = filterRemovedSessions(snapshot(), ['a', 'b', 'c']);
  assert.deepEqual(result.snapshot.sessions, []);
  assert.equal(result.snapshot.activeSessionId, null);
  assert.deepEqual(result.snapshot.sessionOrder, []);
});

test('清单里有不存在的 ID 时不产生变化（引用不变）', () => {
  const snap = snapshot();
  const result = filterRemovedSessions(snap, ['zzz']);
  assert.equal(result.snapshot, snap);
  assert.equal(result.removedCount, 0);
});

test('快照没有 sessionOrder 时不报错', () => {
  const snap = { sessions: [{ sessionId: 'a' }], activeSessionId: 'a' };
  const result = filterRemovedSessions(snap, ['a']);
  assert.deepEqual(result.snapshot.sessions, []);
  assert.equal(result.snapshot.activeSessionId, null);
});

test('其它字段（layout / fileEditor 等）原样保留', () => {
  const snap = { ...snapshot(), fileEditor: { tabs: [{ id: 't1' }] } };
  const result = filterRemovedSessions(snap, ['a']);
  assert.deepEqual(result.snapshot.fileEditor, { tabs: [{ id: 't1' }] });
});

test('resolveSnapshotSessionId：只解析真实存在的别名', () => {
  const aliases = { localNew: 'snapshotOld' };
  assert.equal(resolveSnapshotSessionId('localNew', aliases), 'snapshotOld');
  assert.equal(resolveSnapshotSessionId('unknown', aliases), null);
  assert.equal(resolveSnapshotSessionId('', aliases), null);
  assert.equal(resolveSnapshotSessionId('localNew', null), null);
  // 自我映射不算别名（避免把本地 ID 再记一遍）
  assert.equal(resolveSnapshotSessionId('same', { same: 'same' }), null);
});

// --- 分屏 buffer 规整（换稳定键 + 摘掉主终端） ---

test('normalizePaneBuffers：只有主终端时返回 undefined（不写空对象）', () => {
  const result = normalizePaneBuffers({ 'terminal-0': 'A' }, ['terminal-0'], 'terminal-0');
  assert.equal(result, undefined);
});

test('normalizePaneBuffers：主终端被摘掉，副终端键换成先序序号', () => {
  const result = normalizePaneBuffers(
    { 'terminal-0': 'MAIN', 'terminal-1': 'SUB' },
    ['terminal-0', 'terminal-1'],
    'terminal-0'
  );
  assert.deepEqual(result, { 'pane#1': 'SUB' });
});

test('normalizePaneBuffers：主终端不在先序表里时按原始 paneId 摘除', () => {
  const result = normalizePaneBuffers(
    { primary: 'MAIN', 'terminal-1': 'SUB' },
    ['terminal-1'],
    'primary'
  );
  assert.deepEqual(result, { 'pane#0': 'SUB' });
});

test('normalizePaneBuffers：null / 空字典都返回 undefined', () => {
  assert.equal(normalizePaneBuffers(null, [], 'x'), undefined);
  assert.equal(normalizePaneBuffers({}, [], 'x'), undefined);
});

test('stripPrimaryPaneBuffer：从升级前的旧字典里摘掉主终端', () => {
  // 旧版本存的是 pane#0（主）+ pane#1（副）
  const result = stripPrimaryPaneBuffer({ 'pane#0': 'MAIN', 'pane#1': 'SUB' }, 'pane#0');
  assert.deepEqual(result, { 'pane#1': 'SUB' });
});

test('stripPrimaryPaneBuffer：摘完为空时返回 undefined', () => {
  assert.equal(stripPrimaryPaneBuffer({ 'pane#0': 'MAIN' }, 'pane#0'), undefined);
});

test('stripPrimaryPaneBuffer：不改入参（兜底缓存可能还被别处引用）', () => {
  const src = { 'pane#0': 'MAIN', 'pane#1': 'SUB' };
  stripPrimaryPaneBuffer(src, 'pane#0');
  assert.deepEqual(src, { 'pane#0': 'MAIN', 'pane#1': 'SUB' });
});

// --- 分屏目标机托管会话 ID 规整 ---

test('normalizeRemotePaneSessionIds：剔除主终端并将副终端转为跨刷新稳定键', () => {
  const result = normalizeRemotePaneSessionIds(
    { 'terminal-0': 'nx-main', 'terminal-1': 'nx-pane-a', 'terminal-2': 'nx-pane-b' },
    ['terminal-0', 'terminal-1', 'terminal-2'],
    'terminal-0'
  );
  assert.deepEqual(result, { 'pane#1': 'nx-pane-a', 'pane#2': 'nx-pane-b' });
});

test('normalizeRemotePaneSessionIds：离线占位时保留已有 pane#N 稳定键且忽略空值', () => {
  const result = normalizeRemotePaneSessionIds(
    { 'pane#0': 'nx-main', 'pane#1': 'nx-pane-offline', 'pane#2': '   ' },
    ['terminal-0', 'terminal-1', 'terminal-2'],
    'terminal-0'
  );
  assert.deepEqual(result, { 'pane#1': 'nx-pane-offline' });
});

test('normalizeRemotePaneSessionIds：仅主终端或空对象返回 undefined', () => {
  assert.equal(normalizeRemotePaneSessionIds(null, [], 'terminal-0'), undefined);
  assert.equal(
    normalizeRemotePaneSessionIds({ 'terminal-0': 'nx-main' }, ['terminal-0'], 'terminal-0'),
    undefined
  );
});
