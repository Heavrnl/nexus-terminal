/**
 * nexus-mux 二进制帧协议（Wire Protocol v1）TypeScript 端实现。
 * 与 Rust 端 packages/remote-agent/src/protocol.rs 逐字节保持严格一致。
 *
 * 帧结构（大端序）：
 *   [4B payload_len][1B msg_type][4B channel_id][payload_len B payload]
 */

export const PROTOCOL_VERSION = 1;
export const FRAME_HEADER_LEN = 9;
export const MAX_FRAME_PAYLOAD_LEN = 16 * 1024 * 1024;

// --- 帧类型常量 ---
export const MSG_HELLO = 0x01;
export const MSG_HELLO_ACK = 0x02;
export const MSG_OPEN_OR_ATTACH = 0x10;
export const MSG_ATTACHED = 0x11;
export const MSG_SNAPSHOT = 0x12;
export const MSG_DATA = 0x13;
export const MSG_RESIZE = 0x14;
export const MSG_DETACH = 0x15;
export const MSG_DETACHED = 0x16;
export const MSG_KILL = 0x17;
export const MSG_EXITED = 0x18;
export const MSG_LIST = 0x20;
export const MSG_LIST_RESP = 0x21;
export const MSG_STOP_DAEMON = 0x2f;
export const MSG_PING = 0x30;
export const MSG_PONG = 0x31;
export const MSG_ERROR = 0x7f;

// --- 快照分片标志位 ---
export const SNAPSHOT_FLAG_LAST_CHUNK = 0x01;
export const SNAPSHOT_FLAG_IS_DELTA = 0x02;

export interface MuxFrame {
  msgType: number;
  channelId: number;
  payload: Buffer;
}

export interface HelloPayload {
  protocolVersion: number;
  ownerNamespace: string;
  clientId: string;
  detachedIdleHours?: number;
}

export interface HelloAckPayload {
  protocolVersion: number;
  agentVersion: string;
  os: string;
  arch: string;
  persistenceWarning?: string;
}

export interface OpenOrAttachPayload {
  remoteSessionId: string;
  cols: number;
  rows: number;
  term: string;
  shell?: string;
  cwd?: string;
  replay: 'full' | 'delta';
  lastSeq?: number;
  connectionUuid?: string;
  title?: string;
  attachOnly?: boolean;
}

export interface AttachedPayload {
  remoteSessionId: string;
  created: boolean;
  exited: boolean;
  exitCode?: number | null;
  currentSeq: number;
  replayMode: 'full' | 'delta';
  cols: number;
  rows: number;
}

export interface DetachedPayload {
  reason: string;
}

export interface ExitedPayload {
  exitCode?: number | null;
  signal?: string | null;
}

export interface HostedSessionSummary {
  remoteSessionId: string;
  ownerNamespace: string;
  connectionUuid?: string;
  title: string;
  createdAt: number;
  lastActiveAt: number;
  detachedAt?: number;
  attached: boolean;
  exited: boolean;
  exitCode?: number | null;
  cols: number;
  rows: number;
}

export interface ListRespPayload {
  sessions: HostedSessionSummary[];
}

export interface ErrorPayload {
  code: string;
  message: string;
}

export function encodeFrame(msgType: number, channelId: number, payload?: Buffer): Buffer {
  const body = payload ?? Buffer.alloc(0);
  if (body.length > MAX_FRAME_PAYLOAD_LEN) {
    throw new Error(`帧负载超出上限: ${body.length} bytes`);
  }
  const out = Buffer.allocUnsafe(FRAME_HEADER_LEN + body.length);
  out.writeUInt32BE(body.length, 0);
  out.writeUInt8(msgType & 0xff, 4);
  out.writeUInt32BE(channelId >>> 0, 5);
  if (body.length > 0) {
    body.copy(out, FRAME_HEADER_LEN);
  }
  return out;
}

export function encodeJsonFrame(msgType: number, channelId: number, data: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(data), 'utf8');
  return encodeFrame(msgType, channelId, payload);
}

export function encodeResizePayload(cols: number, rows: number): Buffer {
  const safeCols = Math.max(2, Math.min(1000, Math.floor(cols || 80)));
  const safeRows = Math.max(1, Math.min(500, Math.floor(rows || 24)));
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt16BE(safeCols, 0);
  buf.writeUInt16BE(safeRows, 2);
  return buf;
}

export function decodeServerDataPayload(payload: Buffer): { seq: number; data: Buffer } {
  if (payload.length < 8) {
    throw new Error('服务端 DATA 帧长度不足 8 字节');
  }
  const seqBig = payload.readBigUInt64BE(0);
  const seq = Number(seqBig);
  return { seq, data: payload.subarray(8) };
}

export function parseJsonPayload<T>(payload: Buffer): T {
  return JSON.parse(payload.toString('utf8')) as T;
}

/**
 * 流式帧解码器：自动处理 SSH 通道任意边界拆包与粘包
 */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private totalBytes = 0;

  public push(chunk: Buffer): MuxFrame[] {
    if (!chunk || chunk.length === 0) return [];
    this.chunks.push(chunk);
    this.totalBytes += chunk.length;

    const frames: MuxFrame[] = [];
    while (this.totalBytes >= FRAME_HEADER_LEN) {
      const merged = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.totalBytes);
      const payloadLen = merged.readUInt32BE(0);
      if (payloadLen > MAX_FRAME_PAYLOAD_LEN) {
        this.chunks = [];
        this.totalBytes = 0;
        throw new Error(`收到非法超大帧: ${payloadLen} bytes`);
      }
      const frameTotalLen = FRAME_HEADER_LEN + payloadLen;
      if (merged.length < frameTotalLen) {
        // 数据未齐，保留已合并缓冲等待后续分片
        this.chunks = [merged];
        this.totalBytes = merged.length;
        break;
      }

      const msgType = merged.readUInt8(4);
      const channelId = merged.readUInt32BE(5);
      const payload = Buffer.from(merged.subarray(FRAME_HEADER_LEN, frameTotalLen));
      frames.push({ msgType, channelId, payload });

      if (merged.length === frameTotalLen) {
        this.chunks = [];
        this.totalBytes = 0;
      } else {
        const rest = merged.subarray(frameTotalLen);
        this.chunks = [rest];
        this.totalBytes = rest.length;
      }
    }
    return frames;
  }

  public reset(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}
