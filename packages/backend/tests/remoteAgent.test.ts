import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import {
  decodeServerDataPayload,
  encodeFrame,
  encodeJsonFrame,
  encodeResizePayload,
  FrameDecoder,
  MSG_ATTACHED,
  MSG_DATA,
  MSG_DETACH,
  MSG_DETACHED,
  MSG_HELLO,
  MSG_HELLO_ACK,
  MSG_KILL,
  MSG_OPEN_OR_ATTACH,
  MSG_RESIZE,
  MSG_SNAPSHOT,
  MSG_STOP_DAEMON,
  parseJsonPayload,
  PROTOCOL_VERSION,
  SNAPSHOT_FLAG_LAST_CHUNK,
} from '../src/remote-agent/protocol.ts';
import {
  buildEnableLingerCommand,
  buildMuxStdioCommand,
  buildRemoteSha256Command,
  deriveOwnerNamespace,
  inferPlatformFamilyFromSftpHome,
  needsAgentDeploy,
  parseAgentVersionOutput,
  parseUnixProbeOutput,
  parseWindowsProbeOutput,
  toSftpPath,
} from '../src/remote-agent/probe.pure.ts';

test('FrameDecoder 正确处理任意边界拆包、粘包与非法超大帧拦截', () => {
  const f1 = encodeJsonFrame(MSG_HELLO_ACK, 0, {
    protocolVersion: 1,
    agentVersion: '0.1.0',
    os: 'linux',
    arch: 'x86_64',
  });
  const seqBuf = Buffer.allocUnsafe(8);
  seqBuf.writeBigUInt64BE(12345n, 0);
  const f2 = encodeFrame(MSG_DATA, 2, Buffer.concat([seqBuf, Buffer.from('你好 nexus', 'utf8')]));
  const combined = Buffer.concat([f1, f2]);

  const decoder = new FrameDecoder();
  const received: Array<{ msgType: number; channelId: number; payload: Buffer }> = [];
  for (let i = 0; i < combined.length; i += 3) {
    received.push(...decoder.push(combined.subarray(i, Math.min(i + 3, combined.length))));
  }

  assert.equal(received.length, 2);
  assert.equal(received[0].msgType, MSG_HELLO_ACK);
  assert.equal(received[1].msgType, MSG_DATA);
  assert.equal(received[1].channelId, 2);
  const decoded = decodeServerDataPayload(received[1].payload);
  assert.equal(decoded.seq, 12345);
  assert.equal(decoded.data.toString('utf8'), '你好 nexus');

  const badHeader = Buffer.alloc(9);
  badHeader.writeUInt32BE(32 * 1024 * 1024, 0);
  badHeader.writeUInt8(MSG_DATA, 4);
  badHeader.writeUInt32BE(1, 5);
  assert.throws(() => decoder.push(badHeader), /非法超大帧/);
});

test('跨平台环境探测解析、自动加固命令、命名空间派生与 SFTP 路径归一化', () => {
  assert.equal(inferPlatformFamilyFromSftpHome('/home/alice'), 'unix');
  assert.equal(inferPlatformFamilyFromSftpHome('C:\\Users\\alice'), 'windows');
  assert.equal(inferPlatformFamilyFromSftpHome('/C:/Users/alice'), 'windows');
  assert.equal(toSftpPath('windows', 'C:\\Users\\alice\\nexus-mux.exe'), '/C:/Users/alice/nexus-mux.exe');
  assert.equal(parseAgentVersionOutput('nexus-mux 0.1.0 (protocol=1 os=linux arch=x86_64)'), '0.1.0');
  assert.equal(needsAgentDeploy(null, '0.1.0'), true);
  assert.equal(needsAgentDeploy('0.0.9', '0.1.0'), true);
  assert.equal(needsAgentDeploy('0.1.0', '0.1.0'), false);

  const ns1 = deriveOwnerNamespace('owner-uuid-1');
  const ns2 = deriveOwnerNamespace('owner-uuid-1');
  const ns3 = deriveOwnerNamespace('owner-uuid-2');
  assert.equal(ns1.length, 32);
  assert.equal(ns1, ns2);
  assert.notEqual(ns1, ns3);

  const linuxProbe = parseUnixProbeOutput(
    [
      'NX_OS=Linux',
      'NX_ARCH=aarch64',
      'NX_USER=ubuntu',
      'NX_ROOT=0',
      'NX_SUDO=1',
      'NX_HASH=sha256sum',
      'NX_DIR=/home/ubuntu/.nexus-terminal/bin',
      'NX_BIN=/home/ubuntu/.nexus-terminal/bin/nexus-mux',
      'NX_VER=nexus-mux 0.1.0 (protocol=1 os=linux arch=aarch64)',
      'NX_LINGER=1',
    ].join('\n')
  );
  assert.equal(linuxProbe.os, 'linux');
  assert.equal(linuxProbe.arch, 'aarch64');
  assert.equal(linuxProbe.installedVersion, '0.1.0');
  assert.equal(linuxProbe.needsLingerFix, true);
  assert.equal(buildEnableLingerCommand(linuxProbe), 'sudo -n loginctl enable-linger ubuntu');
  assert.match(buildRemoteSha256Command(linuxProbe, '/tmp/a.tmp') || '', /^sha256sum /);
  assert.equal(
    buildMuxStdioCommand('unix', '/home/ubuntu/.nexus-terminal/bin/nexus-mux'),
    "exec '/home/ubuntu/.nexus-terminal/bin/nexus-mux' stdio"
  );

  const winProbe = parseWindowsProbeOutput(
    [
      'NX_OS=Windows',
      'NX_ARCH=AMD64',
      'NX_USER=Administrator',
      'NX_DIR=C:\\Users\\Administrator\\AppData\\Local\\nexus-terminal\\bin',
      'NX_BIN=C:\\Users\\Administrator\\AppData\\Local\\nexus-terminal\\bin\\nexus-mux.exe',
      'NX_VER=',
    ].join('\r\n')
  );
  assert.equal(winProbe.platformFamily, 'windows');
  assert.equal(winProbe.os, 'windows');
  assert.equal(winProbe.arch, 'x86_64');
  assert.equal(winProbe.installedVersion, null);
  assert.equal(buildEnableLingerCommand(winProbe), null);
  assert.match(buildRemoteSha256Command(winProbe, 'C:\\temp\\a.tmp') || '', /Get-FileHash/);
  assert.equal(buildMuxStdioCommand('windows', 'C:\\bin\\nexus-mux.exe'), '"C:\\bin\\nexus-mux.exe" stdio');
});

test('Node.js 协议层与真实编译的 Rust nexus-mux 二进制端到端跨语言互通验证', async (t) => {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const binPath = path.resolve(import.meta.dirname, `../../remote-agent/target/release/nexus-mux${ext}`);
  if (!fs.existsSync(binPath)) {
    t.skip(`未找到已构建的本地二进制 (${binPath})，跳过真实进程互通测试`);
    return;
  }

  const tag = crypto.randomBytes(6).toString('hex');
  const socketEndpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\nexus-mux-e2e-${tag}`
      : `/tmp/nexus-mux-e2e-${tag}.sock`;

  const openBridge = () => {
    const proc = spawn(binPath, ['stdio', '--socket', socketEndpoint], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const decoder = new FrameDecoder();
    const queue: Array<{ msgType: number; channelId: number; payload: Buffer }> = [];
    const waiters: Array<() => void> = [];
    proc.stdout.on('data', (chunk: Buffer) => {
      for (const f of decoder.push(chunk)) {
        queue.push(f);
      }
      while (waiters.length > 0) waiters.shift()!();
    });
    const nextFrame = async (
      predicate: (f: { msgType: number; channelId: number; payload: Buffer }) => boolean,
      timeoutMs = 10_000
    ) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const idx = queue.findIndex(predicate);
        if (idx !== -1) {
          return queue.splice(idx, 1)[0];
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(200, Math.max(10, deadline - Date.now())));
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      throw new Error('等待 nexus-mux 帧超时');
    };
    return { proc, nextFrame };
  };

  const b1 = openBridge();
  const remoteSessionId = `nx-e2e-${tag}`;
  const ownerNamespace = deriveOwnerNamespace(`e2e-${tag}`);
  try {
    // 1. HELLO 握手
    b1.proc.stdin.write(
      encodeJsonFrame(MSG_HELLO, 0, {
        protocolVersion: PROTOCOL_VERSION,
        ownerNamespace,
        clientId: 'node-client-1',
        detachedIdleHours: 0,
      })
    );
    const ackFrame = await b1.nextFrame((f) => f.msgType === MSG_HELLO_ACK);
    const ack = parseJsonPayload<{ protocolVersion: number; agentVersion: string }>(ackFrame.payload);
    assert.equal(ack.protocolVersion, 1);

    // 2. 创建主 PTY 会话并执行命令
    b1.proc.stdin.write(
      encodeJsonFrame(MSG_OPEN_OR_ATTACH, 1, {
        remoteSessionId,
        cols: 80,
        rows: 24,
        term: 'xterm-256color',
        replay: 'full',
      })
    );
    const att1 = parseJsonPayload<{ created: boolean }>(
      (await b1.nextFrame((f) => f.channelId === 1 && f.msgType === MSG_ATTACHED)).payload
    );
    assert.equal(att1.created, true);
    await b1.nextFrame((f) => f.channelId === 1 && f.msgType === MSG_SNAPSHOT);

    // 调整尺寸并运行输出命令
    b1.proc.stdin.write(encodeFrame(MSG_RESIZE, 1, encodeResizePayload(100, 30)));
    const marker = `CROSS_LANG_OK_${tag}`;
    b1.proc.stdin.write(encodeFrame(MSG_DATA, 1, Buffer.from(`echo ${marker}\r\n`, 'utf8')));

    let accOut = '';
    while (!accOut.includes(marker)) {
      const df = await b1.nextFrame((f) => f.channelId === 1 && f.msgType === MSG_DATA, 10_000);
      accOut += decodeServerDataPayload(df.payload).data.toString('utf8');
    }

    // 3. 优雅 DETACH 并关闭第一个桥接进程（模拟 Web 端断开）
    b1.proc.stdin.write(encodeFrame(MSG_DETACH, 1));
    await b1.nextFrame((f) => f.channelId === 1 && f.msgType === MSG_DETACHED);
    b1.proc.stdin.end();

    // 4. 拉起第二个独立桥接进程接管同一 remoteSessionId（模拟桌面端接管）
    const b2 = openBridge();
    try {
      b2.proc.stdin.write(
        encodeJsonFrame(MSG_HELLO, 0, {
          protocolVersion: PROTOCOL_VERSION,
          ownerNamespace,
          clientId: 'node-desktop-2',
        })
      );
      await b2.nextFrame((f) => f.msgType === MSG_HELLO_ACK);
      b2.proc.stdin.write(
        encodeJsonFrame(MSG_OPEN_OR_ATTACH, 1, {
          remoteSessionId,
          cols: 100,
          rows: 30,
          term: 'xterm-256color',
          replay: 'full',
          attachOnly: true,
        })
      );
      const att2 = parseJsonPayload<{ created: boolean; replayMode: string }>(
        (await b2.nextFrame((f) => f.channelId === 1 && f.msgType === MSG_ATTACHED)).payload
      );
      assert.equal(att2.created, false);
      assert.equal(att2.replayMode, 'full');

      const snapChunks: Buffer[] = [];
      while (true) {
        const sf = await b2.nextFrame((f) => f.channelId === 1 && f.msgType === MSG_SNAPSHOT);
        const flags = sf.payload.readUInt8(0);
        snapChunks.push(sf.payload.subarray(1));
        if ((flags & SNAPSHOT_FLAG_LAST_CHUNK) !== 0) break;
      }
      const snapText = Buffer.concat(snapChunks).toString('utf8');
      assert.ok(snapText.includes(marker), `跨进程接管快照应包含历史输出 ${marker}`);

      // 彻底清理测试会话与测试 Daemon（等待帧落盘再结束桥接进程）
      b2.proc.stdin.write(encodeFrame(MSG_KILL, 1));
      b2.proc.stdin.write(encodeFrame(MSG_STOP_DAEMON, 0));
      b2.proc.stdin.end();
      await new Promise((r) => setTimeout(r, 250));
    } finally {
      b2.proc.kill();
    }
  } finally {
    b1.proc.kill();
  }
});

test('AgentDeployer: 发起连接在 SFTP 卡住时被主动断开，必须即时解阻且绝不毒化后续并发与重连', async () => {
  const require = createRequire(import.meta.url);
  const tsNode = require('ts-node');
  tsNode.register({
    transpileOnly: true,
    project: path.resolve(import.meta.dirname, '..', 'tsconfig.json'),
  });
  const { agentDeployerService } = require('../src/remote-agent/agent-deployer.service.ts');

  const hostCacheKey = `163.61.31.188:39346:root-test-${Date.now()}`;
  agentDeployerService.invalidateHostCache(hostCacheKey);

  // 构造一个在 sftp.realpath 永不回调的“假死” SSH 客户端（模拟高丢包线路且中途被关标签页）
  const hangingClient = new EventEmitter() as any;
  hangingClient.sftp = (cb: (err: Error | null, sftp: any) => void) => {
    const fakeSftp = new EventEmitter() as any;
    fakeSftp.realpath = () => {
      // 故意永不回调，模拟 ssh2 在底层断连时漏掉回调
    };
    fakeSftp.end = () => {};
    cb(null, fakeSftp);
  };
  hangingClient.exec = () => {};

  // 构造一个健康的第二条 SSH 客户端（已装好相同版本，直接探测就绪）
  const healthyClient = new EventEmitter() as any;
  healthyClient.sftp = (cb: (err: Error | null, sftp: any) => void) => {
    const fakeSftp = new EventEmitter() as any;
    fakeSftp.realpath = (_p: string, rcb: (err: Error | null, abs?: string) => void) => {
      rcb(null, '/root');
    };
    fakeSftp.end = () => {};
    cb(null, fakeSftp);
  };
  healthyClient.exec = (_cmd: string, cb: (err: Error | null, stream: any) => void) => {
    const stream = new EventEmitter() as any;
    stream.stderr = new EventEmitter();
    stream.close = () => {};
    cb(null, stream);
    setImmediate(() => {
      stream.emit(
        'data',
        Buffer.from(
          [
            'NX_OS=Linux',
            'NX_ARCH=x86_64',
            'NX_USER=root',
            'NX_ROOT=1',
            'NX_SUDO=0',
            'NX_HASH=sha256sum',
            'NX_GZIP=1',
            'NX_DIR=/root/.nexus-terminal/bin',
            'NX_BIN=/root/.nexus-terminal/bin/nexus-mux',
            'NX_VER=nexus-mux 0.1.0 (protocol=1 os=linux arch=x86_64)',
            'NX_LINGER=0',
          ].join('\n')
        )
      );
      stream.emit('close', 0);
    });
  };

  // 1. 连接 A 先发起并卡在 sftp.realpath，连接 B 并发进入合流
  const pA = agentDeployerService.ensureAgentReady(hangingClient, {
    hostCacheKey,
    autoDeploy: true,
  });
  const pB = agentDeployerService.ensureAgentReady(healthyClient, {
    hostCacheKey,
    autoDeploy: true,
  });

  // 2. 50ms 后模拟用户关闭连接 A 的标签页（触发 sshClient close）
  setTimeout(() => {
    hangingClient.emit('close');
  }, 50);

  const [resA, resB] = await Promise.all([pA, pB]);
  assert.equal(resA.ready, false, '已断开的连接 A 应立即失败解除阻塞');
  assert.equal(resB.ready, true, '活跃的连接 B 不应被断开的连接 A 连坐，应自动接力探测就绪');
  assert.equal(resB.binaryPath, '/root/.nexus-terminal/bin/nexus-mux');

  // 3. 再次重连应直接命中成功缓存而非残留僵尸 inflight
  const resC = await agentDeployerService.ensureAgentReady(healthyClient, {
    hostCacheKey,
    autoDeploy: true,
  });
  assert.equal(resC.ready, true);
  agentDeployerService.invalidateHostCache(hostCacheKey);
});
