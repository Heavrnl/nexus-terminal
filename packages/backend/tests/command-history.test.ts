import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  normalizeCommandText,
  normalizeTimestampSeconds,
  generateDeterministicCommandUuid,
  deduplicateCommandHistoryRows,
  collapseSyncChangeRows,
} from '../src/command-history/command-history.pure.ts';

const require = createRequire(import.meta.url);
const sqlite3 = require('sqlite3');
const { execFileSync } = require('node:child_process');

// --- 纯函数单元测试 ---

test('normalizeCommandText：去除首尾空白并将非字符串转为空串', () => {
  assert.equal(normalizeCommandText('  ls -la \n'), 'ls -la');
  assert.equal(normalizeCommandText('   '), '');
  assert.equal(normalizeCommandText(null), '');
  assert.equal(normalizeCommandText(undefined), '');
  assert.equal(normalizeCommandText(12345), '');
});

test('normalizeTimestampSeconds：毫秒转秒与异常值兜底', () => {
  assert.equal(normalizeTimestampSeconds(1700000000), 1700000000);
  assert.equal(normalizeTimestampSeconds(1700000000999), 1700000000);
  assert.equal(normalizeTimestampSeconds(-1, 555), 555);
  assert.equal(normalizeTimestampSeconds(null, 777), 777);
});

test('generateDeterministicCommandUuid：同一命令在任意端生成一致的 RFC4122 v5 UUID', () => {
  const a = generateDeterministicCommandUuid('git status');
  const b = generateDeterministicCommandUuid('  git status  ');
  const c = generateDeterministicCommandUuid('git diff');

  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('deduplicateCommandHistoryRows：按 command 归并重复行并剔除空白行', () => {
  const rows = [
    { id: 1, command: 'ls -la', timestamp: 100, uuid: 'rand-1', updated_hlc: '0000000100000-00000-a' },
    { id: 2, command: '  ls -la ', timestamp: 300, uuid: null, updated_hlc: null },
    { id: 3, command: 'ls -la', timestamp: 200, uuid: 'rand-3', updated_hlc: '0000000200000-00000-b' },
    { id: 4, command: '   ', timestamp: 400, uuid: 'blank', updated_hlc: '0000000400000-00000-a' },
    { id: 5, command: 'pwd', timestamp: 150, uuid: '', updated_hlc: '' },
  ];

  const result = deduplicateCommandHistoryRows(rows, (ts) => `${String(ts * 1000).padStart(13, '0')}-00000-fallback`);

  // id=1, 3 被归并淘汰；id=4 空白被淘汰
  assert.deepEqual(result.deleteIds.sort((x, y) => x - y), [1, 3, 4]);
  assert.equal(result.keepRows.length, 2);

  const lsRow = result.keepRows.find((r) => r.command === 'ls -la')!;
  assert.equal(lsRow.id, 2);
  assert.equal(lsRow.timestamp, 300);
  assert.equal(lsRow.uuid, generateDeterministicCommandUuid('ls -la'));
  assert.equal(lsRow.updated_hlc, '0000000200000-00000-b');

  const pwdRow = result.keepRows.find((r) => r.command === 'pwd')!;
  assert.equal(pwdRow.id, 5);
  assert.equal(pwdRow.uuid, generateDeterministicCommandUuid('pwd'));
  assert.equal(pwdRow.updated_hlc, '0000000150000-00000-fallback');
});

test('collapseSyncChangeRows：同批次相同 (tbl, row_id) 仅保留最大 seq 并保持升序', () => {
  const rows = [
    { seq: 1, tbl: 'command_history', row_id: 'u1', op: 'U' as const },
    { seq: 2, tbl: 'command_history', row_id: 'u2', op: 'U' as const },
    { seq: 3, tbl: 'command_history', row_id: 'u1', op: 'U' as const },
    { seq: 4, tbl: 'command_history', row_id: 'u2', op: 'D' as const },
    { seq: 5, tbl: 'connections', row_id: 'c1', op: 'U' as const },
  ];

  const collapsed = collapseSyncChangeRows(rows);
  assert.deepEqual(collapsed, [
    { seq: 3, tbl: 'command_history', row_id: 'u1', op: 'U' },
    { seq: 4, tbl: 'command_history', row_id: 'u2', op: 'D' },
    { seq: 5, tbl: 'connections', row_id: 'c1', op: 'U' },
  ]);
});

// --- 真实 SQLite 集成测试（完全隔离临时目录） ---

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cmdhist-test-'));
let openedDb: any = null;

after(async () => {
  if (openedDb) {
    await new Promise<void>((resolve) => openedDb.close(() => resolve()));
    openedDb = null;
  }
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

test('真实 SQLite 集成：Migration 33 清洗老库重复脏数据 + 50 并发 upsert + 写屏障全唤醒 + SAVEPOINT 深度隔离', async () => {
  // 1. 先在独立子进程用真实代码初始化完整表结构，随后降级回退到 Migration #32 状态并植入脏数据与旧版触发器
  const tsconfigPath = path.resolve(import.meta.dirname, '../tsconfig.json');
  const connFilePath = path.resolve(import.meta.dirname, '../src/database/connection.ts');
  execFileSync(
    process.execPath,
    [
      '-e',
      `require('ts-node').register({ transpileOnly: true, project: ${JSON.stringify(tsconfigPath)} });` +
        `const c = require(${JSON.stringify(connFilePath)});` +
        `c.getDbInstance().then((db) => new Promise((r) => db.close(() => r()))).catch((e) => { console.error(e); process.exit(1); });`,
    ],
    {
      env: { ...process.env, NEXUS_DATA_DIR: tempDataDir },
      stdio: 'pipe',
    }
  );

  const dbPath = path.join(tempDataDir, 'nexus-terminal.db');
  const legacyDb = new sqlite3.Database(dbPath);
  const execLegacy = (sql: string) =>
    new Promise<void>((resolve, reject) => legacyDb.exec(sql, (err: any) => (err ? reject(err) : resolve())));

  await execLegacy(`
    DROP INDEX IF EXISTS idx_command_history_command_unique;
    CREATE INDEX IF NOT EXISTS idx_command_history_command ON command_history(command);
    DELETE FROM migrations WHERE id >= 33;
    UPDATE sync_state SET enabled = 1, applying = 0, device_id = 'testdev1', hlc_ms = 1700000000000 WHERE id = 1;

    -- 模拟老版本带有 NEW.uuid 空洞的旧触发器，验证重启会自动强行重装
    DROP TRIGGER IF EXISTS command_history_sync_au;
    CREATE TRIGGER command_history_sync_au AFTER UPDATE OF command, timestamp ON command_history
    WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0 AND (SELECT enabled FROM sync_state WHERE id = 1) = 1
    AND NEW.updated_hlc IS OLD.updated_hlc
    BEGIN
      UPDATE sync_state SET hlc_ctr = hlc_ctr + 1 WHERE id = 1;
      UPDATE command_history SET updated_hlc = (SELECT printf('%013d-%05d-%s', hlc_ms, hlc_ctr, device_id) FROM sync_state WHERE id = 1) WHERE id = NEW.id;
      INSERT INTO sync_changes(tbl, row_id, op, origin) VALUES ('command_history', NEW.uuid, 'U', NULL);
    END;

    DELETE FROM command_history;
    INSERT INTO command_history (id, command, timestamp, uuid, updated_hlc) VALUES
      (1, 'git status', 1000, 'random-uuid-1', '0001000000000-00000-a'),
      (2, 'git status', 1000, 'random-uuid-2', '0001000000000-00001-b'),
      (3, '  git status  ', 2000, NULL, NULL),
      (4, 'docker ps', 1500, '', ''),
      (5, 'docker ps', 1800, 'random-uuid-3', '0001800000000-00000-b'),
      (6, '   ', 3000, 'blank-uuid', '0003000000000-00000-a');

    INSERT INTO sync_changes (tbl, row_id, op, origin) VALUES
      ('command_history', 'random-uuid-1', 'U', NULL),
      ('command_history', 'random-uuid-2', 'U', NULL);
  `);
  await new Promise<void>((resolve) => legacyDb.close(() => resolve()));

  // 2. 设置隔离环境变量并加载真实后端模块触发初始化、Migration #33 与旧触发器强行重装
  process.env.NEXUS_DATA_DIR = tempDataDir;
  const tsNode = require('ts-node');
  tsNode.register({
    transpileOnly: true,
    project: tsconfigPath,
  });

  const conn = require('../src/database/connection.ts');
  const repo = require('../src/command-history/command-history.repository.ts');

  const db = await conn.getDbInstance();
  openedDb = db;

  // 确认旧触发器已被识别并重装为新版（不含 VALUES ('command_history', NEW.uuid）
  const trigRow = await conn.getDb(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'command_history_sync_au'"
  );
  assert.ok(trigRow?.sql && !trigRow.sql.includes("VALUES ('command_history', NEW.uuid"));

  // 校验 Migration #33 结果：0 重复、0 空白、全表确定性 UUID、唯一索引已就位
  const migratedRows = await conn.allDb(db, 'SELECT * FROM command_history ORDER BY command ASC');
  assert.equal(migratedRows.length, 2);
  assert.equal(migratedRows[0].command, 'docker ps');
  assert.equal(migratedRows[0].timestamp, 1800);
  assert.equal(migratedRows[0].uuid, generateDeterministicCommandUuid('docker ps'));
  assert.equal(migratedRows[1].command, 'git status');
  assert.equal(migratedRows[1].timestamp, 2000);
  assert.equal(migratedRows[1].uuid, generateDeterministicCommandUuid('git status'));

  // 校验唯一索引直接拦截非法重复 INSERT
  await assert.rejects(
    () => conn.runDb(db, `INSERT INTO command_history (command, timestamp, uuid) VALUES ('git status', 9999, 'dup-uuid')`),
    /UNIQUE constraint failed/i
  );

  // 3. 验证 50 并发相同命令 + 50 并发不同命令 upsertCommand：0 报错、0 重复、0 丢失
  await conn.runDb(db, 'UPDATE sync_state SET enabled = 1 WHERE id = 1');
  const sameTasks = Array.from({ length: 50 }, () => repo.upsertCommand('  kubectl get pods -A  '));
  const distinctTasks = Array.from({ length: 50 }, (_, i) => repo.upsertCommand(`echo concurrent_cmd_${i}`));
  await Promise.all([...sameTasks, ...distinctTasks]);

  const sameCountRow = await conn.getDb(
    db,
    `SELECT COUNT(*) AS cnt FROM command_history WHERE command = 'kubectl get pods -A'`
  );
  assert.equal(sameCountRow.cnt, 1);

  const distinctCountRow = await conn.getDb(
    db,
    `SELECT COUNT(*) AS cnt FROM command_history WHERE command LIKE 'echo concurrent_cmd_%'`
  );
  assert.equal(distinctCountRow.cnt, 50);

  // 验证原子 upsert 生成了确定性 UUID 且触发器补上了 updated_hlc
  const k8sRow = await conn.getDb(
    db,
    `SELECT uuid, updated_hlc FROM command_history WHERE command = 'kubectl get pods -A'`
  );
  assert.equal(k8sRow.uuid, generateDeterministicCommandUuid('kubectl get pods -A'));
  assert.ok(k8sRow.updated_hlc && k8sRow.updated_hlc.length > 10);

  // 4. 验证 acquireApplyLock 写屏障并发多路挂起唤醒（修复前仅唤醒 1 条导致其余永久死锁）
  const releaseApply = await conn.acquireApplyLock();
  let completedWrites = 0;
  const barrierPromises = Array.from({ length: 20 }, (_, i) =>
    repo.upsertCommand(`echo barrier_write_${i}`).then((entry: any) => {
      completedWrites++;
      return entry;
    })
  );

  // 短暂等待确认持锁期间普通写入全部安全挂起
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(completedWrites, 0);

  // 释放锁后，20 路写入必须全部被唤醒并完成
  releaseApply();
  await Promise.race([
    Promise.all(barrierPromises),
    new Promise((_, reject) => setTimeout(() => reject(new Error('写屏障唤醒超时，疑似死锁！')), 3000)),
  ]);
  assert.equal(completedWrites, 20);

  // 5. 验证 ROLLBACK TO SAVEPOINT 不会错误清零 transactionDepth
  await conn.runDb(db, 'BEGIN');
  assert.equal(conn.isDbInTransaction(), true);
  await conn.runDb(db, 'SAVEPOINT sp_nested');
  await conn.runDb(db, 'ROLLBACK TO SAVEPOINT sp_nested');
  assert.equal(conn.isDbInTransaction(), true, 'ROLLBACK TO SAVEPOINT 不应提前将 transactionDepth 归零');
  await conn.runDb(db, 'COMMIT');
  assert.equal(conn.isDbInTransaction(), false);

  // 6. 验证 Sync V2 历史作废 DELETE 不再伪造 Date.now() HLC 反杀复活记录
  const { syncV2Service } = require('../src/sync/sync.v2.service.ts');
  const targetEntry = await repo.upsertCommand('echo revive_after_delete_guard');
  const reviveUuid = generateDeterministicCommandUuid('echo revive_after_delete_guard');
  const maxSeqBeforeRow = await conn.getDb(db, 'SELECT COALESCE(MAX(seq), 0) AS m FROM sync_changes');
  const cursorBefore = maxSeqBeforeRow.m;

  // 模拟更早有一条作废的历史删除 op='D'（对应墓碑已在后续复活中被清空，实体当前在库中存活）
  await conn.runDb(db, `DELETE FROM sync_tombstones WHERE tbl = 'command_history' AND row_id = ?`, [reviveUuid]);
  await conn.runDb(
    db,
    `INSERT INTO sync_changes (tbl, row_id, op, origin) VALUES ('command_history', ?, 'D', NULL)`,
    [reviveUuid]
  );

  // 设置 push_cursor 为 cursorBefore，验证 extractLocalChangesToPush 跳过该作废 DELETE
  await conn.runDb(db, `UPDATE sync_state SET push_cursor = ? WHERE id = 1`, [cursorBefore]);
  const extracted = await syncV2Service.extractLocalChangesToPush('test-secret');
  const stalePushDel = extracted.changes.find(
    (c: any) => c.tbl === 'command_history' && c.row_id === reviveUuid && c.op === 'D'
  );
  assert.equal(stalePushDel, undefined, 'extractLocalChangesToPush 必须跳过已复活记录的作废 DELETE');

  // 同样验证 handlePull 跳过该作废 DELETE（且游标正常推进）
  const pulled = await syncV2Service.handlePull('other-device', cursorBefore, 200, 'test-secret');
  const stalePullDel = pulled.changes.find(
    (c: any) => c.tbl === 'command_history' && c.row_id === reviveUuid && c.op === 'D'
  );
  assert.equal(stalePullDel, undefined, 'handlePull 必须跳过已复活记录的作废 DELETE，禁止伪造 Date.now() 删除');
  assert.ok(pulled.next_cursor > cursorBefore, '跳过作废变更后 next_cursor 仍必须前进');
  assert.ok(targetEntry.id > 0);
});
