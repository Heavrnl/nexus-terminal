import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deduplicateAndSortHistory,
  reconcileHistoryWithPending,
  type PendingCommandAdd,
  type PendingCommandDelete,
} from '../src/utils/commandHistorySync.ts';

test('deduplicateAndSortHistory：去重同命令、保留最新时间戳与正数 ID，并按时间降序排列', () => {
  const result = deduplicateAndSortHistory([
    { id: 1, command: 'git status', timestamp: 100 },
    { id: -1, command: '  git status ', timestamp: 200 },
    { id: 5, command: 'git status', timestamp: 200 },
    { id: 2, command: 'ls -la', timestamp: 150 },
    { id: 3, command: '   ', timestamp: 999 },
  ]);

  assert.deepEqual(result, [
    { id: 5, command: 'git status', timestamp: 200 },
    { id: 2, command: 'ls -la', timestamp: 150 },
  ]);
});

test('deduplicateAndSortHistory：超过 maxItems 时按最新截断', () => {
  const input = Array.from({ length: 10 }, (_, i) => ({
    id: i + 1,
    command: `cmd-${i + 1}`,
    timestamp: 1000 + i,
  }));
  const result = deduplicateAndSortHistory(input, 3);
  assert.deepEqual(
    result.map((r) => r.command),
    ['cmd-10', 'cmd-9', 'cmd-8']
  );
});

test('reconcileHistoryWithPending：飞行中的 GET 旧快照不得抹除乐观新增的命令', () => {
  const serverEntries = [
    { id: 10, command: 'old-cmd-1', timestamp: 100 },
    { id: 11, command: 'git status', timestamp: 90 },
  ];
  const pendingAdds = new Map<string, PendingCommandAdd>([
    [
      'new-cmd',
      { command: 'new-cmd', tempId: -1, timestamp: 200, opSeq: 1, status: 'in_flight', attempts: 0 },
    ],
    [
      'git status',
      { command: 'git status', tempId: 11, timestamp: 210, opSeq: 2, status: 'in_flight', attempts: 0 },
    ],
  ]);
  const pendingDeletes = new Map<string, PendingCommandDelete>();

  const merged = reconcileHistoryWithPending(serverEntries, pendingAdds, pendingDeletes, false, 300)!;
  assert.deepEqual(merged, [
    { id: 11, command: 'git status', timestamp: 210 },
    { id: -1, command: 'new-cmd', timestamp: 200 },
    { id: 10, command: 'old-cmd-1', timestamp: 100 },
  ]);
});

test('reconcileHistoryWithPending：正在删除尚未完结的命令不得被 GET 旧快照复活', () => {
  const serverEntries = [
    { id: 10, command: 'keep-me', timestamp: 100 },
    { id: 12, command: 'delete-me', timestamp: 120 },
  ];
  const pendingAdds = new Map<string, PendingCommandAdd>();
  const pendingDeletes = new Map<string, PendingCommandDelete>([
    ['delete-me', { id: 12, command: 'delete-me', opSeq: 5 }],
  ]);

  const merged = reconcileHistoryWithPending(serverEntries, pendingAdds, pendingDeletes, false, 300)!;
  assert.deepEqual(merged, [{ id: 10, command: 'keep-me', timestamp: 100 }]);
});

test('reconcileHistoryWithPending：先删后重新执行同条命令，较新 add 应胜出并保留', () => {
  const serverEntries = [{ id: 12, command: 'echo hi', timestamp: 100 }];
  const pendingDeletes = new Map<string, PendingCommandDelete>([
    ['echo hi', { id: 12, command: 'echo hi', opSeq: 5 }],
  ]);
  const pendingAdds = new Map<string, PendingCommandAdd>([
    [
      'echo hi',
      { command: 'echo hi', tempId: -2, timestamp: 300, opSeq: 6, status: 'in_flight', attempts: 0 },
    ],
  ]);

  const merged = reconcileHistoryWithPending(serverEntries, pendingAdds, pendingDeletes, false, 300)!;
  assert.deepEqual(merged, [{ id: 12, command: 'echo hi', timestamp: 300 }]);
});

test('reconcileHistoryWithPending：清空中直接返回 null 防止旧快照闪回', () => {
  const res = reconcileHistoryWithPending(
    [{ id: 1, command: 'ls', timestamp: 100 }],
    new Map(),
    new Map(),
    true,
    300
  );
  assert.equal(res, null);
});
