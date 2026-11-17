import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useQuickCommandsStore, type QuickCommandFE } from '../../stores/quickCommands.store';
import { useQuickCommandFoldersStore } from '../../stores/quickCommandFolders.store';
import { useSessionStore } from '../../stores/session.store';
import { useUiNotificationsStore } from '../../stores/uiNotifications.store';
import { useWorkspaceEventEmitter } from '../workspaceEvents';
import { useConfirmDialog } from '../useConfirmDialog';
import { useAlertDialog } from '../useAlertDialog';
import { generateRandomColor } from '../../utils/colorUtils';
import {
  extractVariableNames,
  getIgnoredVariableNames,
  IGNORED_VARS_KEY,
  resolveCommandVariables,
} from './useQuickCommandExecution';

/**
 * 「新增/编辑快捷指令」表单的逻辑（桌面 / 移动共 247 行逐字相同）。
 *
 * 两个关键行为：
 * 1. **保存时变量只保留有名字的**（name 为空的行直接丢弃）。
 *    用户点了"添加变量"但没填名字是常见操作，不能因此存一条空变量。
 * 2. **即时执行用的是本地变量表**，不是已保存的 `commandToEdit.variables` ——
 *    用户刚在弹窗里改的值要立刻生效，不能等保存。
 *
 * 与 `useQuickCommandExecution` 共用变量解析：以前这里又手写了一遍 RegExp 拼接，
 * 变量名里带 `.` `(` 会直接抛异常，值里的 `$&` 会被当成替换模式。
 */
export interface QuickCommandFormProps {
  commandToEdit?: QuickCommandFE | null;
  initialCommand?: string;
  initialFolderId?: number | null;
}

export interface LocalVariable {
  name: string;
  value: string;
  id: string;
}

const newVariableId = () => `var-${Date.now()}-${Math.random().toString(36).substring(7)}`;

export function useQuickCommandForm(props: QuickCommandFormProps, emit: (e: 'close') => void) {
  const { t } = useI18n();
  const { showConfirmDialog } = useConfirmDialog();
  const { showAlertDialog } = useAlertDialog();
  const quickCommandsStore = useQuickCommandsStore();
  const quickCommandFoldersStore = useQuickCommandFoldersStore();
  const sessionStore = useSessionStore();
  const uiNotificationsStore = useUiNotificationsStore();
  const emitWorkspaceEvent = useWorkspaceEventEmitter();

  const isSubmitting = ref(false);
  const isEditing = computed(() => !!(props.commandToEdit && props.commandToEdit.id > 0));

  const formData = reactive({
    name: '',
    command: '',
    folderIds: [] as number[],
    custom_background_color: false,
    background_color: '#3b82f6',
  });

  const localVariables = ref<LocalVariable[]>([]);
  const ignoredVariables = ref<string[]>([]);
  const commandError = ref<string | null>(null);

  const toggleCustomColor = () => {
    formData.custom_background_color = !formData.custom_background_color;
    if (formData.custom_background_color && !formData.background_color) {
      formData.background_color = '#3b82f6';
    }
  };

  const handleRandomColor = () => {
    formData.background_color = generateRandomColor();
  };

  const selectedFolderId = computed({
    get: () => {
      return formData.folderIds && formData.folderIds.length > 0 ? formData.folderIds[0] : null;
    },
    set: (val: number | null) => {
      formData.folderIds = val !== null ? [val] : [];
    },
  });

  // 指令内容变化时校验
  watch(() => formData.command, (newCommand) => {
    if (!newCommand || newCommand.trim().length === 0) {
      commandError.value = t('quickCommands.form.errorCommandRequired', '指令内容不能为空');
    } else {
      commandError.value = null;
    }
  });

  /** 用 props 初始化表单（组件 onMounted 时调用） */
  function initForm() {
    if (isEditing.value && props.commandToEdit) {
      formData.name = props.commandToEdit.name ?? '';
      formData.command = props.commandToEdit.command;
      formData.folderIds = props.commandToEdit.folderIds ? [...props.commandToEdit.folderIds] : [];
      if (props.commandToEdit.background_color) {
        formData.custom_background_color = true;
        formData.background_color = props.commandToEdit.background_color;
      } else {
        formData.custom_background_color = false;
        formData.background_color = '#3b82f6';
      }
      if (props.commandToEdit.variables) {
        ignoredVariables.value = getIgnoredVariableNames(props.commandToEdit.variables);
        localVariables.value = Object.entries(props.commandToEdit.variables)
          .filter(([name]) => name !== IGNORED_VARS_KEY)
          .map(([name, value]) => ({ name, value: String(value ?? ''), id: newVariableId() }));
      } else {
        ignoredVariables.value = [];
        localVariables.value = [];
      }
    } else {
      ignoredVariables.value = [];
      if (props.initialCommand) {
        formData.command = props.initialCommand;
      }
      if (props.initialFolderId) {
        formData.folderIds = [props.initialFolderId];
      }
    }
  }

  const handleCreateFolder = async (folderName: string) => {
    if (!folderName || folderName.trim().length === 0) return;
    const newFolder = await quickCommandFoldersStore.createFolder(folderName.trim());
    if (newFolder) {
      formData.folderIds = [newFolder.id];
    }
  };

  const handleDeleteFolder = async (folderId: number) => {
    const folderToDelete = quickCommandFoldersStore.folders.find((folder) => folder.id === folderId);
    if (!folderToDelete) return;

    const confirmed = await showConfirmDialog({
      message: t('folders.prompts.confirmDelete', { name: folderToDelete.name }),
    });
    if (confirmed) {
      const success = await quickCommandFoldersStore.deleteFolder(folderId);
      if (success) {
        const index = formData.folderIds.indexOf(folderId);
        if (index > -1) {
          formData.folderIds.splice(index, 1);
        }
      } else {
        showAlertDialog({
          title: t('common.error', '错误'),
          message: t('folders.errorDelete', { error: quickCommandFoldersStore.error || '未知错误' }),
        });
      }
    }
  };

  const collectVariables = (): Record<string, string> => {
    const acc = localVariables.value.reduce(
      (map, curr) => {
        // 只保留填了名字的行（且跳过内部保留键）
        const trimmedName = curr.name.trim();
        if (trimmedName && trimmedName !== IGNORED_VARS_KEY) {
          map[trimmedName] = curr.value;
        }
        return map;
      },
      {} as Record<string, string>
    );
    if (ignoredVariables.value.length > 0) {
      acc[IGNORED_VARS_KEY] = JSON.stringify(ignoredVariables.value);
    }
    return acc;
  };

  const handleSubmit = async () => {
    if (commandError.value) return;

    isSubmitting.value = true;
    let success = false;

    const finalName = formData.name.trim().length > 0 ? formData.name.trim() : null;
    const variablesToSave = collectVariables();
    const backgroundColorToSave =
      formData.custom_background_color && formData.background_color
        ? formData.background_color.trim()
        : null;

    try {
      if (isEditing.value && props.commandToEdit) {
        success = await quickCommandsStore.updateQuickCommand(
          props.commandToEdit.id,
          finalName,
          formData.command.trim(),
          formData.folderIds,
          variablesToSave,
          backgroundColorToSave
        );
      } else {
        success = await quickCommandsStore.addQuickCommand(
          finalName,
          formData.command.trim(),
          formData.folderIds,
          variablesToSave,
          backgroundColorToSave
        );
      }
    } finally {
      isSubmitting.value = false;
    }

    if (success) {
      closeForm();
    }
  };

  const closeForm = () => {
    emit('close');
  };

  const addVariable = () => {
    localVariables.value.push({ name: '', value: '', id: newVariableId() });
  };

  const deleteVariable = (variableId: string) => {
    localVariables.value = localVariables.value.filter((v) => v.id !== variableId);
  };

  /** 从指令内容中检测到的、尚未定义也尚未标记忽略的 `${...}` 占位符 */
  const detectedUnignoredPlaceholders = computed(() => {
    const definedNames = new Set(
      localVariables.value.map((v) => v.name.trim()).filter((n) => n.length > 0)
    );
    const ignoredSet = new Set(ignoredVariables.value);
    return extractVariableNames(formData.command).filter(
      (name) => !definedNames.has(name) && !ignoredSet.has(name)
    );
  });

  const ignoreVariablePlaceholder = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || ignoredVariables.value.includes(trimmed)) return;
    ignoredVariables.value = [...ignoredVariables.value, trimmed];
  };

  const unignoreVariablePlaceholder = (name: string) => {
    ignoredVariables.value = ignoredVariables.value.filter((item) => item !== name);
  };

  /** 不保存直接执行（用弹窗里当前填的变量） */
  const handleExecute = () => {
    const currentVariables = collectVariables();
    const processedCommand = resolveCommandVariables(formData.command, currentVariables);

    // 提示还没填值的占位符（已忽略的非变量除外，保留原样不静默清空）
    const ignoredSet = new Set(ignoredVariables.value);
    const missing = extractVariableNames(formData.command).filter(
      (name) => !ignoredSet.has(name) && !Object.prototype.hasOwnProperty.call(currentVariables, name)
    );
    if (missing.length > 0) {
      uiNotificationsStore.showWarning(
        t('quickCommands.form.warningUndefinedVariables', { variables: missing.join(', ') })
      );
    }

    const activeSessionId = sessionStore.activeSessionId;
    if (!activeSessionId) {
      uiNotificationsStore.showError(
        t('quickCommands.form.errorNoActiveSession', '没有活动的SSH会话可执行指令。')
      );
      return;
    }

    emitWorkspaceEvent('quickCommand:executeProcessed', {
      command: processedCommand,
      sessionId: activeSessionId,
    });

    closeForm();
  };

  return {
    isSubmitting,
    isEditing,
    formData,
    localVariables,
    ignoredVariables,
    detectedUnignoredPlaceholders,
    commandError,
    selectedFolderId,
    toggleCustomColor,
    handleRandomColor,
    initForm,
    handleCreateFolder,
    handleDeleteFolder,
    handleSubmit,
    closeForm,
    addVariable,
    deleteVariable,
    ignoreVariablePlaceholder,
    unignoreVariablePlaceholder,
    handleExecute,
  };
}
