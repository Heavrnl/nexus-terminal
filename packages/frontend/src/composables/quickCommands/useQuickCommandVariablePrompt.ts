import { ref } from 'vue';
import { useQuickCommandsStore, type QuickCommandFE } from '../../stores/quickCommands.store';
import { getMissingVariableNames, withIgnoredVariable } from './useQuickCommandExecution';

/**
 * 快捷指令「变量补填」弹窗的全局单例状态。
 *
 * 为什么做成模块级单例而不是每个视图各存一份：
 * 触发点不止一个（桌面快捷指令面板、移动端面板、指令管理页，还有嵌在弹窗里的同一套视图），
 * 弹窗只需要在 App 里挂一次；各触发点 `await promptQuickCommandVariables(cmd)` 即可，
 * 桌面和移动端共用同一个组件（组件内部按 isMobile 切换成底部抽屉）。
 */

export interface QuickCommandVariablePromptState {
  /** 原快捷指令对象（用于“这不是变量”时持久化更新忽略列表） */
  command: QuickCommandFE;
  /** 指令名（可能为空，用于标题） */
  commandName: string;
  /** 原始模板，用于预览 */
  template: string;
  /** 需要补填的变量名（按模板出现顺序） */
  missing: string[];
  /** 已有值，交给弹窗做预填 */
  values: Record<string, string>;
}

export const quickCommandVariablePromptState = ref<QuickCommandVariablePromptState | null>(null);

/** 当前挂起的 resolve（同时只允许一个弹窗） */
let pendingResolver: ((values: Record<string, string> | null) => void) | null = null;

/** 关闭弹窗并结算（values=null 表示取消） */
function settle(values: Record<string, string> | null) {
  const resolve = pendingResolver;
  pendingResolver = null;
  quickCommandVariablePromptState.value = null;
  resolve?.(values);
}

/**
 * 请用户补填变量。
 *
 * @returns 补全后的变量表；用户取消返回 `null`。没有任何缺失时立刻返回已有变量（不弹窗）。
 */
export function promptQuickCommandVariables(cmd: QuickCommandFE): Promise<Record<string, string> | null> {
  const values = cmd.variables || {};
  const missing = getMissingVariableNames(cmd.command, values);
  if (missing.length === 0) return Promise.resolve({ ...values });

  // 已经有弹窗没关（连点两下 / 换了一条指令）：先把上一个当成取消，避免 resolve 泄漏
  if (pendingResolver) settle(null);

  return new Promise((resolve) => {
    pendingResolver = resolve;
    quickCommandVariablePromptState.value = {
      command: cmd,
      commandName: cmd.name || '',
      template: cmd.command || '',
      missing,
      values: { ...values },
    };
  });
}

/** 将指定占位符标记为“这不是变量”（持久化到快捷指令，不再弹窗询问） */
export async function ignoreQuickCommandVariable(name: string, currentDraft: Record<string, string> = {}) {
  const state = quickCommandVariablePromptState.value;
  if (!state) return;

  const nextValues = withIgnoredVariable(state.values, name);
  const nextMissing = state.missing.filter((item) => item !== name);
  const cmd = state.command;

  // 持久化保存忽略配置，确保下次执行不再弹窗
  if (cmd.id > 0) {
    try {
      const quickCommandsStore = useQuickCommandsStore();
      await quickCommandsStore.updateQuickCommand(
        cmd.id,
        cmd.name,
        cmd.command,
        cmd.folderIds,
        nextValues,
        cmd.background_color
      );
    } catch (err) {
      console.error('[QuickCommandVariablePrompt] 保存非变量标记失败:', err);
    }
  }

  // 若已没有需要填写的剩余变量，直接关闭弹窗并发送指令
  if (nextMissing.length === 0) {
    settle(nextValues);
    return;
  }

  quickCommandVariablePromptState.value = {
    ...state,
    missing: nextMissing,
    values: { ...nextValues, ...currentDraft },
  };
}

/** 弹窗点「发送」 */
export function submitQuickCommandVariables(filled: Record<string, string>) {
  settle({ ...(quickCommandVariablePromptState.value?.values || {}), ...filled });
}

/** 弹窗关闭/取消 */
export function cancelQuickCommandVariablePrompt() {
  if (pendingResolver) settle(null);
  else quickCommandVariablePromptState.value = null;
}
