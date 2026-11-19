import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createReplaySilenceController,
  writeTerminalReplay,
  type RawTerminalWriteFn,
} from '../src/utils/terminalReplaySilence.ts';

test('回放静默屏障：严格 FIFO 包裹回放解析，自动回包被拦截且结束后立即放行实时应答', () => {
  const controller = createReplaySilenceController();
  const emitted: string[] = [];

  // 模拟 xterm WriteBuffer 的严格 FIFO 解析队列
  const queue: Array<{ data: string | Uint8Array; cb?: () => void }> = [];
  const rawWrite: RawTerminalWriteFn = (data, cb) => {
    queue.push({ data, cb });
  };
  const fireOnData = (payload: string, isUserInput = false) => {
    if (isUserInput) controller.markUserInput();
    if (!controller.shouldSuppressOnData()) {
      emitted.push(payload);
    }
  };
  const drainQueue = () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      const text = typeof item.data === 'string' ? item.data : '';
      // 模拟解析到查询序列时 xterm.js 同步 fire onData (wasUserInput = false)
      if (text.includes('\x1b[>c')) fireOnData('\x1b[>0;276;0c', false);
      if (text.includes('\x1b]11;?')) fireOnData('\x1b]11;rgb:0000/0000/0000\x1b\\', false);
      item.cb?.();
    }
  };

  // 1. 回放前的实时数据：应正常回复
  rawWrite('live-before \x1b[>c');
  // 2. 历史回放块（包含多条查询序列）：应完全拦截
  let replayCallbackFired = false;
  controller.writeWithSilence(rawWrite, 'history \x1b[>c \x1b]11;?\x07', () => {
    replayCallbackFired = true;
  });
  // 3. 回放紧随其后的实时数据：应立刻恢复正常回复
  rawWrite('live-after \x1b]11;?\x07');

  drainQueue();

  assert.equal(replayCallbackFired, true);
  assert.equal(controller.isSilencing(), false);
  assert.deepEqual(emitted, [
    '\x1b[>0;276;0c', // live-before 放行
    '\x1b]11;rgb:0000/0000/0000\x1b\\', // live-after 放行
  ]);
});

test('回放静默屏障：回放窗口内真实用户按键 100% 放行，不误杀键盘输入', () => {
  const controller = createReplaySilenceController();
  const emitted: string[] = [];

  const sendData = (data: string, user: boolean) => {
    if (user) controller.markUserInput();
    if (!controller.shouldSuppressOnData()) {
      emitted.push(data);
    }
  };

  controller.beginReplay();
  controller.beginReplay(); // 嵌套两层

  sendData('\x1b[>0;276;0c', false); // parser 自动回包 -> 拦截
  sendData('ls\r', true); // 用户真实敲键 -> 放行
  sendData('\x1b[?1;2c', false); // 紧随其后的 parser 自动回包 -> 继续拦截

  controller.endReplay();
  assert.equal(controller.isSilencing(), true, '退出一层嵌套后仍处于静默中');
  sendData('\x1b]11;rgb:0000/0000/0000\x1b\\', false); // 继续拦截

  controller.endReplay();
  assert.equal(controller.isSilencing(), false);
  sendData('\x1b[?1;2c', false); // 静默结束后实时应答恢复放行

  assert.deepEqual(emitted, ['ls\r', '\x1b[?1;2c']);
});

test('writeTerminalReplay：优先走 writeReplay，未挂载时安全退回 write', () => {
  const calls: string[] = [];

  writeTerminalReplay(
    {
      write: (d) => calls.push(`write:${d}`),
      writeReplay: (d, cb) => {
        calls.push(`replay:${d}`);
        cb?.();
      },
    },
    'chunk-1',
    () => calls.push('done-1')
  );

  writeTerminalReplay(
    {
      write: (d, cb) => {
        calls.push(`write:${d}`);
        cb?.();
      },
    },
    'chunk-2',
    () => calls.push('done-2')
  );

  assert.deepEqual(calls, ['replay:chunk-1', 'done-1', 'write:chunk-2', 'done-2']);
});
