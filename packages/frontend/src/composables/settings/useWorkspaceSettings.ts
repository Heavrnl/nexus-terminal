import { useSettingsStore, type TerminalRightClickBehavior, type TerminalContextMenuSettings, DEFAULT_TERMINAL_CONTEXT_MENU_ITEMS } from '../../stores/settings.store';
import { useI18n } from 'vue-i18n';
import {
  useNumberSettingControl,
  useSettingControl,
  useStringSettingControl,
} from './useSettingControl';

/**
 * 「工作区」设置页里**不是单纯开关**的那部分设置项。
 *
 * 单纯布尔开关已全部收敛到 `<SettingToggle setting-key="…" />`：
 * 组件自己从 schema 取默认值、自己管草稿/loading/提示/保存，
 * 模板从 20 多行降到 1~2 行，也不用再在 useWorkspaceSettings 里登记。
 *
 * 这里只留需要自定义解析、校验、专用保存接口或联动逻辑的项。
 */
export function useWorkspaceSettings() {
  const settingsStore = useSettingsStore();
  const { t } = useI18n();

  // --- Markdown 默认视图模式（桌面端 / 移动端）---
  const markdownDefaultViewMode = useStringSettingControl({
    key: 'markdownDefaultViewMode',
    defaultValue: 'split',
    successMessage: () => t('common.saved'),
    errorMessage: () => t('common.saveFailed'),
  });

  const markdownDefaultViewModeMobile = useStringSettingControl({
    key: 'markdownDefaultViewModeMobile',
    defaultValue: 'preview',
    successMessage: () => t('common.saved'),
    errorMessage: () => t('common.saveFailed'),
  });

  // --- 命令输入同步目标 ---
  const commandInputSyncTarget = useStringSettingControl({
    key: 'commandInputSyncTarget',
    defaultValue: 'none',
    successMessage: () => t('settings.commandInputSync.success.saved', '同步目标已保存'),
    errorMessage: () => t('settings.commandInputSync.error.saveFailed', '保存同步目标失败'),
  });

  // --- 目标机托管活跃脱离会话空闲回收时长（小时，0 = 永不自动强杀）---
  const remoteSessionDetachedIdleHours = useNumberSettingControl({
    key: 'remoteSessionDetachedIdleHours',
    defaultValue: 0,
    validate: (value) => {
      if (value !== null && value !== undefined && (!Number.isInteger(value) || value < 0 || value > 8760)) {
        throw new Error(t('settings.remoteHosting.error.invalidIdleHours', '请输入 0 到 8760 之间的整数（0 表示永不自动回收）。'));
      }
    },
    serialize: (value) => (value === null || value === undefined ? '0' : String(value)),
    successMessage: () => t('settings.remoteHosting.success.idleHoursSaved', '空闲回收时长已保存。'),
    errorMessage: () => t('settings.remoteHosting.error.idleHoursSaveFailed', '保存空闲回收时长失败。'),
  });

  // --- 终端回滚行数（0 = 不限制，空值回落 5000）---
  const terminalScrollbackLimit = useNumberSettingControl({
    key: 'terminalScrollbackLimit',
    defaultValue: 5000,
    validate: (value) => {
      if (value !== null && value !== undefined && (!Number.isInteger(value) || value < 0)) {
        throw new Error(t('settings.terminalScrollback.error.invalidInput', '请输入一个有效的非负整数。'));
      }
    },
    serialize: (value) => (value === null || value === undefined ? '5000' : String(value)),
    successMessage: () => t('settings.terminalScrollback.success.saved', '终端回滚行数设置已保存。'),
    errorMessage: () => t('settings.terminalScrollback.error.saveFailed', '保存终端回滚行数设置失败。'),
  });

  // --- 终端 ---
  const terminalSwitchPaneShortcut = useSettingControl<string>({
    key: 'terminalSwitchPaneShortcut',
    defaultValue: 'Alt+`',
    parse: (raw) => raw,
    // 空串回落默认键位，避免用户清空后无法切分屏
    validate: (value) => {
      if (!value || !value.trim()) {
        throw new Error(t('settings.workspace.terminalSwitchPaneShortcutError', '保存分屏终端切换快捷键失败。'));
      }
    },
    persist: async (value) => {
      const normalized = value.trim() || 'Alt+`';
      terminalSwitchPaneShortcut.local.value = normalized;
      await settingsStore.updateTerminalSwitchPaneShortcut(normalized);
    },
    clearMessageAfterMs: 3000,
    successMessage: () => t('settings.workspace.terminalSwitchPaneShortcutSuccess', '分屏终端切换快捷键已保存。'),
    errorMessage: () => t('settings.workspace.terminalSwitchPaneShortcutError', '保存分屏终端切换快捷键失败。'),
  });

  const terminalRightClickBehavior = useSettingControl<TerminalRightClickBehavior>({
    key: 'terminalRightClickBehavior',
    defaultValue: 'contextMenu',
    parse: (raw) => raw as TerminalRightClickBehavior,
    persist: (value) => settingsStore.updateTerminalRightClickBehavior(value),
    successMessage: () => t('common.saved', '已保存'),
    errorMessage: () => t('common.saveFailed', '保存失败'),
  });

  const terminalContextMenuItems = useSettingControl<TerminalContextMenuSettings>({
    key: 'terminalContextMenuItems',
    defaultValue: { ...DEFAULT_TERMINAL_CONTEXT_MENU_ITEMS },
    parse: (raw) => {
      try {
        const parsed = JSON.parse(raw);
        return {
          copy: parsed.copy !== false,
          paste: parsed.paste !== false,
          openPath: parsed.openPath !== false,
          openFile: parsed.openFile !== false,
          saveQuickCommand: parsed.saveQuickCommand !== false,
        };
      } catch {
        return { ...DEFAULT_TERMINAL_CONTEXT_MENU_ITEMS };
      }
    },
    persist: (value) => settingsStore.updateTerminalContextMenuItems(value),
    successMessage: () => t('common.saved', '已保存'),
    errorMessage: () => t('common.saveFailed', '保存失败'),
  });

  return {
    // 兼容原有模板的字段名
    commandInputSyncTargetLocal: commandInputSyncTarget.local,
    commandInputSyncLoading: commandInputSyncTarget.loading,
    commandInputSyncMessage: commandInputSyncTarget.message,
    commandInputSyncSuccess: commandInputSyncTarget.success,
    handleUpdateCommandInputSyncTarget: commandInputSyncTarget.save,

    terminalScrollbackLimitLocal: terminalScrollbackLimit.local,
    terminalScrollbackLimitLoading: terminalScrollbackLimit.loading,
    terminalScrollbackLimitMessage: terminalScrollbackLimit.message,
    terminalScrollbackLimitSuccess: terminalScrollbackLimit.success,
    handleUpdateTerminalScrollbackLimit: terminalScrollbackLimit.save,

    remoteSessionDetachedIdleHoursLocal: remoteSessionDetachedIdleHours.local,
    remoteSessionDetachedIdleHoursLoading: remoteSessionDetachedIdleHours.loading,
    remoteSessionDetachedIdleHoursMessage: remoteSessionDetachedIdleHours.message,
    remoteSessionDetachedIdleHoursSuccess: remoteSessionDetachedIdleHours.success,
    handleUpdateRemoteSessionDetachedIdleHours: remoteSessionDetachedIdleHours.save,

    terminalRightClickBehaviorLocal: terminalRightClickBehavior.local,
    terminalRightClickBehaviorLoading: terminalRightClickBehavior.loading,
    terminalRightClickBehaviorMessage: terminalRightClickBehavior.message,
    terminalRightClickBehaviorSuccess: terminalRightClickBehavior.success,
    handleUpdateTerminalRightClickBehavior: terminalRightClickBehavior.save,

    terminalContextMenuItemsLocal: terminalContextMenuItems.local,
    terminalContextMenuItemsLoading: terminalContextMenuItems.loading,
    terminalContextMenuItemsMessage: terminalContextMenuItems.message,
    terminalContextMenuItemsSuccess: terminalContextMenuItems.success,
    handleUpdateTerminalContextMenuItems: terminalContextMenuItems.save,

    terminalSwitchPaneShortcutLocal: terminalSwitchPaneShortcut.local,
    terminalSwitchPaneShortcutLoading: terminalSwitchPaneShortcut.loading,
    terminalSwitchPaneShortcutMessage: terminalSwitchPaneShortcut.message,
    terminalSwitchPaneShortcutSuccess: terminalSwitchPaneShortcut.success,
    handleUpdateTerminalSwitchPaneShortcut: terminalSwitchPaneShortcut.save,

    markdownDefaultViewModeLocal: markdownDefaultViewMode.local,
    markdownDefaultViewModeLoading: markdownDefaultViewMode.loading,
    markdownDefaultViewModeMessage: markdownDefaultViewMode.message,
    markdownDefaultViewModeSuccess: markdownDefaultViewMode.success,
    handleUpdateMarkdownDefaultViewMode: markdownDefaultViewMode.save,

    markdownDefaultViewModeMobileLocal: markdownDefaultViewModeMobile.local,
    markdownDefaultViewModeMobileLoading: markdownDefaultViewModeMobile.loading,
    markdownDefaultViewModeMobileMessage: markdownDefaultViewModeMobile.message,
    markdownDefaultViewModeMobileSuccess: markdownDefaultViewModeMobile.success,
    handleUpdateMarkdownDefaultViewModeMobile: markdownDefaultViewModeMobile.save,
  };
}
