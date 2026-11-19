import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OutputCoalescer } from '../src/websocket/output-coalescer.ts';
import {
  parseStaticHostInfoOutput,
  parseDynamicStatusSections,
  parseProcLoadavg,
  parseRootDiskUsage,
  parseProcNetDevText,
} from '../src/services/status-monitor-parser.ts';

test('OutputCoalescer：空闲首包 0ms 立即同步发出，窗口内碎包自动合并为一帧', async () => {
  const frames: Buffer[] = [];
  const coalescer = new OutputCoalescer({
    windowMs: 15,
    maxBatchBytes: 32 * 1024,
    onFlush: (buf) => frames.push(buf),
  });

  // 首包：通道空闲，立即同步发出（0ms 延迟）
  coalescer.push(Buffer.from('A'));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].toString('utf8'), 'A');

  // 紧接着同一窗口内涌入 50 个碎包：应当合并
  for (let i = 0; i < 50; i++) {
    coalescer.push(Buffer.from(`[${i}]`));
  }
  assert.equal(frames.length, 1, '窗口未到期前碎包应先聚合，不逐包发帧');

  await new Promise((r) => setTimeout(r, 35));
  assert.equal(frames.length, 2, '窗口到期后 50 个碎包应合并为 1 帧');
  const expectedMerged = Array.from({ length: 50 }, (_, i) => `[${i}]`).join('');
  assert.equal(frames[1].toString('utf8'), expectedMerged);

  coalescer.dispose();
});

test('OutputCoalescer：超出 maxBatchBytes 高水位立即冲刷，dispose(false) 不丢尾包', () => {
  const frames: Buffer[] = [];
  const coalescer = new OutputCoalescer({
    windowMs: 100,
    maxBatchBytes: 1024,
    onFlush: (buf) => frames.push(buf),
  });

  coalescer.push(Buffer.from('first'));
  assert.equal(frames.length, 1);

  // 触发高水位立即冲刷
  coalescer.push(Buffer.alloc(600, 65));
  coalescer.push(Buffer.alloc(600, 66));
  assert.equal(frames.length, 2);
  assert.equal(frames[1].length, 1200);

  // 写入尾包后立刻 dispose(false)，应同步冲刷绝不丢失
  coalescer.push(Buffer.from('tail'));
  coalescer.dispose(false);
  assert.equal(frames.length, 3);
  assert.equal(frames[2].toString('utf8'), 'tail');
});

test('status-monitor-parser：单次静态复合输出精准解析 OS、CPU 型号与默认网卡', () => {
  const raw = [
    '__NX_OS__',
    'NAME="Ubuntu"',
    'PRETTY_NAME="Ubuntu 24.04.1 LTS"',
    '__NX_CPU__',
    'model name\t: AMD EPYC 7763 64-Core Processor',
    '__NX_IFACE__',
    '1.1.1.1 via 10.0.0.1 dev eth0 src 10.0.0.5 uid 0',
  ].join('\n');

  const info = parseStaticHostInfoOutput(raw);
  assert.deepEqual(info, {
    osName: 'Ubuntu 24.04.1 LTS',
    cpuModel: 'AMD EPYC 7763 64-Core Processor',
    defaultInterface: 'eth0',
  });
});

test('status-monitor-parser：单次动态复合输出精准切分并解析负载、磁盘与网卡流量', () => {
  const raw = [
    '__NX_MEM__',
    'MemTotal:       16384000 kB',
    'MemAvailable:    8192000 kB',
    '__NX_STAT__',
    'cpu  1000 10 500 8490 20 0 5 0 0 0',
    '__NX_LOAD__',
    '0.42 0.35 0.28 1/245 12345',
    '__NX_NET__',
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo: 12345 10 0 0 0 0 0 0 12345 10 0 0 0 0 0 0',
    '  eth0: 987654321 1000 0 0 0 0 0 0 123456789 900 0 0 0 0 0 0',
    '__NX_DF__',
    'Filesystem     1024-blocks      Used Available Capacity Mounted on',
    '/dev/vda1         41284928  16513972  22673804      43% /',
  ].join('\n');

  const sections = parseDynamicStatusSections(raw);
  assert.ok(sections.meminfo.includes('MemTotal'));
  assert.ok(sections.stat.startsWith('cpu '));
  assert.deepEqual(parseProcLoadavg(sections.loadavg), [0.42, 0.35, 0.28]);
  assert.deepEqual(parseRootDiskUsage(sections.df), {
    diskTotal: 41284928,
    diskUsed: 16513972,
    diskPercent: 43,
  });
  const net = parseProcNetDevText(sections.netdev);
  assert.deepEqual(net?.eth0, { rx_bytes: 987654321, tx_bytes: 123456789 });
});
