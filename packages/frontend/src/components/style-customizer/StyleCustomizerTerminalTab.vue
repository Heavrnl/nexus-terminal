<script setup lang="ts">
import { ref, reactive, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppearanceStore } from '../../stores/appearance.store';
import { useUiNotificationsStore } from '../../stores/uiNotifications.store';
import { storeToRefs } from 'pinia';
import type { ITheme } from 'xterm';
import type { TerminalTheme } from '../../types/terminal-theme.types';
import { defaultXtermTheme } from '../../features/appearance/config/default-themes';
import {
  TERMINAL_FONT_PRESETS,
  TERMINAL_FONT_CATEGORIES,
  QUICK_FONT_PILLS,
  findMatchingPreset,
  cleanFontName,
  type TerminalFontOption,
} from '../../constants/terminalFonts';

const { t } = useI18n();
const appearanceStore = useAppearanceStore();
const notificationsStore = useUiNotificationsStore();

const props = defineProps<{
  isEditingTheme: boolean;
  editingTheme: TerminalTheme | null;
  modalRootRef: HTMLDivElement | null;
}>();

const emit = defineEmits<{
  (e: 'update:isEditingTheme', value: boolean): void;
  (e: 'update:editingTheme', value: TerminalTheme | null): void;
}>();

const {
  allTerminalThemes,
  activeTerminalThemeId,
  currentTerminalFontFamily,
  currentTerminalFontSize,
  terminalTextStrokeEnabled,
  terminalTextStrokeWidth,
  terminalTextStrokeColor,
  terminalTextShadowEnabled,
  terminalTextShadowOffsetX,
  terminalTextShadowOffsetY,
  terminalTextShadowBlur,
  terminalTextShadowColor,
} = storeToRefs(appearanceStore);

const editableTerminalFontFamily = ref('');
const editableTerminalFontSize = ref(14);

// --- 终端字体预设与自定义模式状态 ---
const selectedFontPresetId = ref<string>('generic-monospace');
const isCustomFontMode = ref(false);

const currentFontPreset = computed(() => {
  return TERMINAL_FONT_PRESETS.find(p => p.id === selectedFontPresetId.value);
});

// 根据字体字符串智能对齐下拉预设
const syncPresetFromFontValue = (fontVal: string) => {
  const matched = findMatchingPreset(fontVal);
  if (matched) {
    selectedFontPresetId.value = matched.id;
    isCustomFontMode.value = false;
  } else if (!fontVal || fontVal.trim() === 'monospace') {
    selectedFontPresetId.value = 'generic-monospace';
    isCustomFontMode.value = false;
  } else {
    selectedFontPresetId.value = 'custom';
    isCustomFontMode.value = true;
  }
};

const editableTerminalTextStrokeEnabled = ref(false);
const editableTerminalTextStrokeWidth = ref(1);
const editableTerminalTextStrokeColor = ref('#000000');

const editableTerminalTextShadowEnabled = ref(false);
const editableTerminalTextShadowOffsetX = ref(0);
const editableTerminalTextShadowOffsetY = ref(0);
const editableTerminalTextShadowBlur = ref(0);
const editableTerminalTextShadowColor = ref('rgba(0,0,0,0.5)');
const themeSearchTerm = ref('');
const saveThemeError = ref<string | null>(null);
const editableTerminalThemeString = ref('');
const terminalThemeParseError = ref<string | null>(null);
const terminalThemePlaceholder = `background: #000000
foreground: #ffffff
cursor: #ffffff
selectionBackground: #555555
black: #000000
red: #ff0000
green: #00ff00
yellow: #ffff00
blue: #0000ff
magenta: #ff00ff
cyan: #00ffff
white: #ffffff
brightBlack: #555555
brightRed: #ff5555
brightGreen: #55ff55
brightYellow: #ffff55
brightBlue: #5555ff
brightMagenta: #ff55ff
brightCyan: #55ffff
brightWhite: #ffffff`;

const initializeEditableState = () => {
  editableTerminalFontFamily.value = currentTerminalFontFamily.value;
  syncPresetFromFontValue(editableTerminalFontFamily.value);
  editableTerminalFontSize.value = currentTerminalFontSize.value;

  editableTerminalTextStrokeEnabled.value = terminalTextStrokeEnabled.value;
  editableTerminalTextStrokeWidth.value = terminalTextStrokeWidth.value;
  editableTerminalTextStrokeColor.value = terminalTextStrokeColor.value;

  editableTerminalTextShadowEnabled.value = terminalTextShadowEnabled.value;
  editableTerminalTextShadowOffsetX.value = terminalTextShadowOffsetX.value;
  editableTerminalTextShadowOffsetY.value = terminalTextShadowOffsetY.value;
  editableTerminalTextShadowBlur.value = terminalTextShadowBlur.value;
  editableTerminalTextShadowColor.value = terminalTextShadowColor.value;

  saveThemeError.value = null;
  terminalThemeParseError.value = null;
};

// Watch for external changes to current font settings
watch(currentTerminalFontFamily, (newValue) => {
  if (!props.isEditingTheme) {
    editableTerminalFontFamily.value = newValue;
    syncPresetFromFontValue(newValue);
  }
});

watch(currentTerminalFontSize, (newValue) => {
  if (!props.isEditingTheme) {
    editableTerminalFontSize.value = newValue;
  }
});

// Initialize on mount and when relevant props change
watch(
  () => [
    currentTerminalFontFamily.value,
    currentTerminalFontSize.value,
    terminalTextStrokeEnabled.value,
    terminalTextStrokeWidth.value,
    terminalTextStrokeColor.value,
    terminalTextShadowEnabled.value,
    terminalTextShadowOffsetX.value,
    terminalTextShadowOffsetY.value,
    terminalTextShadowBlur.value,
    terminalTextShadowColor.value,
  ],
  () => {
    // Re-initialize only if not in the middle of editing a theme
    if (!props.isEditingTheme) {
      initializeEditableState();
    }
  },
  { immediate: true, deep: true }
);

// 下拉菜单选择字体预设
const handleSelectFontPreset = async (presetId: string) => {
  selectedFontPresetId.value = presetId;
  if (presetId === 'custom') {
    isCustomFontMode.value = true;
    return;
  }
  const preset = TERMINAL_FONT_PRESETS.find(p => p.id === presetId);
  if (preset) {
    editableTerminalFontFamily.value = preset.value;
    isCustomFontMode.value = false;
    await handleSaveTerminalFont();
  }
};

// 药丸快捷标签切换字体
const handleSelectQuickFontPill = async (fontValue: string) => {
  editableTerminalFontFamily.value = fontValue;
  syncPresetFromFontValue(fontValue);
  await handleSaveTerminalFont();
};

// Methods
const handleSaveTerminalFont = async () => {
  try {
    await appearanceStore.setTerminalFontFamily(editableTerminalFontFamily.value);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.terminalFontSaved') });
  } catch (error: any) {
    console.error("保存终端字体失败:", error);
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.terminalFontSaveFailed', { message: error.message }) });
  }
};

const handleSaveTerminalFontSize = async () => {
  try {
    const size = Number(editableTerminalFontSize.value);
    if (isNaN(size) || size <= 0) {
      notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.errorInvalidFontSize') });
      return;
    }
    await appearanceStore.setTerminalFontSize(size);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.terminalFontSizeSaved') });
  } catch (error: any) {
    console.error("保存终端字体大小失败:", error);
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.terminalFontSizeSaveFailed', { message: error.message }) });
  }
};

const handleSaveTerminalTextStroke = async () => {
  try {
    await appearanceStore.setTerminalTextStrokeEnabled(editableTerminalTextStrokeEnabled.value);
    await appearanceStore.setTerminalTextStrokeWidth(Number(editableTerminalTextStrokeWidth.value));
    await appearanceStore.setTerminalTextStrokeColor(editableTerminalTextStrokeColor.value);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.textStrokeSettingsSaved') });
  } catch (error: any) {
    console.error("保存文字描边设置失败:", error);
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.textStrokeSettingsSaveFailed', { message: error.message }) });
  }
};

const handleSaveTerminalTextShadow = async () => {
  try {
    await appearanceStore.setTerminalTextShadowEnabled(editableTerminalTextShadowEnabled.value);
    await appearanceStore.setTerminalTextShadowOffsetX(Number(editableTerminalTextShadowOffsetX.value));
    await appearanceStore.setTerminalTextShadowOffsetY(Number(editableTerminalTextShadowOffsetY.value));
    await appearanceStore.setTerminalTextShadowBlur(Number(editableTerminalTextShadowBlur.value));
    await appearanceStore.setTerminalTextShadowColor(editableTerminalTextShadowColor.value);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.textShadowSettingsSaved') });
  } catch (error: any) {
    console.error("保存文字阴影设置失败:", error);
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.textShadowSettingsSaveFailed', { message: error.message }) });
  }
};

const toggleTextStrokeAndSave = async () => {
  editableTerminalTextStrokeEnabled.value = !editableTerminalTextStrokeEnabled.value;
  await handleSaveTerminalTextStroke();
};

const toggleTextShadowAndSave = async () => {
  editableTerminalTextShadowEnabled.value = !editableTerminalTextShadowEnabled.value;
  await handleSaveTerminalTextShadow();
};

const handleApplyTheme = async (theme: TerminalTheme) => {
  if (!theme._id) return;
  const themeIdNum = parseInt(theme._id, 10);
  if (isNaN(themeIdNum)) {
    console.error(`无效的主题 ID 格式: ${theme._id}`);
    return;
  }
  if (themeIdNum === activeTerminalThemeId.value) return;
  try {
    await appearanceStore.setActiveTerminalTheme(theme._id);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.setActiveThemeSuccess', { themeName: theme.name }) });
  } catch (error: any) {
    console.error("应用终端主题失败:", error);
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.setActiveThemeFailed', { message: error.message }) });
  }
};

const handleAddNewTheme = () => {
  saveThemeError.value = null;
  terminalThemeParseError.value = null;
  const newTheme: TerminalTheme = {
    _id: undefined,
    name: t('styleCustomizer.newThemeDefaultName'),
    themeData: JSON.parse(JSON.stringify(defaultXtermTheme)),
    isPreset: false,
  };
  emit('update:editingTheme', newTheme);
  try {
    const themeObject = newTheme.themeData;
    if (themeObject && typeof themeObject === 'object' && Object.keys(themeObject).length > 0) {
      const lines = Object.entries(themeObject).map(([key, value]) => `${key}: ${value}`);
      editableTerminalThemeString.value = lines.join('\n');
    } else {
      editableTerminalThemeString.value = '';
    }
  } catch (e) {
    console.error("格式化新终端主题字符串失败:", e);
    editableTerminalThemeString.value = '';
  }
  emit('update:isEditingTheme', true);
};

const handleEditTheme = async (theme: TerminalTheme) => {
  saveThemeError.value = null;
  terminalThemeParseError.value = null;
  if (!theme._id) {
    console.error("尝试编辑没有 ID 的主题:", theme);
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.errorEditThemeNoId') });
    return;
  }

  let themeDataToEdit: ITheme | null = null;
  let themeNameToEdit = theme.name;
  let themeIdToEdit: string | undefined = theme._id;

  try {
    themeDataToEdit = await appearanceStore.loadTerminalThemeData(theme._id);
    if (!themeDataToEdit) {
      throw new Error(t('styleCustomizer.errorLoadThemeDataFailed'));
    }

    if (theme.isPreset) {
      themeNameToEdit = `${theme.name} (Copy)`;
      themeIdToEdit = undefined;
    }
    
    const themeToEdit: TerminalTheme = {
      _id: themeIdToEdit,
      name: themeNameToEdit,
      themeData: JSON.parse(JSON.stringify(themeDataToEdit)),
      isPreset: false,
    };
    emit('update:editingTheme', themeToEdit);

    try {
      const themeObject = themeToEdit.themeData;
      if (themeObject && typeof themeObject === 'object' && Object.keys(themeObject).length > 0) {
        const lines = Object.entries(themeObject).map(([key, value]) => `${key}: ${value}`);
        editableTerminalThemeString.value = lines.join('\n');
      } else {
        editableTerminalThemeString.value = '';
      }
    } catch (e) {
      console.error("格式化编辑终端主题字符串失败:", e);
      editableTerminalThemeString.value = '';
    }
    emit('update:isEditingTheme', true);
  } catch (error: any) {
    console.error("编辑主题失败 (加载数据时):", error);
    saveThemeError.value = error.message || t('styleCustomizer.errorEditThemeFailed');
    emit('update:isEditingTheme', false);
    emit('update:editingTheme', null);
  }
};

const handleSaveEditingTheme = async () => {
  if (!props.editingTheme || !props.editingTheme.name) {
    saveThemeError.value = t('styleCustomizer.errorThemeNameRequired');
    return;
  }
  handleTerminalThemeStringChange();
  if (terminalThemeParseError.value) {
    saveThemeError.value = t('styleCustomizer.errorFixJsonBeforeSave');
    return;
  }

  saveThemeError.value = null;
  try {
    if (!props.editingTheme) return; // Should not happen due to above check
    const currentThemeData = props.editingTheme.themeData;

    if (props.editingTheme._id) {
      const updateDto = { name: props.editingTheme.name, themeData: currentThemeData };
      await appearanceStore.updateTerminalTheme(
        props.editingTheme._id,
        updateDto.name,
        updateDto.themeData
      );
      notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.themeUpdatedSuccess') });
    } else {
      const createDto = { name: props.editingTheme.name, themeData: currentThemeData };
      await appearanceStore.createTerminalTheme(
        createDto.name,
        createDto.themeData
      );
      notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.themeCreatedSuccess') });
    }
    emit('update:isEditingTheme', false);
    emit('update:editingTheme', null);
    editableTerminalThemeString.value = '';
    terminalThemeParseError.value = null;
  } catch (error: any) {
    console.error("保存终端主题失败:", error);
    saveThemeError.value = error.message || t('styleCustomizer.themeSaveFailed');
  }
};

const handleCancelEditingTheme = () => {
  emit('update:isEditingTheme', false);
  emit('update:editingTheme', null);
  saveThemeError.value = null;
  terminalThemeParseError.value = null;
  editableTerminalThemeString.value = '';
};

const handleTerminalThemeStringChange = () => {
  terminalThemeParseError.value = null;
  if (!props.editingTheme) return;

  let inputText = editableTerminalThemeString.value.trim();
  if (!inputText) {
    const updatedTheme = { ...props.editingTheme, themeData: {} };
    emit('update:editingTheme', updatedTheme);
    return;
  }

  let jsonStringToParse = inputText
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && line.includes(':'))
    .map(line => {
      const parts = line.split(/:(.*)/s);
      if (parts.length < 2) return null;
      let key = parts[0].trim();
      let value = parts[1].trim();
      if (key.startsWith('"') && key.endsWith('"')) key = key.slice(1, -1);
      if (key.startsWith("'") && key.endsWith("'")) key = key.slice(1, -1);
      key = JSON.stringify(key);
      if (value.endsWith(',')) value = value.slice(0, -1).trim();
      let originalValue = value;
      if (value.startsWith('"') && value.endsWith('"')) originalValue = value.slice(1, -1);
      else if (value.startsWith("'") && value.endsWith("'")) originalValue = value.slice(1, -1);
      if (isNaN(Number(originalValue)) && originalValue !== 'true' && originalValue !== 'false' && originalValue !== 'null') {
        value = JSON.stringify(originalValue);
      } else {
        value = originalValue;
      }
      return `  ${key}: ${value}`;
    })
    .filter(line => line !== null)
    .join(',\n');

  const fullJsonString = `{\n${jsonStringToParse}\n}`;

  try {
    const parsedThemeData = JSON.parse(fullJsonString);
    if (typeof parsedThemeData !== 'object' || parsedThemeData === null || Array.isArray(parsedThemeData)) {
      throw new Error(t('styleCustomizer.errorInvalidJsonObject'));
    }
    const updatedTheme = { ...props.editingTheme, themeData: parsedThemeData };
    emit('update:editingTheme', updatedTheme);
  } catch (error: any) {
    console.error('解析终端主题配置失败:', error);
    let errorMessage = error.message || t('styleCustomizer.errorInvalidJsonConfig');
    if (error instanceof SyntaxError) {
      errorMessage = `${t('styleCustomizer.errorJsonSyntax')}: ${error.message}`;
    }
    terminalThemeParseError.value = errorMessage;
  }
};

const handleDeleteTheme = async (theme: TerminalTheme) => {
  if (theme.isPreset || !theme._id) return;
  try {
    await appearanceStore.deleteTerminalTheme(theme._id);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.themeDeletedSuccess') });
  } catch (error: any) {
    console.error("删除终端主题失败:", error);
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.themeDeleteFailed', { message: error.message }) });
  }
};

const formatXtermLabel = (key: keyof ITheme): string => {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase());
};

const handleFocusAndSelect = (event: FocusEvent) => {
  const target = event.target;
  if (target instanceof HTMLInputElement) {
    target.select();
  }
};


// Computed Properties
const activeThemeName = computed(() => {
  const currentIdNum = activeTerminalThemeId.value;
  if (currentIdNum === null || currentIdNum === undefined) {
    return t('styleCustomizer.noThemeSelected');
  }
  const theme = allTerminalThemes.value.find((t: TerminalTheme) => t._id === currentIdNum.toString());
  return theme ? theme.name : t('styleCustomizer.unknownTheme');
});

const filteredAndSortedThemes = computed(() => {
  const searchTerm = themeSearchTerm.value.toLowerCase().trim();
  let themes = [...allTerminalThemes.value];
  if (searchTerm) {
    themes = themes.filter((theme: TerminalTheme) => theme.name.toLowerCase().includes(searchTerm));
  }
  themes.sort((a: TerminalTheme, b: TerminalTheme) => a.name.localeCompare(b.name));
  return themes;
});

// Watchers
watch(() => props.editingTheme?.themeData, (newThemeData) => {
  if (newThemeData && (document.activeElement?.id !== 'terminalThemeTextarea' || terminalThemeParseError.value)) {
    try {
      let newStringValue = '';
      if (typeof newThemeData === 'object' && Object.keys(newThemeData).length > 0) {
        const lines = Object.entries(newThemeData).map(([key, value]) => `${key}: ${value}`);
        newStringValue = lines.join('\n');
      }
      if (newStringValue !== editableTerminalThemeString.value) {
        editableTerminalThemeString.value = newStringValue;
      }
      if (terminalThemeParseError.value && document.activeElement?.id !== 'terminalThemeTextarea') {
        terminalThemeParseError.value = null;
      }
    } catch (e) {
      console.error("格式化终端主题字符串失败 (watcher):", e);
    }
  }
}, { deep: true });

watch(() => props.isEditingTheme, (isEditing) => {
    if (isEditing && props.editingTheme) {
        // Sync editableTerminalThemeString when editing starts
        try {
            const themeObject = props.editingTheme.themeData;
            if (themeObject && typeof themeObject === 'object' && Object.keys(themeObject).length > 0) {
                const lines = Object.entries(themeObject).map(([key, value]) => `${key}: ${value}`);
                editableTerminalThemeString.value = lines.join('\n');
            } else {
                editableTerminalThemeString.value = terminalThemePlaceholder; // Or empty
            }
        } catch (e) {
            console.error("初始化编辑终端主题字符串失败:", e);
            editableTerminalThemeString.value = terminalThemePlaceholder; // Or empty
        }
        terminalThemeParseError.value = null; // Clear parse error when starting to edit
    } else if (!isEditing) {
        // Clear fields when not editing
        editableTerminalThemeString.value = '';
        terminalThemeParseError.value = null;
        saveThemeError.value = null;
        // Re-initialize font settings from store if not editing
        initializeEditableState();
    }
}, { immediate: true });


</script>

<template>
  <section v-if="!isEditingTheme">
    <h3 class="mt-0 border-b border-border pb-2 mb-4 text-lg font-semibold text-foreground">{{ t('styleCustomizer.terminalStyles') }}</h3>
    
    <!-- 终端字体设置区域 (下拉列表预设 + 快捷药丸 + 实时预览 + 自定义输入) -->
    <div class="space-y-3 mb-5 border border-border/80 rounded-xl p-3.5 bg-header/20">
      <div class="flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <label for="terminalFontSelect" class="text-foreground text-sm font-semibold flex items-center gap-1.5">
            <i class="fas fa-font text-primary text-xs"></i>
            <span>{{ t('styleCustomizer.terminalFontFamily') }}</span>
          </label>
          <button
            type="button"
            @click="isCustomFontMode = !isCustomFontMode"
            class="text-xs text-primary hover:underline flex items-center gap-1 cursor-pointer transition-colors select-none"
          >
            <i :class="isCustomFontMode ? 'fas fa-list-ul' : 'fas fa-pen-to-square'"></i>
            <span>{{ isCustomFontMode ? '返回预设列表' : '自定义输入' }}</span>
          </button>
        </div>

        <!-- 1. 下拉预设选择模式 -->
        <div v-if="!isCustomFontMode" class="flex items-center gap-2">
          <select
            id="terminalFontSelect"
            v-model="selectedFontPresetId"
            @change="handleSelectFontPreset(selectedFontPresetId)"
            class="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors cursor-pointer"
          >
            <optgroup
              v-for="cat in TERMINAL_FONT_CATEGORIES"
              :key="cat.key"
              :label="cat.label"
            >
              <option
                v-for="font in TERMINAL_FONT_PRESETS.filter(p => p.category === cat.key)"
                :key="font.id"
                :value="font.id"
              >
                {{ font.name }} - {{ font.description }}
              </option>
            </optgroup>
            <optgroup label="⚙️ 其他">
              <option value="custom">✏️ 自定义输入字体...</option>
            </optgroup>
          </select>
        </div>

        <!-- 2. 自定义输入模式 -->
        <div v-else class="flex items-center gap-2">
          <input
            type="text"
            id="terminalFontFamily"
            v-model="editableTerminalFontFamily"
            @keydown.enter.prevent="handleSaveTerminalFont"
            class="flex-1 px-3 py-2 text-sm border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary font-mono transition-colors"
            placeholder="例如：'Cascadia Code', Consolas, monospace"
          />
          <button
            type="button"
            @click="handleSaveTerminalFont"
            class="px-4 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary/90 transition-colors cursor-pointer shrink-0 shadow-2xs"
          >
            {{ t('common.save') }}
          </button>
        </div>
      </div>

      <!-- 快速切换热门字体标签 -->
      <div class="space-y-1.5 pt-0.5">
        <div class="text-[11px] text-text-secondary flex items-center justify-between">
          <span>常用推荐一键切换：</span>
          <span v-if="currentFontPreset" class="text-text-secondary/70 italic text-[11px] truncate max-w-[260px]">
            {{ currentFontPreset.description }}
          </span>
        </div>
        <div class="flex items-center gap-1.5 flex-wrap">
          <button
            v-for="pill in QUICK_FONT_PILLS"
            :key="pill.name"
            type="button"
            @click="handleSelectQuickFontPill(pill.value)"
            class="px-2.5 py-1 text-xs rounded-md border transition-all cursor-pointer font-mono"
            :class="cleanFontName(editableTerminalFontFamily).toLowerCase() === cleanFontName(pill.value).toLowerCase()
              ? 'bg-primary text-primary-foreground border-primary font-semibold shadow-2xs'
              : 'bg-header/60 text-text-secondary border-border/80 hover:text-foreground hover:bg-header'"
          >
            {{ pill.name }}
          </button>
        </div>
      </div>

      <!-- 字体效果实时预览卡片 -->
      <div
        class="p-2.5 rounded-lg border border-border/70 bg-background space-y-1.5 transition-colors"
        :style="{ fontFamily: editableTerminalFontFamily || 'monospace' }"
      >
        <div class="flex items-center justify-between text-xs text-text-secondary font-sans border-b border-border/40 pb-1">
          <span class="flex items-center gap-1.5 font-medium text-foreground">
            <i class="fas fa-eye text-primary text-[10px]"></i>
            <span>实际渲染预览：{{ currentFontPreset?.name || cleanFontName(editableTerminalFontFamily) || '系统默认' }}</span>
          </span>
          <span class="font-mono text-[10px] text-text-secondary/80 truncate max-w-[280px]">
            {{ editableTerminalFontFamily || 'monospace' }}
          </span>
        </div>
        <div class="text-xs leading-relaxed overflow-x-auto text-foreground select-all py-1">
          <div class="font-normal">
            0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz
          </div>
          <div class="text-text-secondary select-all mt-0.5 text-[11px]">
            const flag = (a != b) &amp;&amp; (x &lt;= y) &amp;&amp; (str === "hello"); // 0xDEADBEEF -&gt; =&gt;
          </div>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-[auto_1fr_auto] items-start md:items-center gap-2 md:gap-3 mb-3">
        <label for="terminalFontSize" class="text-left text-foreground text-sm font-medium overflow-hidden text-ellipsis block w-full mb-1 md:mb-0">{{ t('styleCustomizer.terminalFontSize') }}:</label>
        <input type="number" id="terminalFontSize" v-model.number="editableTerminalFontSize" class="border border-border px-[0.7rem] py-2 rounded text-sm bg-background text-foreground max-w-[100px] justify-self-start box-border transition duration-200 ease-in-out focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary" min="1" />
        <button @click="handleSaveTerminalFontSize" class="px-3 py-1.5 text-sm border border-border rounded bg-header hover:bg-border transition duration-200 ease-in-out whitespace-nowrap justify-self-start mt-1 md:mt-0">{{ t('common.save') }}</button>
    </div>

    <!-- 文字描边设置 -->
    <hr class="my-4 md:my-6">
    <h4 class="mt-6 mb-3 text-base font-semibold text-foreground">{{ t('styleCustomizer.textStrokeSettings') }}</h4>
    <div class="space-y-3 mb-3">
      <div class="flex items-center justify-between">
        <label for="terminalTextStrokeEnabledSwitch" class="text-foreground text-sm font-medium">{{ t('styleCustomizer.enableTextStroke') }}</label>
        <button
          type="button"
          id="terminalTextStrokeEnabledSwitch"
          @click="toggleTextStrokeAndSave"
          :class="[
            'relative inline-flex flex-shrink-0 h-6 w-11 border-2 border-transparent rounded-full cursor-pointer transition-colors ease-in-out duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary',
            editableTerminalTextStrokeEnabled ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
          ]"
          role="switch"
          :aria-checked="editableTerminalTextStrokeEnabled"
        >
          <span
            aria-hidden="true"
            :class="[
              'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform ring-0 transition ease-in-out duration-200',
              editableTerminalTextStrokeEnabled ? 'translate-x-5' : 'translate-x-0'
            ]"
          ></span>
        </button>
      </div>

      <div class="space-y-3">
        <div class="grid grid-cols-1 md:grid-cols-[auto_1fr] items-center gap-2">
          <label for="terminalTextStrokeWidth" class="text-left text-foreground text-sm font-medium">{{ t('styleCustomizer.textStrokeWidth') }}:</label>
          <input type="number" id="terminalTextStrokeWidth" v-model.number="editableTerminalTextStrokeWidth" min="0" step="0.1" class="border border-border px-[0.7rem] py-2 rounded text-sm bg-background text-foreground max-w-[100px] justify-self-start box-border">
        </div>
        <div class="grid grid-cols-1 md:grid-cols-[auto_1fr] items-center gap-2">
          <label for="terminalTextStrokeColor" class="text-left text-foreground text-sm font-medium">{{ t('styleCustomizer.textStrokeColor') }}:</label>
          <div class="flex items-center gap-2">
            <input type="color" id="terminalTextStrokeColor" v-model.lazy="editableTerminalTextStrokeColor" class="p-0.5 h-[34px] min-w-[40px] max-w-[50px] rounded border border-border flex-shrink-0">
            <input type="text" :value="editableTerminalTextStrokeColor" @input="editableTerminalTextStrokeColor = ($event.target as HTMLInputElement).value" class="flex-grow min-w-[80px] bg-header border border-border px-[0.7rem] py-2 rounded text-sm text-foreground box-border">
          </div>
        </div>
      </div>
      <div class="flex justify-start mt-2">
        <button @click="handleSaveTerminalTextStroke" class="px-3 py-1.5 text-sm border border-border rounded bg-header hover:bg-border transition duration-200 ease-in-out whitespace-nowrap">{{ t('common.save') }}</button>
      </div>
    </div>

    <!-- 文字阴影设置 -->
    <hr class="my-4 md:my-6">
    <h4 class="mt-6 mb-3 text-base font-semibold text-foreground">{{ t('styleCustomizer.textShadowSettings') }}</h4>
    <div class="space-y-3 mb-3">
      <div class="flex items-center justify-between">
        <label for="terminalTextShadowEnabledSwitch" class="text-foreground text-sm font-medium">{{ t('styleCustomizer.enableTextShadow') }}</label>
        <button
          type="button"
          id="terminalTextShadowEnabledSwitch"
          @click="toggleTextShadowAndSave"
          :class="[
            'relative inline-flex flex-shrink-0 h-6 w-11 border-2 border-transparent rounded-full cursor-pointer transition-colors ease-in-out duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary',
            editableTerminalTextShadowEnabled ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
          ]"
          role="switch"
          :aria-checked="editableTerminalTextShadowEnabled"
        >
          <span
            aria-hidden="true"
            :class="[
              'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform ring-0 transition ease-in-out duration-200',
              editableTerminalTextShadowEnabled ? 'translate-x-5' : 'translate-x-0'
            ]"
          ></span>
        </button>
      </div>

      <div class="space-y-3">
        <div class="grid grid-cols-1 md:grid-cols-[auto_1fr] items-center gap-2">
          <label for="terminalTextShadowOffsetX" class="text-left text-foreground text-sm font-medium">{{ t('styleCustomizer.textShadowOffsetX') }}:</label>
          <input type="number" id="terminalTextShadowOffsetX" v-model.number="editableTerminalTextShadowOffsetX" step="0.1" class="border border-border px-[0.7rem] py-2 rounded text-sm bg-background text-foreground max-w-[100px] justify-self-start box-border">
        </div>
        <div class="grid grid-cols-1 md:grid-cols-[auto_1fr] items-center gap-2">
          <label for="terminalTextShadowOffsetY" class="text-left text-foreground text-sm font-medium">{{ t('styleCustomizer.textShadowOffsetY') }}:</label>
          <input type="number" id="terminalTextShadowOffsetY" v-model.number="editableTerminalTextShadowOffsetY" step="0.1" class="border border-border px-[0.7rem] py-2 rounded text-sm bg-background text-foreground max-w-[100px] justify-self-start box-border">
        </div>
        <div class="grid grid-cols-1 md:grid-cols-[auto_1fr] items-center gap-2">
          <label for="terminalTextShadowBlur" class="text-left text-foreground text-sm font-medium">{{ t('styleCustomizer.textShadowBlur') }}:</label>
          <input type="number" id="terminalTextShadowBlur" v-model.number="editableTerminalTextShadowBlur" min="0" step="0.1" class="border border-border px-[0.7rem] py-2 rounded text-sm bg-background text-foreground max-w-[100px] justify-self-start box-border">
        </div>
        <div class="grid grid-cols-1 md:grid-cols-[auto_1fr] items-center gap-2">
          <label for="terminalTextShadowColor" class="text-left text-foreground text-sm font-medium">{{ t('styleCustomizer.textShadowColor') }}:</label>
          <div class="flex items-center gap-2">
            <input type="color" id="terminalTextShadowColor" v-model.lazy="editableTerminalTextShadowColor" class="p-0.5 h-[34px] min-w-[40px] max-w-[50px] rounded border border-border flex-shrink-0">
            <input type="text" :value="editableTerminalTextShadowColor" @input="editableTerminalTextShadowColor = ($event.target as HTMLInputElement).value" class="flex-grow min-w-[80px] bg-header border border-border px-[0.7rem] py-2 rounded text-sm text-foreground box-border">
          </div>
        </div>
      </div>
       <div class="flex justify-start mt-2">
        <button @click="handleSaveTerminalTextShadow" class="px-3 py-1.5 text-sm border border-border rounded bg-header hover:bg-border transition duration-200 ease-in-out whitespace-nowrap">{{ t('common.save') }}</button>
      </div>
    </div>

    <hr class="my-4 md:my-6">

    <h4 class="mt-6 mb-2 text-base font-semibold text-foreground">{{ t('styleCustomizer.terminalThemeSelection') }}</h4>
     
     <div class="mb-4 py-2 text-sm md:text-[0.95rem] flex flex-col md:flex-row items-start md:items-center gap-1 md:gap-3"> 
         <span class="text-text-secondary">{{ t('styleCustomizer.activeTheme') }}:</span>
         <strong class="text-foreground font-semibold">{{ activeThemeName }}</strong>
    </div>

    <div class="mt-4 mb-6 flex gap-2 flex-wrap items-center pb-4 border-b border-dashed border-border">
        <button @click="handleAddNewTheme" class="px-3 py-1.5 text-sm border border-border rounded bg-header hover:bg-border transition duration-200 ease-in-out whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed">{{ t('styleCustomizer.addNewTheme') }}</button>
    </div>
     
     <div class="mb-4">
          <input
              type="text"
              v-model="themeSearchTerm"
              :placeholder="t('styleCustomizer.searchThemePlaceholder', '搜索主题名称...')"
              class="border border-border px-[0.7rem] py-2 rounded text-sm bg-background text-foreground w-full box-border transition duration-200 ease-in-out focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
     </div>

     <ul class="list-none p-0 mt-4 max-h-[200px] md:max-h-[280px] overflow-y-auto border border-border rounded bg-background"> 
         <li v-if="filteredAndSortedThemes.length === 0" class="text-center text-text-secondary p-4 italic">
             {{ t('styleCustomizer.noThemesFound', 'No matching themes found') }}
         </li>
         <li v-else v-for="(theme, index) in filteredAndSortedThemes" :key="theme._id"
            :class="[
              'block md:grid md:grid-cols-[1fr_auto] items-center px-3 py-2.5 text-sm md:text-[0.95rem] transition-colors duration-200 ease-in-out gap-2',
              index < filteredAndSortedThemes.length - 1 ? 'border-b border-border' : '',
              { 'bg-button text-button-text': theme._id === activeTerminalThemeId?.toString() },
              { 'hover:bg-header': theme._id !== activeTerminalThemeId?.toString() }
            ]"
         >
             <span class="block md:col-start-1 md:col-end-2 overflow-hidden text-ellipsis whitespace-nowrap mb-2 md:mb-0" :class="theme._id === activeTerminalThemeId?.toString() ? 'font-bold text-button-text' : 'text-foreground'" :title="theme.name">{{ theme.name }}</span>
             <div class="flex md:col-start-2 md:col-end-3 flex-shrink-0 gap-2 justify-start md:justify-end flex-wrap"> 
                  <button
                      @click="handleApplyTheme(theme)"
                      :disabled="theme._id === activeTerminalThemeId?.toString()"
                      :title="t('styleCustomizer.applyThemeTooltip', 'Apply this theme')"
                      :class="[
                        'px-3 py-1.5 text-xs md:text-sm border rounded transition-colors duration-200 ease-in-out whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed',
                        theme._id === activeTerminalThemeId?.toString() ? 'text-button-text border-white/30 bg-white/10 hover:bg-white/20 hover:border-white/50 disabled:opacity-50 disabled:cursor-default disabled:bg-transparent disabled:border-transparent' : 'border-border bg-header text-foreground hover:bg-border hover:border-text-secondary'
                      ]"
                  >
                      {{ t('styleCustomizer.applyButton', 'Apply') }}
                 </button>
                <button @click="handleEditTheme(theme)" :title="theme.isPreset ? t('styleCustomizer.editAsCopy', 'Edit as Copy') : t('common.edit')"
                   :class="[
                     'px-3 py-1.5 text-xs md:text-sm border rounded transition-colors duration-200 ease-in-out whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed',
                     theme._id === activeTerminalThemeId?.toString() ? 'text-button-text border-white/30 bg-white/10 hover:bg-white/20 hover:border-white/50' : 'border-border bg-header text-foreground hover:bg-border hover:border-text-secondary'
                   ]"
                >{{ t('common.edit') }}</button>
                <button @click="handleDeleteTheme(theme)" :disabled="theme.isPreset" :title="theme.isPreset ? t('styleCustomizer.cannotDeletePreset', 'Cannot delete preset theme') : t('common.delete')"
                   :class="[
                     'px-3 py-1.5 text-xs md:text-sm border rounded transition-colors duration-200 ease-in-out whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed',
                     theme._id === activeTerminalThemeId?.toString() ? 'text-button-text border-white/30 bg-white/10 hover:bg-white/20 hover:border-white/50' : 'bg-error/10 text-error border-error/30 hover:bg-error/20'
                   ]"
                >{{ t('common.delete') }}</button>
             </div>
         </li>
     </ul>
  </section>

  <section v-if="isEditingTheme && editingTheme">
      <h3 class="mt-0 border-b border-border pb-2 mb-4 text-lg font-semibold text-foreground">{{ editingTheme._id ? t('styleCustomizer.editThemeTitle') : t('styleCustomizer.newThemeTitle') }}</h3>
       <p v-if="saveThemeError" class="text-error-text bg-error/10 border border-error/30 px-3 py-2 rounded text-sm mb-3">{{ saveThemeError }}</p>
      <div class="grid grid-cols-1 md:grid-cols-[auto_1fr] items-start md:items-center gap-2 mb-2">
          <label for="editingThemeName" class="text-left text-foreground text-sm font-medium overflow-hidden text-ellipsis block w-full mb-1 md:mb-0">{{ t('styleCustomizer.themeName') }}:</label>
          <input type="text" id="editingThemeName" v-model="editingTheme.name" required class="border border-border px-[0.7rem] py-2 rounded text-sm bg-background text-foreground w-full box-border transition duration-200 ease-in-out focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary" />
      </div>

       <hr class="my-4 md:my-8 border-border">
       <h4 class="mt-6 mb-2 text-base font-semibold text-foreground">{{ t('styleCustomizer.terminalThemeColorEditorTitle') }}</h4>

    <div v-for="(value, key) in editingTheme.themeData" :key="key" class="grid grid-cols-1 md:grid-cols-[auto_1fr] items-start md:items-center gap-2 mb-2">
      <label :for="`xterm-${key}`" class="text-left text-foreground text-sm font-medium overflow-hidden text-ellipsis block w-full mb-1 md:mb-0">{{ formatXtermLabel(key as keyof ITheme) }}:</label>
      <div class="flex items-center gap-2 w-full">
        <input
          v-if="typeof value === 'string' && value.startsWith('#')"
          type="color"
          :id="`xterm-${key}`"
          v-model.lazy="(editingTheme.themeData as any)[key]"
          class="p-0.5 h-[34px] min-w-[40px] max-w-[50px] rounded border border-border flex-shrink-0 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
        />
        <input
          v-if="typeof value === 'string' && value.startsWith('#')"
          type="text"
          :value="(editingTheme.themeData as any)[key]"
          readonly
          class="flex-grow min-w-[80px] bg-header cursor-text border border-border px-[0.7rem] py-2 rounded text-sm text-foreground w-full box-border transition duration-200 ease-in-out focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          @focus="handleFocusAndSelect"
        />
        <input
          v-else
          type="text"
          :id="`xterm-${key}`"
          v-model="(editingTheme.themeData as any)[key]"
          class="border border-border px-[0.7rem] py-2 rounded text-sm bg-background text-foreground w-full box-border transition duration-200 ease-in-out focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
   </div>

      <hr class="my-4 md:my-8 border-border">
      <h4 class="mt-6 mb-2 text-base font-semibold text-foreground">{{ t('styleCustomizer.terminalThemeJsonEditorTitle') }}</h4>
      <p class="text-text-secondary text-sm leading-relaxed mb-3">{{ t('styleCustomizer.terminalThemeJsonEditorDesc') }}</p>
      <div class="mt-4">
         <label for="terminalThemeTextarea" class="sr-only">{{ t('styleCustomizer.terminalThemeJsonEditorTitle') }}</label>
         <textarea
           id="terminalThemeTextarea"
           v-model="editableTerminalThemeString"
           @blur="handleTerminalThemeStringChange"
           rows="10"
           :placeholder="terminalThemePlaceholder"
           spellcheck="false"
           class="w-full font-mono text-sm leading-snug border border-border rounded p-3 bg-background text-foreground resize-y min-h-[150px] md:min-h-[200px] box-border whitespace-pre-wrap break-words transition duration-200 ease-in-out focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
         ></textarea>
      </div>
       <p v-if="terminalThemeParseError" class="text-error-text bg-error/10 border border-error/30 px-3 py-2 rounded text-sm mt-2">{{ terminalThemeParseError }}</p>
  <div class="mt-4 flex justify-end gap-2 pt-4 border-t border-border">
       <button @click="handleCancelEditingTheme" class="px-4 md:px-5 py-2 rounded font-bold border border-border bg-header text-foreground hover:bg-border disabled:opacity-60 disabled:cursor-not-allowed text-sm md:text-base">{{ t('common.cancel') }}</button> 
       <button @click="handleSaveEditingTheme" class="px-4 md:px-5 py-2 rounded font-bold border border-button bg-button text-button-text hover:bg-button-hover hover:border-button-hover disabled:opacity-60 disabled:cursor-not-allowed text-sm md:text-base">{{ t('common.save') }}</button> 
   </div>
  </section>
</template>