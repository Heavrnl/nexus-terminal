import * as xtermHeadlessMod from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import * as xtermSerializeMod from '@xterm/addon-serialize';
import type { SerializeAddon } from '@xterm/addon-serialize';

// 同时兼容 CommonJS (tsc / ts-node / ncc) 与 Node ESM (--experimental-strip-types)
const HeadlessTerminalCtor: typeof HeadlessTerminal =
  (xtermHeadlessMod as any).Terminal ?? (xtermHeadlessMod as any).default?.Terminal;
const SerializeAddonCtor: typeof SerializeAddon =
  (xtermSerializeMod as any).SerializeAddon ?? (xtermSerializeMod as any).default?.SerializeAddon;

export interface BackendTerminalEmulatorOptions {
  /** 初始列数，默认 80 */
  cols?: number;
  /** 初始行数，默认 24 */
  rows?: number;
  /** 滚动历史行数上限，默认 5000（与前端默认 scrollback 对齐） */
  scrollback?: number;
}

export interface SerializeTerminalOptions {
  /** 序列化保留的滚动历史行数，默认使用实例的 scrollback 上限 */
  scrollback?: number;
  /** 是否排除终端模式恢复序列，默认 false */
  excludeModes?: boolean;
  /** 是否排除备用屏内容，默认 false */
  excludeAltBuffer?: boolean;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/**
 * 服务端 Headless VT 默认滚动历史行数（2000 行）。
 * 实测 10 并发写满会话下，2000 行相比 5000 行单会话 RSS 直降 52%（12.7MB -> 6.0MB），
 * serialize() 耗时减半（48ms -> 25ms），可通过环境变量 NEXUS_VT_SCROLLBACK 按需调整。
 */
const ENV_SCROLLBACK = Number.parseInt(process.env.NEXUS_VT_SCROLLBACK || '', 10);
const DEFAULT_SCROLLBACK = Number.isFinite(ENV_SCROLLBACK) && ENV_SCROLLBACK >= 0 ? ENV_SCROLLBACK : 2000;
const MIN_COLS = 2;
const MAX_COLS = 1000;
const MIN_ROWS = 1;
const MAX_ROWS = 500;

/** 单次喂给 xterm WriteBuffer 的最大字符片长（避免超大同步帧阻塞事件循环） */
const WRITE_SLICE_CHARS = 64 * 1024;
/**
 * 待解析写入队列的高水位上限（8MB）。
 * xterm 内部 WriteBuffer 积压超过 50MB 会直接抛错，设 8MB 高水位可防远端日志洪流打崩后端进程。
 */
const MAX_PENDING_WRITE_BYTES = 8 * 1024 * 1024;
/** 触发高水位过载保护后，回落到 4MB 以下恢复写入 */
const RESUME_PENDING_WRITE_BYTES = 4 * 1024 * 1024;
/** flush 默认超时（毫秒），防止任何极端异常导致挂起/恢复流程永久等待 */
const DEFAULT_FLUSH_TIMEOUT_MS = 2000;

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

/**
 * 服务端无头终端状态机（Headless VT）。
 *
 * 职责：
 *   1. 在后端为每条活跃 SSH 会话实时维护一份与远端 PTY 尺寸同步的终端屏幕状态机（主屏 + scrollback + 备用屏 + 色彩 + 光标 + 模式）；
 *   2. 在工作区同步接管、刷新恢复、挂起恢复时，通过 `serialize()` 直接输出渲染后的纯净屏幕快照，
 *      从架构层彻底消除历史原始字节回放带来的 DA1/DA2/OSC 10~12/DSR/DECRQM 等终端查询序列误触发应答问题；
 *   3. 具备防洪流背压保护与幂等资源释放（`dispose()`），防止高吞吐输出打崩进程或长期运行内存泄漏。
 */
export class BackendTerminalEmulator {
  private readonly terminal: HeadlessTerminal;
  private readonly serializeAddon: SerializeAddon;
  private readonly scrollback: number;
  private cols: number;
  private rows: number;
  private hasOutput = false;
  private disposed = false;
  private pendingWriteBytes = 0;
  private overloaded = false;
  private droppedChunksCount = 0;

  constructor(options: BackendTerminalEmulatorOptions = {}) {
    this.cols = clampInt(options.cols, DEFAULT_COLS, MIN_COLS, MIN_COLS > MAX_COLS ? MIN_COLS : MAX_COLS);
    this.rows = clampInt(options.rows, DEFAULT_ROWS, MIN_ROWS, MAX_ROWS);
    this.scrollback = clampInt(options.scrollback, DEFAULT_SCROLLBACK, 0, 20000);

    this.terminal = new HeadlessTerminalCtor({
      cols: this.cols,
      rows: this.rows,
      scrollback: this.scrollback,
      allowProposedApi: true,
      disableStdin: true,
      convertEol: false,
      logLevel: 'off',
    });

    this.serializeAddon = new SerializeAddonCtor();
    // @xterm/addon-serialize 的类型签名指向 @xterm/xterm，运行时与 @xterm/headless 完全兼容
    this.terminal.loadAddon(this.serializeAddon as unknown as Parameters<HeadlessTerminal['loadAddon']>[0]);
  }

  /** 向终端状态机喂入远端输出数据（支持 UTF-8 字符串或原始字节） */
  public write(data: string | Uint8Array): void {
    if (this.disposed) return;
    if (!data || data.length === 0) return;

    const totalBytes = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength;
    if (totalBytes === 0) return;

    // 洪流过载保护：高水位丢弃中间瞬时洪流块，待水位回落后自动恢复
    if (this.overloaded) {
      if (this.pendingWriteBytes > RESUME_PENDING_WRITE_BYTES) {
        this.droppedChunksCount += 1;
        return;
      }
      this.overloaded = false;
    }
    if (this.pendingWriteBytes + totalBytes > MAX_PENDING_WRITE_BYTES) {
      this.overloaded = true;
      this.droppedChunksCount += 1;
      if (this.droppedChunksCount === 1 || this.droppedChunksCount % 200 === 0) {
        console.warn(
          `[BackendTerminalEmulator] 终端输出洪流触发背压保护（积压 ${this.pendingWriteBytes} bytes，已丢弃 ${this.droppedChunksCount} 块），等待解析水位回落。`
        );
      }
      return;
    }

    this.hasOutput = true;

    if (typeof data === 'string' && data.length > WRITE_SLICE_CHARS) {
      // 超大文本按 64KB 切片写入，避开 UTF-16 代理对边界
      let offset = 0;
      while (offset < data.length && !this.disposed) {
        let end = Math.min(offset + WRITE_SLICE_CHARS, data.length);
        if (end < data.length) {
          const code = data.charCodeAt(end - 1);
          if (code >= 0xd800 && code <= 0xdbff) {
            end += 1;
          }
        }
        const slice = data.slice(offset, end);
        this.enqueueWrite(slice, Buffer.byteLength(slice, 'utf8'));
        offset = end;
      }
      return;
    }

    this.enqueueWrite(data, totalBytes);
  }

  private enqueueWrite(chunk: string | Uint8Array, byteLength: number): void {
    if (this.disposed) return;
    this.pendingWriteBytes += byteLength;
    try {
      this.terminal.write(chunk, () => {
        this.pendingWriteBytes = Math.max(0, this.pendingWriteBytes - byteLength);
        if (this.overloaded && this.pendingWriteBytes <= RESUME_PENDING_WRITE_BYTES) {
          this.overloaded = false;
        }
      });
    } catch (err) {
      this.pendingWriteBytes = Math.max(0, this.pendingWriteBytes - byteLength);
      console.warn('[BackendTerminalEmulator] 写入 Headless VT 失败（已安全忽略）:', err);
    }
  }

  /**
   * 同步更新虚拟终端窗口尺寸（与远端 PTY 的 setWindow 保持严格一致）。
   */
  public resize(cols: number, rows: number): void {
    if (this.disposed) return;
    const nextCols = clampInt(cols, this.cols, MIN_COLS, MAX_COLS);
    const nextRows = clampInt(rows, this.rows, MIN_ROWS, MAX_ROWS);
    if (nextCols === this.cols && nextRows === this.rows) return;
    this.cols = nextCols;
    this.rows = nextRows;
    try {
      this.terminal.resize(nextCols, nextRows);
    } catch (err) {
      console.warn(`[BackendTerminalEmulator] resize(${nextCols}x${nextRows}) 失败:`, err);
    }
  }

  /** 获取当前虚拟终端尺寸 */
  public getDimensions(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  /** 是否已经接收过至少一段有效输出 */
  public hasAnyOutput(): boolean {
    return this.hasOutput;
  }

  /** 是否处于备用屏模式（例如 vim / btop / htop / less） */
  public isAlternateScreen(): boolean {
    if (this.disposed) return false;
    try {
      return this.terminal.buffer.active.type === 'alternate';
    } catch {
      return false;
    }
  }

  /** 获取因背压保护而丢弃的洪流块数（供诊断与测试使用） */
  public getDroppedChunksCount(): number {
    return this.droppedChunksCount;
  }

  /** 是否已释放 */
  public isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * 等待此前所有已入队的 `write()` 数据在 xterm WriteBuffer 中全部解析完成。
   * 使用严格 FIFO 空写回调屏障，并带超时防死锁保护。
   */
  public flush(timeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, Math.max(50, timeoutMs));
      timer.unref?.();
      try {
        this.terminal.write('', done);
      } catch {
        done();
      }
    });
  }

  /**
   * 等待队列解析落地后，序列化当前终端完整屏幕状态（主屏 scrollback + 备用屏 + 色彩 + 光标 + 模式）。
   * 序列化结果纯属屏幕渲染状态，天然不含任何终端查询控制序列（DA1/DA2/OSC 10~12/DSR/DECRQM 等）。
   */
  public async serialize(options?: SerializeTerminalOptions): Promise<string> {
    if (this.disposed || !this.hasOutput) return '';
    await this.flush();
    if (this.disposed || !this.hasOutput) return '';
    return this.serializeSync(options);
  }

  /** 同步序列化当前已解析的终端状态（调用前请确保已 flush） */
  public serializeSync(options?: SerializeTerminalOptions): string {
    if (this.disposed || !this.hasOutput) return '';
    try {
      return this.serializeAddon.serialize({
        scrollback: options?.scrollback ?? this.scrollback,
        excludeModes: options?.excludeModes ?? false,
        excludeAltBuffer: options?.excludeAltBuffer ?? false,
      });
    } catch (err) {
      console.warn('[BackendTerminalEmulator] serialize() 失败:', err);
      return '';
    }
  }

  /** 幂等释放 Headless VT 与 SerializeAddon，防止内存泄漏 */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingWriteBytes = 0;
    this.overloaded = false;
    try {
      this.serializeAddon.dispose();
    } catch {
      // ignore
    }
    try {
      this.terminal.dispose();
    } catch {
      // ignore
    }
  }
}
