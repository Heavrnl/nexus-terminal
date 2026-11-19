import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import xtermHeadless from '@xterm/headless';
const HeadlessTerminal = xtermHeadless.Terminal;

import { BackendTerminalEmulator } from '../src/websocket/terminal-emulator.ts';

const requireFromHere = createRequire(import.meta.url);
function loadSuspendModules() {
  requireFromHere('ts-node').register({
    transpileOnly: true,
    compilerOptions: { module: 'CommonJS', moduleResolution: 'node' },
  });
  const { SshSuspendService } = requireFromHere('../src/ssh-suspend/ssh-suspend.service.ts');
  const { TemporaryLogStorageService } = requireFromHere('../src/ssh-suspend/temporary-log-storage.service.ts');
  return { SshSuspendService, TemporaryLogStorageService };
}

/** 辅助：把一段数据喂给一颗全新的前端同款 xterm 实例，收集它自动触发的所有 onData 回包及屏幕行 */
async function feedIntoFreshTerminal(
  payload: string,
  cols = 80,
  rows = 24
): Promise<{ replies: string[]; lines: string[]; bufferType: string }> {
  const term = new HeadlessTerminal({
    cols,
    rows,
    scrollback: 5000,
    allowProposedApi: true,
    logLevel: 'off',
  });
  const replies: string[] = [];
  term.onData((d) => replies.push(d));
  await new Promise<void>((resolve) => term.write(payload, resolve));
  const lines: string[] = [];
  for (let i = 0; i < term.buffer.active.length; i++) {
    const line = term.buffer.active.getLine(i);
    if (line) {
      const txt = line.translateToString(true);
      if (txt.length > 0) lines.push(txt);
    }
  }
  const bufferType = term.buffer.active.type;
  term.dispose();
  return { replies, lines, bufferType };
}

test('BackendTerminalEmulator：空终端 serialize 返回空串且 hasAnyOutput 为 false', async () => {
  const vt = new BackendTerminalEmulator({ cols: 100, rows: 30 });
  assert.equal(vt.hasAnyOutput(), false);
  assert.deepEqual(vt.getDimensions(), { cols: 100, rows: 30 });
  assert.equal(await vt.serialize(), '');
  vt.dispose();
  assert.equal(vt.isDisposed(), true);
});

test('BackendTerminalEmulator：写入全套终端探测查询后，序列化快照喂给新终端 0 次自动回包', async () => {
  const vt = new BackendTerminalEmulator({ cols: 100, rows: 30 });

  // 模拟 agy cli / vim / starship 等两次启动发出的全套探测指令（DA2 / DA1 / DA3 / OSC 10~12 / OSC 4 / DSR / CPR / DECRQM / XTVERSION / XTWINOPS）
  const probeBurst = [
    '\x1b[>c',
    '\x1b[>0c',
    '\x1b[c',
    '\x1b[0c',
    '\x1b[=c',
    '\x1b]10;?\x07',
    '\x1b]11;?\x07',
    '\x1b]11;?\x1b\\',
    '\x1b]12;?\x07',
    '\x1b]4;0;?\x07',
    '\x1b[5n',
    '\x1b[6n',
    '\x1b[?6n',
    '\x1b[?2026$p',
    '\x1b[>0q',
    '\x1b[18t',
  ].join('');

  vt.write(probeBurst);
  vt.write('\x1b[38;2;255;128;64m第一轮中文输出 🚀\x1b[0m\r\n');
  vt.write(probeBurst);
  vt.write('第二轮输出 ok\r\nroot@prod:~# ');

  const serialized = await vt.serialize();
  assert.ok(serialized.length > 0);
  // 序列化产物中绝不含任何探测查询序列
  assert.equal(serialized.includes('\x1b[>c'), false);
  assert.equal(serialized.includes('\x1b[c'), false);
  assert.equal(serialized.includes('\x1b]11;?'), false);
  assert.equal(serialized.includes('\x1b[6n'), false);

  // 喂给新终端实例，验证不会产生 `;276;0c1;2c11;rgb:0000/0000/0000` 之类任何自动回复
  const replayResult = await feedIntoFreshTerminal(serialized, 100, 30);
  assert.deepEqual(replayResult.replies, []);
  assert.ok(replayResult.lines.some((l) => l.includes('第一轮中文输出 🚀')));
  assert.ok(replayResult.lines.some((l) => l.includes('第二轮输出 ok')));
  assert.ok(replayResult.lines.some((l) => l.includes('root@prod:~#')));

  vt.dispose();
});

test('BackendTerminalEmulator：备用屏 TUI 与主屏高频覆写重绘准确还原且大幅压缩体积', async () => {
  const vt = new BackendTerminalEmulator({ cols: 80, rows: 24 });

  // 1. 主屏跑 500 次同行进度条覆写（类似 agy cli / npm / cargo 进度重绘）
  vt.write('root@host:~# run-task\r\n');
  for (let i = 1; i <= 500; i++) {
    vt.write(`\r\x1b[2KProgress: ${i}/500 [##########]`);
  }
  vt.write('\r\nTask Done!\r\n');

  const normalSerialized = await vt.serialize();
  // 500 次覆写被状态机消化成最终结果，不包含中间帧
  assert.equal(normalSerialized.includes('Progress: 1/500'), false);
  assert.equal(normalSerialized.includes('Progress: 500/500'), true);
  assert.equal(normalSerialized.includes('Task Done!'), true);
  assert.ok(normalSerialized.length < 2000, `序列化应被高度压缩，实际长度 ${normalSerialized.length}`);

  // 2. 进入备用屏（vim / btop）并夹带查询序列
  vt.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[>c\x1b[c\x1b]11;?\x07=== BTOP ALT SCREEN ===');
  await vt.flush();
  assert.equal(vt.isAlternateScreen(), true);

  const altSerialized = await vt.serialize();
  const replayedAlt = await feedIntoFreshTerminal(altSerialized, 80, 24);
  assert.deepEqual(replayedAlt.replies, []);
  assert.equal(replayedAlt.bufferType, 'alternate');
  assert.ok(replayedAlt.lines.some((l) => l.includes('=== BTOP ALT SCREEN ===')));

  vt.dispose();
});

test('BackendTerminalEmulator：resize、跨包多字节、洪流背压保护与 dispose 幂等安全', async () => {
  const vt = new BackendTerminalEmulator({ cols: 80, rows: 24, scrollback: 200 });
  vt.resize(132, 40);
  assert.deepEqual(vt.getDimensions(), { cols: 132, rows: 40 });

  // 原始 Uint8Array 写入中文
  const utf8Bytes = Buffer.from('多字节UTF8验证：工作区同步稳定 ✅\r\n', 'utf8');
  vt.write(utf8Bytes.subarray(0, 7));
  vt.write(utf8Bytes.subarray(7));

  const ser1 = await vt.serialize();
  const res1 = await feedIntoFreshTerminal(ser1, 132, 40);
  assert.ok(res1.lines.some((l) => l.includes('多字节UTF8验证：工作区同步稳定 ✅')));

  // 模拟 12MB 瞬时刷屏洪流，不应抛出异常打崩进程
  const chunk = 'X'.repeat(120) + '\r\n';
  const bigBlock = chunk.repeat(500); // ~61KB
  assert.doesNotThrow(() => {
    for (let i = 0; i < 200; i++) {
      vt.write(bigBlock);
    }
  });
  await vt.flush(3000);
  const serAfterFlood = await vt.serialize();
  assert.ok(serAfterFlood.length > 0);

  // dispose 幂等且后续调用全部安全无抛错
  vt.dispose();
  vt.dispose();
  assert.equal(vt.isDisposed(), true);
  assert.doesNotThrow(() => {
    vt.write('after dispose');
    vt.resize(100, 30);
  });
  await vt.flush();
  assert.equal(await vt.serialize(), '');
});

test('SshSuspendService + BackendTerminalEmulator：全生命周期多轮挂起/恢复接力（full 纯净 + delta 精准 + 销毁释放）', async () => {
  const { SshSuspendService, TemporaryLogStorageService } = loadSuspendModules();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-vt-suspend-'));
  try {
    const logStorage = new TemporaryLogStorageService(tmpDir);
    const suspendService = new SshSuspendService(logStorage);

    // 构造轻量模拟 SSH Client & Channel
    const fakeClient = Object.assign(new EventEmitter(), {
      end() {},
      destroy() {},
    }) as any;
    const fakeChannel = Object.assign(new EventEmitter(), {
      readable: true,
      writable: true,
      close() {},
      end() {},
      destroy() {},
    }) as any;

    // 第一阶段：在线态 VT 接收含查询序列的输出
    const vt = new BackendTerminalEmulator({ cols: 100, rows: 30 });
    vt.write('\x1b[>c\x1b[c\x1b]11;?\x07Online Line 1\r\n');

    // 第二阶段：工作区接管/断线挂起，移交同一颗 VT
    const initialSerialized = await vt.serialize();
    const suspendId1 = await suspendService.takeOverMarkedSession({
      userId: 1,
      originalSessionId: 'sess-1',
      sshClient: fakeClient,
      channel: fakeChannel,
      connectionName: 'test-prod',
      connectionId: '42',
      logIdentifier: 'sess-1',
      initialBuffer: initialSerialized,
      terminalEmulator: vt,
    });
    assert.ok(suspendId1);

    // 挂起期间远端继续吐出含查询序列的新数据
    fakeChannel.emit('data', Buffer.from('\x1b[>c\x1b[c\x1b]11;?\x07Suspended Line 2\r\n', 'utf8'));

    // 第三阶段：跨端工作区同步恢复（replay: 'full'）
    const resumedFull = await suspendService.resumeSession(1, suspendId1, { replay: 'full' });
    assert.ok(resumedFull);
    assert.equal(resumedFull.terminalEmulator, vt, '应原样接力同一颗 Headless VT');

    // 验证 full 模式回放内容喂给新前端终端：0 次自动回包，且包含在线 + 挂起两段内容
    const fullCheck = await feedIntoFreshTerminal(resumedFull.logData, 100, 30);
    assert.deepEqual(fullCheck.replies, []);
    assert.ok(fullCheck.lines.some((l) => l.includes('Online Line 1')));
    assert.ok(fullCheck.lines.some((l) => l.includes('Suspended Line 2')));

    // 第四阶段：再次挂起并模拟 WS 抖动就地接回（replay: 'delta'）
    const suspendId2 = await suspendService.takeOverMarkedSession({
      userId: 1,
      originalSessionId: 'sess-2',
      sshClient: fakeClient,
      channel: fakeChannel,
      connectionName: 'test-prod',
      connectionId: '42',
      logIdentifier: 'sess-2',
      initialBuffer: resumedFull.fullLogData,
      terminalEmulator: resumedFull.terminalEmulator,
    });
    assert.ok(suspendId2);

    fakeChannel.emit('data', Buffer.from('Delta Only Line 3\r\n', 'utf8'));

    const resumedDelta = await suspendService.resumeSession(1, suspendId2, { replay: 'delta' });
    assert.ok(resumedDelta);
    assert.equal(resumedDelta.terminalEmulator, vt);
    assert.equal(resumedDelta.logData.includes('Delta Only Line 3'), true);
    assert.equal(resumedDelta.logData.includes('Online Line 1'), false, 'delta 模式不应重复回放旧历史');

    // 第五阶段：再次挂起并彻底终止，验证 VT 正确 dispose 防止内存泄漏
    const suspendId3 = await suspendService.takeOverMarkedSession({
      userId: 1,
      originalSessionId: 'sess-3',
      sshClient: fakeClient,
      channel: fakeChannel,
      connectionName: 'test-prod',
      connectionId: '42',
      logIdentifier: 'sess-3',
      terminalEmulator: resumedDelta.terminalEmulator,
    });
    assert.ok(suspendId3);

    const terminated = await suspendService.terminateSuspendedSession(1, suspendId3);
    assert.equal(terminated, true);
    assert.equal(vt.isDisposed(), true, '终止挂起会话后必须释放 Headless VT');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
