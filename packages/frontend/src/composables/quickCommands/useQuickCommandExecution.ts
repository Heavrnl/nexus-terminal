import type { QuickCommandFE } from '../../stores/quickCommands.store';

/**
 * 快捷指令执行（桌面 / 移动两个视图共用）。
 *
 * 以前这段逻辑在 DesktopQuickCommandsView 和 MobileQuickCommandsView 里各有一份
 * 几乎逐字相同的实现，改一处必须记得改另一处。
 *
 * 顺带修掉两个问题：
 * 1. 变量名直接拼进 RegExp —— 名字里有 `.` `(` 之类的字符会抛异常或错配；
 * 2. 算出来的 `undefinedVariables` 从来没被读过（死代码），已删除。
 */

/** 在 variables 对象中存放“已标记为非变量（原样发送）”列表的保留键 */
export const IGNORED_VARS_KEY = '__nexus_ignored_vars__';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从 variables 对象中解析出已标记为“非变量”的占位符名称列表 */
export function getIgnoredVariableNames(
  savedVariables: Record<string, string> | null | undefined
): string[] {
  const raw = savedVariables?.[IGNORED_VARS_KEY];
  if (!raw || typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of parsed) {
      if (typeof item === 'string' && item.length > 0 && !seen.has(item)) {
        seen.add(item);
        result.push(item);
      }
    }
    return result;
  } catch {
    return [];
  }
}

/** 将指定占位符名称加入 variables 的忽略列表，返回新对象 */
export function withIgnoredVariable(
  savedVariables: Record<string, string> | null | undefined,
  name: string
): Record<string, string> {
  const next: Record<string, string> = { ...(savedVariables || {}) };
  const current = getIgnoredVariableNames(next);
  if (!current.includes(name)) {
    current.push(name);
  }
  next[IGNORED_VARS_KEY] = JSON.stringify(current);
  return next;
}

/**
 * 用已保存的变量值替换 `${name}` 占位符。
 *
 * 未定义的变量保持原样（用户能看到还缺哪个），不做静默清空 ——
 * 清空会变成"执行了一条不完整的命令"，比直接报错更危险。
 */
export function resolveCommandVariables(
  template: string,
  savedVariables: Record<string, string> | null | undefined
): string {
  if (!template) return '';
  const vars = savedVariables || {};
  let result = template;
  for (const varName of Object.keys(vars)) {
    if (varName === IGNORED_VARS_KEY) continue;
    const value = vars[varName];
    if (value === undefined || value === null) continue;
    const placeholder = new RegExp(`\\$\\{${escapeRegExp(varName)}\\}`, 'g');
    // 必须用函数式替换：直接传字符串时，值里的 $& / $1 会被当成替换模式
    result = result.replace(placeholder, () => value);
  }
  return result;
}

/** 取出模板里声明的变量名（去重，按出现顺序） */
export function extractVariableNames(template: string): string[] {
  const matches = template?.match(/\$\{([^}]+)\}/g) || [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of matches) {
    const name = raw.slice(2, -1);
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * 取出"当前还缺值"的变量名（模板里出现、但没值或只有空白）。
 *
 * 判空规则刻意收得比较严：`''`、纯空格、`null`/`undefined` 都算没填。
 * 原因很实际 —— `${path}` 填成空串，拼出来的就是 `rm -rf ` 这种残废命令，
 * 与其发一条不确定的命令，不如让用户先补一个字符。
 */
export function getMissingVariableNames(
  template: string,
  savedVariables: Record<string, string> | null | undefined
): string[] {
  const vars = savedVariables || {};
  const ignoredSet = new Set(getIgnoredVariableNames(vars));
  return extractVariableNames(template).filter((name) => {
    if (ignoredSet.has(name)) return false;
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return true;
    const value = vars[name];
    return typeof value !== 'string' || value.trim() === '';
  });
}

/** 用户点击发送、但模板变量还没值时，用来请他补填的回调（返回 null = 取消发送） */
export type QuickCommandVariablePrompter = (
  command: QuickCommandFE
) => Promise<Record<string, string> | null>;

export interface QuickCommandExecutionContext {
  /** 使用次数 +1 */
  incrementUsage: (id: number) => void;
  /** 当前活动 SSH 会话 */
  getActiveSessionId: () => string | null;
  /** 把处理后的命令发给工作区 */
  emitProcessed: (payload: { command: string; sessionId: string }) => void;
  /** 没有活动会话时的提示文案 */
  noActiveSessionMessage: () => string;
  /** 没有活动会话时的处理（通常是 toast） */
  onNoActiveSession: () => void;
  /** 执行完的附加回调（桌面版用来 emit 给父组件） */
  onExecuted?: (processedCommand: string) => void;
  /**
   * 变量为空时弹窗让用户补填，返回补全后的变量表；返回 null 表示用户取消。
   * 不传就保持老行为（占位符原样发出去）。
   */
  promptVariables?: QuickCommandVariablePrompter;
}

export function useQuickCommandExecution(ctx: QuickCommandExecutionContext) {
  /**
   * 执行一条快捷指令。
   *
   * 变量补填是异步的（要等弹窗），所以这里是 async：调用点直接 `executeCommand(cmd)`
   * 不 await 也没问题，取消/异常都不会往外抛。
   *
   * 顺序有意为之：先确认有会话（没会话弹窗让用户填完再报错很蠢），再补变量，
   * 最后才 `incrementUsage` —— 让"使用次数"只统计真正发出去的。
   */
  async function executeCommand(cmd: QuickCommandFE) {
    const activeSessionId = ctx.getActiveSessionId();
    if (!activeSessionId) {
      ctx.onNoActiveSession();
      return;
    }

    let variables = cmd.variables || {};
    if (cmd.command) {
      const missing = getMissingVariableNames(cmd.command, variables);
      if (missing.length > 0 && ctx.promptVariables) {
        try {
          const filled = await ctx.promptVariables(cmd);
          if (!filled) return; // 用户取消：不发、不计数
          variables = { ...variables, ...filled };
        } catch (error) {
          console.error('[QuickCommand] 变量补填弹窗异常，已取消本次执行:', error);
          return;
        }
      }
    }

    const processedCommand = resolveCommandVariables(cmd.command, variables);

    ctx.incrementUsage(cmd.id);
    ctx.emitProcessed({ command: processedCommand, sessionId: activeSessionId });
    ctx.onExecuted?.(processedCommand);
  }

  return { executeCommand };
}
