import { Client, ClientChannel } from 'ssh2';
import { EventEmitter } from 'events';
import {
  AttachedPayload,
  decodeServerDataPayload,
  DetachedPayload,
  encodeFrame,
  encodeJsonFrame,
  encodeResizePayload,
  ErrorPayload,
  ExitedPayload,
  FrameDecoder,
  HelloAckPayload,
  HelloPayload,
  HostedSessionSummary,
  ListRespPayload,
  MSG_ATTACHED,
  MSG_DATA,
  MSG_DETACH,
  MSG_DETACHED,
  MSG_ERROR,
  MSG_EXITED,
  MSG_HELLO,
  MSG_HELLO_ACK,
  MSG_KILL,
  MSG_LIST,
  MSG_LIST_RESP,
  MSG_OPEN_OR_ATTACH,
  MSG_PING,
  MSG_PONG,
  MSG_RESIZE,
  MSG_SNAPSHOT,
  MuxFrame,
  OpenOrAttachPayload,
  parseJsonPayload,
  PROTOCOL_VERSION,
  SNAPSHOT_FLAG_IS_DELTA,
  SNAPSHOT_FLAG_LAST_CHUNK,
} from './protocol';
import { buildMuxStdioCommand } from './probe.pure';

export interface MuxChannelEvents {
  snapshotChunk: (chunk: Buffer, info: { isLast: boolean; isDelta: boolean }) => void;
  data: (raw: Buffer, seq: number) => void;
  detached: (reason: string) => void;
  exited: (info: ExitedPayload) => void;
  error: (err: Error) => void;
  close: () => void;
}

export interface MuxChannelHandle extends EventEmitter {
  readonly channelId: number;
  readonly remoteSessionId: string;
  readonly created: boolean;
  readonly exited: boolean;
  readonly exitCode: number | null | undefined;
  readonly replayMode: 'full' | 'delta';
  readonly currentSeq: number;
  lastSeq: number;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  detach(): void;
  kill(): void;
}

interface PendingAttach {
  resolve: (handle: MuxChannelHandle) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  remoteSessionId: string;
}

class MuxChannelHandleImpl extends EventEmitter implements MuxChannelHandle {
  public readonly channelId: number;
  public readonly remoteSessionId: string;
  public readonly created: boolean;
  public readonly exited: boolean;
  public readonly exitCode: number | null | undefined;
  public readonly replayMode: 'full' | 'delta';
  public readonly currentSeq: number;
  public lastSeq: number;
  private readonly transport: MuxTransport;
  private closed = false;

  constructor(transport: MuxTransport, channelId: number, attached: AttachedPayload) {
    super();
    this.transport = transport;
    this.channelId = channelId;
    this.remoteSessionId = attached.remoteSessionId;
    this.created = attached.created;
    this.exited = attached.exited;
    this.exitCode = attached.exitCode;
    this.replayMode = attached.replayMode;
    this.currentSeq = attached.currentSeq;
    this.lastSeq = attached.currentSeq;
  }

  public write(data: string | Buffer): void {
    if (this.closed) return;
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    this.transport.sendRawFrame(encodeFrame(MSG_DATA, this.channelId, buf));
  }

  public resize(cols: number, rows: number): void {
    if (this.closed) return;
    this.transport.sendRawFrame(encodeFrame(MSG_RESIZE, this.channelId, encodeResizePayload(cols, rows)));
  }

  public detach(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.sendRawFrame(encodeFrame(MSG_DETACH, this.channelId));
    this.transport.removeChannel(this.channelId);
  }

  public kill(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.sendRawFrame(encodeFrame(MSG_KILL, this.channelId));
    this.transport.removeChannel(this.channelId);
  }

  /** @internal */
  public markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

export interface ConnectMuxOptions {
  platformFamily: 'unix' | 'windows';
  binaryPath: string;
  ownerNamespace: string;
  clientId: string;
  detachedIdleHours?: number;
  handshakeTimeoutMs?: number;
}

/**
 * 基于单条 SSH exec stdio 通道的 nexus-mux 二进制帧多路复用传输客户端。
 * 同一台主机的所有分屏终端共享这一条 SSH exec 通道，不额外占用 sshd MaxSessions。
 */
export class MuxTransport extends EventEmitter {
  private readonly stream: ClientChannel;
  private readonly decoder = new FrameDecoder();
  private readonly channels = new Map<number, MuxChannelHandleImpl>();
  private readonly pendingAttaches = new Map<number, PendingAttach>();
  private pendingHello: { resolve: (ack: HelloAckPayload) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private pendingList: { resolve: (list: HostedSessionSummary[]) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private nextChannelId = 1;
  private pingInterval: NodeJS.Timeout | null = null;
  private closed = false;
  public helloAck: HelloAckPayload | null = null;

  private constructor(stream: ClientChannel) {
    super();
    this.stream = stream;

    stream.on('data', (chunk: Buffer) => {
      try {
        const frames = this.decoder.push(chunk);
        for (const frame of frames) {
          this.handleFrame(frame);
        }
      } catch (err: any) {
        console.error('[MuxTransport] 解码二进制帧失败，关闭传输通道:', err?.message || err);
        this.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    });

    stream.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        console.warn(`[MuxTransport stderr] ${text}`);
      }
    });

    stream.on('close', () => {
      this.handleStreamClosed(new Error('nexus-mux SSH exec 通道已关闭'));
    });

    stream.on('error', (err: Error) => {
      this.handleStreamClosed(err);
    });
  }

  /** 通过已建立的 SSH Client 打开 `nexus-mux stdio` 通道并完成 HELLO 握手 */
  public static async connect(sshClient: Client, opts: ConnectMuxOptions): Promise<MuxTransport> {
    const cmd = buildMuxStdioCommand(opts.platformFamily, opts.binaryPath);
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      sshClient.exec(cmd, (err, ch) => {
        if (err) return reject(err);
        resolve(ch);
      });
    });

    const transport = new MuxTransport(stream);
    try {
      const ack = await transport.sendHello(
        {
          protocolVersion: PROTOCOL_VERSION,
          ownerNamespace: opts.ownerNamespace,
          clientId: opts.clientId,
          detachedIdleHours: opts.detachedIdleHours,
        },
        opts.handshakeTimeoutMs ?? 8000
      );
      transport.helloAck = ack;
      transport.startHeartbeat();
      return transport;
    } catch (err) {
      transport.destroy(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  /** 仅用于单元测试：基于任意双工流构造传输层（不依赖 ssh2） */
  public static fromRawStreamForTest(stream: any): MuxTransport {
    return new MuxTransport(stream as ClientChannel);
  }

  public isClosed(): boolean {
    return this.closed;
  }

  public sendRawFrame(buf: Buffer): void {
    if (this.closed) return;
    try {
      this.stream.write(buf);
    } catch (err: any) {
      console.warn('[MuxTransport] 写入帧失败:', err?.message || err);
    }
  }

  /** @internal */
  public removeChannel(channelId: number): void {
    this.channels.delete(channelId);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingInterval = setInterval(() => {
      if (this.closed) return;
      const ts = Buffer.allocUnsafe(8);
      ts.writeBigUInt64BE(BigInt(Date.now()), 0);
      this.sendRawFrame(encodeFrame(MSG_PING, 0, ts));
    }, 20_000);
    this.pingInterval.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  public sendHello(payload: HelloPayload, timeoutMs = 8000): Promise<HelloAckPayload> {
    return new Promise<HelloAckPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingHello = null;
        reject(new Error('nexus-mux HELLO 握手超时'));
      }, timeoutMs);
      timer.unref?.();
      this.pendingHello = { resolve, reject, timer };
      this.sendRawFrame(encodeJsonFrame(MSG_HELLO, 0, payload));
    });
  }

  /** 创建或接管目标机上的一个 PTY 会话（支持多终端分屏并发复用） */
  public openOrAttach(
    req: OpenOrAttachPayload,
    hooks?: {
      /** 收到 MSG_ATTACHED 后、早于同批次后续 MSG_SNAPSHOT/MSG_DATA 的同步回调，避免微任务竞态 */
      onAttached?: (handle: MuxChannelHandle) => void;
      onSnapshotChunk?: (chunk: Buffer, info: { isLast: boolean; isDelta: boolean }) => void;
      onData?: (raw: Buffer, seq: number) => void;
      onDetached?: (reason: string) => void;
      onExited?: (info: ExitedPayload) => void;
      onError?: (err: Error) => void;
      onClose?: () => void;
    },
    timeoutMs = 10_000
  ): Promise<MuxChannelHandle> {
    if (this.closed) {
      return Promise.reject(new Error('MuxTransport 已关闭'));
    }
    const channelId = this.nextChannelId++;
    return new Promise<MuxChannelHandle>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAttaches.delete(channelId);
        reject(new Error(`OPEN_OR_ATTACH 超时 (remoteSessionId=${req.remoteSessionId})`));
      }, timeoutMs);
      timer.unref?.();

      this.pendingAttaches.set(channelId, {
        remoteSessionId: req.remoteSessionId,
        timer,
        resolve: (handle) => {
          hooks?.onAttached?.(handle);
          if (hooks?.onSnapshotChunk) handle.on('snapshotChunk', hooks.onSnapshotChunk);
          if (hooks?.onData) handle.on('data', hooks.onData);
          if (hooks?.onDetached) handle.on('detached', hooks.onDetached);
          if (hooks?.onExited) handle.on('exited', hooks.onExited);
          if (hooks?.onError) handle.on('error', hooks.onError);
          if (hooks?.onClose) handle.on('close', hooks.onClose);
          resolve(handle);
        },
        reject,
      });

      this.sendRawFrame(encodeJsonFrame(MSG_OPEN_OR_ATTACH, channelId, req));
    });
  }

  /** 查询目标机当前托管会话列表 */
  public listSessions(includeAllNamespaces = false, timeoutMs = 8000): Promise<HostedSessionSummary[]> {
    if (this.closed) {
      return Promise.reject(new Error('MuxTransport 已关闭'));
    }
    return new Promise<HostedSessionSummary[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingList = null;
        reject(new Error('查询目标机托管会话列表超时'));
      }, timeoutMs);
      timer.unref?.();
      this.pendingList = { resolve, reject, timer };
      this.sendRawFrame(encodeJsonFrame(MSG_LIST, 0, { includeAllNamespaces }));
    });
  }

  /** 通过控制通道直接终止目标机上指定 ID 的脱离会话 */
  public killRemoteSession(remoteSessionId: string, forceAnyNamespace = false): void {
    if (this.closed || !remoteSessionId) return;
    this.sendRawFrame(encodeJsonFrame(MSG_KILL, 0, { remoteSessionId, forceAnyNamespace }));
  }

  /** 优雅脱离本传输通道上的所有活跃 PTY（不杀死目标机进程），然后关闭 SSH exec 流 */
  public detachAllAndClose(): void {
    if (this.closed) return;
    for (const [chId, handle] of Array.from(this.channels.entries())) {
      try {
        this.sendRawFrame(encodeFrame(MSG_DETACH, chId));
        handle.markClosed();
      } catch {}
    }
    this.channels.clear();
    this.destroy();
  }

  public destroy(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    try {
      this.stream.end?.();
      this.stream.destroy?.();
    } catch {}
    this.rejectAllPending(err || new Error('MuxTransport 已断开'));
    for (const handle of this.channels.values()) {
      handle.markClosed();
    }
    this.channels.clear();
    this.emit('close', err);
  }

  private handleStreamClosed(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    this.rejectAllPending(err);
    for (const handle of this.channels.values()) {
      handle.markClosed();
    }
    this.channels.clear();
    this.emit('close', err);
  }

  private rejectAllPending(err: Error): void {
    if (this.pendingHello) {
      clearTimeout(this.pendingHello.timer);
      this.pendingHello.reject(err);
      this.pendingHello = null;
    }
    if (this.pendingList) {
      clearTimeout(this.pendingList.timer);
      this.pendingList.reject(err);
      this.pendingList = null;
    }
    for (const pending of this.pendingAttaches.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingAttaches.clear();
  }

  private handleFrame(frame: MuxFrame): void {
    switch (frame.msgType) {
      case MSG_HELLO_ACK: {
        if (this.pendingHello) {
          clearTimeout(this.pendingHello.timer);
          const pending = this.pendingHello;
          this.pendingHello = null;
          try {
            pending.resolve(parseJsonPayload<HelloAckPayload>(frame.payload));
          } catch (e: any) {
            pending.reject(new Error(`解析 HELLO_ACK 失败: ${e?.message || e}`));
          }
        }
        break;
      }

      case MSG_ATTACHED: {
        const pending = this.pendingAttaches.get(frame.channelId);
        if (pending) {
          this.pendingAttaches.delete(frame.channelId);
          clearTimeout(pending.timer);
          try {
            const attached = parseJsonPayload<AttachedPayload>(frame.payload);
            const handle = new MuxChannelHandleImpl(this, frame.channelId, attached);
            this.channels.set(frame.channelId, handle);
            pending.resolve(handle);
          } catch (e: any) {
            pending.reject(new Error(`解析 ATTACHED 失败: ${e?.message || e}`));
          }
        }
        break;
      }

      case MSG_SNAPSHOT: {
        const handle = this.channels.get(frame.channelId);
        if (handle && frame.payload.length >= 1) {
          const flags = frame.payload.readUInt8(0);
          const isLast = (flags & SNAPSHOT_FLAG_LAST_CHUNK) !== 0;
          const isDelta = (flags & SNAPSHOT_FLAG_IS_DELTA) !== 0;
          const chunk = frame.payload.subarray(1);
          handle.emit('snapshotChunk', chunk, { isLast, isDelta });
        }
        break;
      }

      case MSG_DATA: {
        const handle = this.channels.get(frame.channelId);
        if (handle) {
          const { seq, data } = decodeServerDataPayload(frame.payload);
          handle.lastSeq = seq;
          handle.emit('data', data, seq);
        }
        break;
      }

      case MSG_DETACHED: {
        const handle = this.channels.get(frame.channelId);
        if (handle) {
          this.channels.delete(frame.channelId);
          let reason = 'detached';
          try {
            reason = parseJsonPayload<DetachedPayload>(frame.payload).reason || reason;
          } catch {}
          handle.emit('detached', reason);
          handle.markClosed();
        }
        break;
      }

      case MSG_EXITED: {
        const handle = this.channels.get(frame.channelId);
        if (handle) {
          let info: ExitedPayload = {};
          try {
            info = parseJsonPayload<ExitedPayload>(frame.payload);
          } catch {}
          handle.emit('exited', info);
        }
        break;
      }

      case MSG_LIST_RESP: {
        if (this.pendingList) {
          clearTimeout(this.pendingList.timer);
          const pending = this.pendingList;
          this.pendingList = null;
          try {
            const resp = parseJsonPayload<ListRespPayload>(frame.payload);
            pending.resolve(Array.isArray(resp.sessions) ? resp.sessions : []);
          } catch (e: any) {
            pending.reject(new Error(`解析 LIST_RESP 失败: ${e?.message || e}`));
          }
        }
        break;
      }

      case MSG_PING: {
        this.sendRawFrame(encodeFrame(MSG_PONG, frame.channelId, frame.payload));
        break;
      }

      case MSG_PONG:
        break;

      case MSG_ERROR: {
        let errPayload: ErrorPayload = { code: 'AGENT_ERROR', message: '未知代理错误' };
        try {
          errPayload = parseJsonPayload<ErrorPayload>(frame.payload);
        } catch {}
        const err = new Error(`[${errPayload.code}] ${errPayload.message}`);
        const pending = this.pendingAttaches.get(frame.channelId);
        if (pending) {
          this.pendingAttaches.delete(frame.channelId);
          clearTimeout(pending.timer);
          pending.reject(err);
          break;
        }
        const handle = this.channels.get(frame.channelId);
        if (handle) {
          handle.emit('error', err);
        } else {
          this.emit('error', err);
        }
        break;
      }

      default:
        break;
    }
  }
}
