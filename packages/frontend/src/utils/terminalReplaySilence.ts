/**
 * 终端历史回放静默屏障（前端纵深防御）。
 *
 * 与后端 Headless VT 状态机配合形成双保险：
 *   - 后端 full 模式恢复已直接下发纯净序列化屏幕快照（天然不含查询控制序列）；
 *   - 在 WS 抖动 delta 增量回放、旧快照恢复或隐藏标签页延迟 flush 等边缘路径下，
 *     本控制器利用 xterm.js WriteBuffer 的严格 FIFO 回调语义，在回放块解析期间
 *     静默拦截 parser 自动生成的终端查询应答（DA1/DA2/OSC 10~12/DSR/DECRQM 等），
 *     同时 100% 放行真实用户按键/粘贴/输入事件，不依赖任何正则穷举。
 */

export type RawTerminalWriteFn = (data: string | Uint8Array, callback?: () => void) => void;

export interface ReplaySilenceController {
  /** 进入一层回放静默状态 */
  beginReplay(): void;
  /** 退出一层回放静默状态 */
  endReplay(): void;
  /** 标记紧随其后同步触发的 onData 源自真实用户交互（键盘/粘贴/IME/鼠标） */
  markUserInput(): void;
  /** 在 terminal.onData 中调用，返回 true 表示本次数据是回放期自动回包应丢弃 */
  shouldSuppressOnData(): boolean;
  /** 是否正处于回放静默解析窗口内 */
  isSilencing(): boolean;
  /** 使用严格 FIFO 前后回调包裹一次回放写入 */
  writeWithSilence(rawWrite: RawTerminalWriteFn, data: string | Uint8Array, cb?: () => void): void;
  /** 重置内部状态（组件卸载时调用） */
  reset(): void;
}

export function createReplaySilenceController(): ReplaySilenceController {
  let silenceDepth = 0;
  let pendingUserInput = false;

  const beginReplay = () => {
    silenceDepth += 1;
  };

  const endReplay = () => {
    silenceDepth = Math.max(0, silenceDepth - 1);
  };

  const markUserInput = () => {
    pendingUserInput = true;
  };

  const shouldSuppressOnData = (): boolean => {
    if (pendingUserInput) {
      pendingUserInput = false;
      return false;
    }
    return silenceDepth > 0;
  };

  const isSilencing = (): boolean => silenceDepth > 0;

  const writeWithSilence = (
    rawWrite: RawTerminalWriteFn,
    data: string | Uint8Array,
    cb?: () => void
  ): void => {
    if (!data || data.length === 0) {
      cb?.();
      return;
    }
    // 前置空写回调：确保排在它前面的实时流全部解析完后，再同步进入静默窗口
    rawWrite('', () => {
      beginReplay();
    });
    // 回放体结束回调：当前回放块刚解析完、下一块实时流开始前，同步退出静默窗口
    rawWrite(data, () => {
      endReplay();
      cb?.();
    });
  };

  const reset = () => {
    silenceDepth = 0;
    pendingUserInput = false;
  };

  return {
    beginReplay,
    endReplay,
    markUserInput,
    shouldSuppressOnData,
    isSilencing,
    writeWithSilence,
    reset,
  };
}

/**
 * 统一的历史回放写入入口：优先走终端实例挂载的 `writeReplay` 静默通道，
 * 若未挂载（例如测试桩或普通 xterm 实例）则安全退回标准 `write`。
 */
export function writeTerminalReplay(
  term: { write: RawTerminalWriteFn; writeReplay?: RawTerminalWriteFn } | null | undefined,
  data: string | Uint8Array,
  cb?: () => void
): void {
  if (!term || !data || data.length === 0) {
    cb?.();
    return;
  }
  if (typeof term.writeReplay === 'function') {
    term.writeReplay(data, cb);
  } else {
    term.write(data, cb);
  }
}
