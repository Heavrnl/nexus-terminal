/**
 * SSH 终端输出微批合帧器（Output Coalescer）。
 *
 * 设计原则：
 *   1. **首包零延迟**：通道空闲时到达的第一块字节（如用户敲击键盘的回显）立即同步发送，
 *      保证交互响应 0ms 额外延迟；
 *   2. **高频刷屏合帧**：若紧随其后在短窗口（默认 6ms）内连续涌入大量碎包（编译日志 / cat / agy 刷新），
 *      则暂存进 Buffer 队列，待窗口结束或累计达到高水位（默认 32KB）时一次性 `Buffer.concat` 合帧发送，
 *      将 WebSocket 帧数、base64/JSON 序列化与前端 onMessage 触发次数降低 10~30 倍；
 *   3. **生命周期安全**：会话关闭、断连或移交挂起前调用 `flush()` / `dispose()`，绝不丢尾包、不残留定时器。
 */

export interface OutputCoalescerOptions {
  /** 合并窗口毫秒数，默认 6ms */
  windowMs?: number;
  /** 单帧最大聚合字节数，超过立即 flush，默认 32KB */
  maxBatchBytes?: number;
  /** 合并后的单帧回调 */
  onFlush: (merged: Buffer) => void;
}

const DEFAULT_WINDOW_MS = 6;
const DEFAULT_MAX_BATCH_BYTES = 32 * 1024;

export class OutputCoalescer {
  private readonly windowMs: number;
  private readonly maxBatchBytes: number;
  private readonly onFlush: (merged: Buffer) => void;
  private chunks: Buffer[] = [];
  private queuedBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushAt = 0;
  private disposed = false;

  constructor(options: OutputCoalescerOptions) {
    this.windowMs = Math.max(1, options.windowMs ?? DEFAULT_WINDOW_MS);
    this.maxBatchBytes = Math.max(1024, options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES);
    this.onFlush = options.onFlush;
  }

  /** 推送一块远端输出原始字节 */
  public push(chunk: Buffer): void {
    if (this.disposed || !chunk || chunk.length === 0) return;

    const now = Date.now();
    // 通道空闲且距离上次发帧已超过合并窗口：首包立即同步发出（保证敲键回显 0ms 延迟）
    if (this.chunks.length === 0 && !this.timer && now - this.lastFlushAt >= this.windowMs) {
      this.lastFlushAt = now;
      this.onFlush(chunk);
      return;
    }

    this.chunks.push(chunk);
    this.queuedBytes += chunk.length;

    if (this.queuedBytes >= this.maxBatchBytes) {
      this.flush();
      return;
    }

    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.windowMs);
      this.timer.unref?.();
    }
  }

  /** 立即冲刷队列中所有待发字节 */
  public flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.chunks.length === 0) return;
    const merged = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.queuedBytes);
    this.chunks = [];
    this.queuedBytes = 0;
    this.lastFlushAt = Date.now();
    this.onFlush(merged);
  }

  /** 冲刷并释放资源（可选丢弃未发字节） */
  public dispose(dropPending = false): void {
    if (this.disposed) return;
    if (dropPending) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.chunks = [];
      this.queuedBytes = 0;
    } else {
      this.flush();
    }
    this.disposed = true;
  }
}
