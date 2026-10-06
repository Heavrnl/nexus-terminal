import { ref, watch } from 'vue';
import { useSettingsStore } from '../../stores/settings.store';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';

export function useWorkspaceSettings() {
  const settingsStore = useSettingsStore();
  const { t } = useI18n();

  const {
    showPopupFileEditorBoolean,
    shareFileEditorTabsBoolean,
    autoCopyOnSelectBoolean,
    workspaceSidebarPersistentBoolean,
    commandInputSyncTarget,
    showConnectionTagsBoolean,
    showQuickCommandTagsBoolean,
    terminalScrollbackLimitNumber,
    fileManagerShowDeleteConfirmationBoolean,
    fileManagerDoubleClickToOpenBoolean,
    terminalEnableRightClickPasteBoolean,
    showPopupFileManagerBoolean, 
    statusMonitorShowIpBoolean,
  } = storeToRefs(settingsStore);

  // --- Popup Editor ---
  const popupEditorEnabled = ref(true);
  const popupEditorLoading = ref(false);
  const popupEditorMessage = ref('');
  const popupEditorSuccess = ref(false);

  const handleUpdatePopupEditorSetting = async () => {
    popupEditorLoading.value = true;
    popupEditorMessage.value = '';
    popupEditorSuccess.value = false;
    try {
      const valueToSave = popupEditorEnabled.value ? 'true' : 'false';
      await settingsStore.updateSetting('showPopupFileEditor', valueToSave);
      popupEditorMessage.value = t('settings.popupEditor.success.saved');
      popupEditorSuccess.value = true;
    } catch (error: any) {
      console.error('更新弹窗编辑器设置失败:', error);
      popupEditorMessage.value = error.message || t('settings.popupEditor.error.saveFailed');
      popupEditorSuccess.value = false;
    } finally {
      popupEditorLoading.value = false;
    }
  };

  // --- Share Editor Tabs ---
  const shareTabsEnabled = ref(true);
  const shareTabsLoading = ref(false);
  const shareTabsMessage = ref('');
  const shareTabsSuccess = ref(false);

  const handleUpdateShareTabsSetting = async () => {
    shareTabsLoading.value = true;
    shareTabsMessage.value = '';
    shareTabsSuccess.value = false;
    try {
      const valueToSave = shareTabsEnabled.value ? 'true' : 'false';
      await settingsStore.updateSetting('shareFileEditorTabs', valueToSave);
      shareTabsMessage.value = t('settings.shareEditorTabs.success.saved');
      shareTabsSuccess.value = true;
    } catch (error: any) {
      console.error('更新共享编辑器标签页设置失败:', error);
      shareTabsMessage.value = error.message || t('settings.shareEditorTabs.error.saveFailed');
      shareTabsSuccess.value = false;
    } finally {
      shareTabsLoading.value = false;
    }
  };

  // --- Auto Copy on Select ---
  const autoCopyEnabled = ref(false);
  const autoCopyLoading = ref(false);
  const autoCopyMessage = ref('');
  const autoCopySuccess = ref(false);

  const handleUpdateAutoCopySetting = async () => {
    autoCopyLoading.value = true;
    autoCopyMessage.value = '';
    autoCopySuccess.value = false;
    try {
      const valueToSave = autoCopyEnabled.value ? 'true' : 'false';
      await settingsStore.updateSetting('autoCopyOnSelect', valueToSave);
      autoCopyMessage.value = t('settings.autoCopyOnSelect.success.saved');
      autoCopySuccess.value = true;
    } catch (error: any) {
      console.error('更新自动复制设置失败:', error);
      autoCopyMessage.value = error.message || t('settings.autoCopyOnSelect.error.saveFailed');
      autoCopySuccess.value = false;
    } finally {
      autoCopyLoading.value = false;
    }
  };

  // --- Workspace Sidebar Persistent ---
  const workspaceSidebarPersistentEnabled = ref(false);
  const workspaceSidebarPersistentLoading = ref(false);
  const workspaceSidebarPersistentMessage = ref('');
  const workspaceSidebarPersistentSuccess = ref(false);

  const handleUpdateWorkspaceSidebarSetting = async () => {
    workspaceSidebarPersistentLoading.value = true;
    workspaceSidebarPersistentMessage.value = '';
    workspaceSidebarPersistentSuccess.value = false;
    try {
      const valueToSave = workspaceSidebarPersistentEnabled.value ? 'true' : 'false';
      await settingsStore.updateSetting('workspaceSidebarPersistent', valueToSave);
      workspaceSidebarPersistentMessage.value = t('settings.workspace.success.sidebarPersistentSaved');
      workspaceSidebarPersistentSuccess.value = true;
    } catch (error: any) {
      console.error('更新侧边栏固定设置失败:', error);
      workspaceSidebarPersistentMessage.value = error.message || t('settings.workspace.error.sidebarPersistentSaveFailed');
      workspaceSidebarPersistentSuccess.value = false;
    } finally {
      workspaceSidebarPersistentLoading.value = false;
    }
  };

  // --- Command Input Sync Target ---
  const commandInputSyncTargetLocal = ref<'none' | 'quickCommands' | 'commandHistory'>('none');
  const commandInputSyncLoading = ref(false);
  const commandInputSyncMessage = ref('');
  const commandInputSyncSuccess = ref(false);

  const handleUpdateCommandInputSyncTarget = async () => {
    commandInputSyncLoading.value = true;
    commandInputSyncMessage.value = '';
    commandInputSyncSuccess.value = false;
    try {
      await settingsStore.updateSetting('commandInputSyncTarget', commandInputSyncTargetLocal.value);
      commandInputSyncMessage.value = t('settings.commandInputSync.success.saved', '同步目标已保存');
      commandInputSyncSuccess.value = true;
    } catch (error: any) {
      console.error('更新命令输入同步目标失败:', error);
      commandInputSyncMessage.value = error.message || t('settings.commandInputSync.error.saveFailed', '保存同步目标失败');
      commandInputSyncSuccess.value = false;
    } finally {
      commandInputSyncLoading.value = false;
    }
  };

  // --- Show Connection Tags ---
  const showConnectionTagsLocal = ref(true);
  const showConnectionTagsLoading = ref(false);
  const showConnectionTagsMessage = ref('');
  const showConnectionTagsSuccess = ref(false);

  const handleUpdateShowConnectionTags = async () => {
    showConnectionTagsLoading.value = true;
    showConnectionTagsMessage.value = '';
    showConnectionTagsSuccess.value = false;
    try {
      await settingsStore.updateSetting('showConnectionTags', showConnectionTagsLocal.value);
      showConnectionTagsMessage.value = t('settings.workspace.success.showConnectionTagsSaved', '连接标签显示设置已保存');
      showConnectionTagsSuccess.value = true;
    } catch (error: any) {
      console.error('更新显示连接标签设置失败:', error);
      showConnectionTagsMessage.value = error.message || t('settings.workspace.error.showConnectionTagsSaveFailed', '保存连接标签显示设置失败');
      showConnectionTagsSuccess.value = false;
    } finally {
      showConnectionTagsLoading.value = false;
    }
  };

  // --- Show Quick Command Tags ---
  const showQuickCommandTagsLocal = ref(true);
  const showQuickCommandTagsLoading = ref(false);
  const showQuickCommandTagsMessage = ref('');
  const showQuickCommandTagsSuccess = ref(false);

  const handleUpdateShowQuickCommandTags = async () => {
    showQuickCommandTagsLoading.value = true;
    showQuickCommandTagsMessage.value = '';
    showQuickCommandTagsSuccess.value = false;
    try {
      await settingsStore.updateSetting('showQuickCommandTags', showQuickCommandTagsLocal.value);
      showQuickCommandTagsMessage.value = t('settings.workspace.success.showQuickCommandTagsSaved', '快捷指令标签显示设置已保存');
      showQuickCommandTagsSuccess.value = true;
    } catch (error: any) {
      console.error('更新显示快捷指令标签设置失败:', error);
      showQuickCommandTagsMessage.value = error.message || t('settings.workspace.error.showQuickCommandTagsSaveFailed', '保存快捷指令标签显示设置失败');
      showQuickCommandTagsSuccess.value = false;
    } finally {
      showQuickCommandTagsLoading.value = false;
    }
  };

  // --- Terminal Scrollback Limit ---
  const terminalScrollbackLimitLocal = ref<number | null>(null);
  const terminalScrollbackLimitLoading = ref(false);
  const terminalScrollbackLimitMessage = ref('');
  const terminalScrollbackLimitSuccess = ref(false);

  const handleUpdateTerminalScrollbackLimit = async () => {
    terminalScrollbackLimitLoading.value = true;
    terminalScrollbackLimitMessage.value = '';
    terminalScrollbackLimitSuccess.value = false;
    try {
      const limitValue = terminalScrollbackLimitLocal.value;
      if (limitValue !== null && limitValue !== undefined && (isNaN(limitValue) || !Number.isInteger(limitValue) || limitValue < 0)) {
        throw new Error(t('settings.terminalScrollback.error.invalidInput', '请输入一个有效的非负整数。'));
      }
      const valueToSave = (limitValue === null || limitValue === undefined) ? '5000' : String(limitValue);
      await settingsStore.updateSetting('terminalScrollbackLimit', valueToSave);
      terminalScrollbackLimitMessage.value = t('settings.terminalScrollback.success.saved', '终端回滚行数设置已保存。');
      terminalScrollbackLimitSuccess.value = true;
    } catch (error: any) {
      console.error('更新终端回滚行数设置失败:', error);
      terminalScrollbackLimitMessage.value = error.message || t('settings.terminalScrollback.error.saveFailed', '保存终端回滚行数设置失败。');
      terminalScrollbackLimitSuccess.value = false;
    } finally {
      terminalScrollbackLimitLoading.value = false;
    }
  };

  // --- File Manager Delete Confirmation ---
  const fileManagerShowDeleteConfirmationLocal = ref(true);
  const fileManagerShowDeleteConfirmationLoading = ref(false);
  const fileManagerShowDeleteConfirmationMessage = ref('');
  const fileManagerShowDeleteConfirmationSuccess = ref(false);

  const handleUpdateFileManagerDeleteConfirmation = async () => {
    fileManagerShowDeleteConfirmationLoading.value = true;
    fileManagerShowDeleteConfirmationMessage.value = '';
    fileManagerShowDeleteConfirmationSuccess.value = false;
    try {
      const valueToSave = fileManagerShowDeleteConfirmationLocal.value ? 'true' : 'false';
      await settingsStore.updateSetting('fileManagerShowDeleteConfirmation', valueToSave);
      fileManagerShowDeleteConfirmationMessage.value = t('settings.workspace.fileManagerDeleteConfirmSuccess', '文件管理器删除确认设置已保存。');
      fileManagerShowDeleteConfirmationSuccess.value = true;
    } catch (error: any) {
      console.error('更新文件管理器删除确认设置失败:', error);
      fileManagerShowDeleteConfirmationMessage.value = error.message || t('settings.workspace.fileManagerDeleteConfirmError', '保存文件管理器删除确认设置失败。');
      fileManagerShowDeleteConfirmationSuccess.value = false;
    } finally {
      fileManagerShowDeleteConfirmationLoading.value = false;
    }
  };

  // --- File Manager Double Click to Open ---
  const fileManagerDoubleClickToOpenLocal = ref(false);
  const fileManagerDoubleClickToOpenLoading = ref(false);
  const fileManagerDoubleClickToOpenMessage = ref('');
  const fileManagerDoubleClickToOpenSuccess = ref(false);

  const handleUpdateFileManagerDoubleClickToOpen = async () => {
    fileManagerDoubleClickToOpenLoading.value = true;
    fileManagerDoubleClickToOpenMessage.value = '';
    fileManagerDoubleClickToOpenSuccess.value = false;
    try {
      const valueToSave = fileManagerDoubleClickToOpenLocal.value ? 'true' : 'false';
      await settingsStore.updateSetting('fileManagerDoubleClickToOpen', valueToSave);
      fileManagerDoubleClickToOpenMessage.value = t('settings.workspace.fileManagerDoubleClickToOpenSuccess', '双击打开文件/文件夹设置已保存。');
      fileManagerDoubleClickToOpenSuccess.value = true;
    } catch (error: any) {
      console.error('更新双击打开设置失败:', error);
      fileManagerDoubleClickToOpenMessage.value = error.message || t('settings.workspace.fileManagerDoubleClickToOpenError', '保存双击打开文件/文件夹设置失败。');
      fileManagerDoubleClickToOpenSuccess.value = false;
    } finally {
      fileManagerDoubleClickToOpenLoading.value = false;
    }
  };

  // --- Terminal Right Click Paste ---
  const terminalEnableRightClickPasteLocal = ref(true);
  const terminalEnableRightClickPasteLoading = ref(false);
  const terminalEnableRightClickPasteMessage = ref('');
  const terminalEnableRightClickPasteSuccess = ref(false);

  const handleUpdateTerminalRightClickPasteSetting = async () => {
    terminalEnableRightClickPasteLoading.value = true;
    terminalEnableRightClickPasteMessage.value = '';
    terminalEnableRightClickPasteSuccess.value = false;
    try {
      const valueToSave = terminalEnableRightClickPasteLocal.value ? 'true' : 'false';
      await settingsStore.updateSetting('terminalEnableRightClickPaste', valueToSave);
      terminalEnableRightClickPasteMessage.value = t('settings.workspace.terminalRightClickPasteSuccess', '终端右键粘贴设置已保存。');
      terminalEnableRightClickPasteSuccess.value = true;
    } catch (error: any) {
      console.error('更新终端右键粘贴设置失败:', error);
      terminalEnableRightClickPasteMessage.value = error.message || t('settings.workspace.terminalRightClickPasteError', '保存终端右键粘贴设置失败。');
      terminalEnableRightClickPasteSuccess.value = false;
    } finally {
      terminalEnableRightClickPasteLoading.value = false;
    }
  };

  // --- Popup File Manager ---
  const showPopupFileManagerLocal = ref(true);
  const showPopupFileManagerLoading = ref(false);
  const showPopupFileManagerMessage = ref('');
  const showPopupFileManagerSuccess = ref(false);

  const handleUpdateShowPopupFileManager = async () => {
    showPopupFileManagerLoading.value = true;
    showPopupFileManagerMessage.value = '';
    showPopupFileManagerSuccess.value = false;
    try {
      const valueToSave = showPopupFileManagerLocal.value ? 'true' : 'false';
      await settingsStore.updateSetting('showPopupFileManager', valueToSave);
      showPopupFileManagerMessage.value = t('settings.popupFileManager.success.saved');
      showPopupFileManagerSuccess.value = true;
    } catch (error: any) {
      console.error('更新弹窗文件管理器设置失败:', error);
      showPopupFileManagerMessage.value = error.message || t('settings.popupFileManager.error.saveFailed');
      showPopupFileManagerSuccess.value = false;
    } finally {
      showPopupFileManagerLoading.value = false;
    }
  };

  // --- Status Monitor Show IP ---
  const statusMonitorShowIpEnabled = ref(false);
  const statusMonitorShowIpLoading = ref(false);
  const statusMonitorShowIpMessage = ref('');
  const statusMonitorShowIpSuccess = ref(false);

  const handleUpdateStatusMonitorShowIpSetting = async () => {
    statusMonitorShowIpLoading.value = true;
    statusMonitorShowIpMessage.value = '';
    statusMonitorShowIpSuccess.value = false;
    try {
      const valueToSave = statusMonitorShowIpEnabled.value ? 'true' : 'false';
      await settingsStore.updateSetting('showStatusMonitorIpAddress', valueToSave);
      statusMonitorShowIpMessage.value = t('common.saved');
      statusMonitorShowIpSuccess.value = true;
    } catch (error: any) {
      console.error('Failed to update status monitor IP display setting:', error);
      statusMonitorShowIpMessage.value = error.message || t('settings.statusMonitorShowIp.error.saveFailed', 'Failed to save status monitor IP display setting.'); //  需要添加相应的i18n键
      statusMonitorShowIpSuccess.value = false;
    } finally {
      statusMonitorShowIpLoading.value = false;
    }
  };

  // Watchers to sync local state with store state
  watch(showPopupFileEditorBoolean, (newValue) => { popupEditorEnabled.value = newValue; }, { immediate: true });
  watch(shareFileEditorTabsBoolean, (newValue) => { shareTabsEnabled.value = newValue; }, { immediate: true });
  watch(autoCopyOnSelectBoolean, (newValue) => { autoCopyEnabled.value = newValue; }, { immediate: true });
  watch(workspaceSidebarPersistentBoolean, (newValue) => { workspaceSidebarPersistentEnabled.value = newValue; }, { immediate: true });
  watch(commandInputSyncTarget, (newValue) => { commandInputSyncTargetLocal.value = newValue; }, { immediate: true });
  watch(showConnectionTagsBoolean, (newValue) => { showConnectionTagsLocal.value = newValue; }, { immediate: true });
  watch(showQuickCommandTagsBoolean, (newValue) => { showQuickCommandTagsLocal.value = newValue; }, { immediate: true });
  watch(terminalScrollbackLimitNumber, (newValue) => { terminalScrollbackLimitLocal.value = newValue; }, { immediate: true });
  watch(fileManagerShowDeleteConfirmationBoolean, (newValue) => { fileManagerShowDeleteConfirmationLocal.value = newValue; }, { immediate: true });
  watch(fileManagerDoubleClickToOpenBoolean, (newValue) => { fileManagerDoubleClickToOpenLocal.value = newValue; }, { immediate: true });
  watch(terminalEnableRightClickPasteBoolean, (newValue) => { terminalEnableRightClickPasteLocal.value = newValue; }, { immediate: true });
  watch(showPopupFileManagerBoolean, (newValue) => { showPopupFileManagerLocal.value = newValue; }, { immediate: true }); // +++ Watch for popup file manager +++
  watch(statusMonitorShowIpBoolean, (newValue) => { statusMonitorShowIpEnabled.value = newValue; }, { immediate: true });


  return {
    popupEditorEnabled,
    popupEditorLoading,
    popupEditorMessage,
    popupEditorSuccess,
    handleUpdatePopupEditorSetting,

    shareTabsEnabled,
    shareTabsLoading,
    shareTabsMessage,
    shareTabsSuccess,
    handleUpdateShareTabsSetting,

    autoCopyEnabled,
    autoCopyLoading,
    autoCopyMessage,
    autoCopySuccess,
    handleUpdateAutoCopySetting,

    workspaceSidebarPersistentEnabled,
    workspaceSidebarPersistentLoading,
    workspaceSidebarPersistentMessage,
    workspaceSidebarPersistentSuccess,
    handleUpdateWorkspaceSidebarSetting,

    commandInputSyncTargetLocal,
    commandInputSyncLoading,
    commandInputSyncMessage,
    commandInputSyncSuccess,
    handleUpdateCommandInputSyncTarget,

    showConnectionTagsLocal,
    showConnectionTagsLoading,
    showConnectionTagsMessage,
    showConnectionTagsSuccess,
    handleUpdateShowConnectionTags,

    showQuickCommandTagsLocal,
    showQuickCommandTagsLoading,
    showQuickCommandTagsMessage,
    showQuickCommandTagsSuccess,
    handleUpdateShowQuickCommandTags,

    terminalScrollbackLimitLocal,
    terminalScrollbackLimitLoading,
    terminalScrollbackLimitMessage,
    terminalScrollbackLimitSuccess,
    handleUpdateTerminalScrollbackLimit,

    fileManagerShowDeleteConfirmationLocal,
    fileManagerShowDeleteConfirmationLoading,
    fileManagerShowDeleteConfirmationMessage,
    fileManagerShowDeleteConfirmationSuccess,
    handleUpdateFileManagerDeleteConfirmation,

    fileManagerDoubleClickToOpenLocal,
    fileManagerDoubleClickToOpenLoading,
    fileManagerDoubleClickToOpenMessage,
    fileManagerDoubleClickToOpenSuccess,
    handleUpdateFileManagerDoubleClickToOpen,

    terminalEnableRightClickPasteLocal, 
    terminalEnableRightClickPasteLoading, 
    terminalEnableRightClickPasteMessage, 
    terminalEnableRightClickPasteSuccess, 
    handleUpdateTerminalRightClickPasteSetting, 

    // Popup File Manager
    showPopupFileManagerLocal,
    showPopupFileManagerLoading,
    showPopupFileManagerMessage,
    showPopupFileManagerSuccess,
    handleUpdateShowPopupFileManager,

    statusMonitorShowIpEnabled,
    statusMonitorShowIpLoading,
    statusMonitorShowIpMessage,
    statusMonitorShowIpSuccess,
    handleUpdateStatusMonitorShowIpSetting,
  };
}