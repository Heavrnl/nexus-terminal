<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppearanceStore } from '../../../stores/appearance.store';
import { useUiNotificationsStore } from '../../../stores/uiNotifications.store';
import { storeToRefs } from 'pinia';
import type { TerminalTheme } from '../../../types/terminal-theme.types';

const { t } = useI18n();
const appearanceStore = useAppearanceStore();
const notificationsStore = useUiNotificationsStore();

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

import {
  TERMINAL_FONT_PRESETS,
  TERMINAL_FONT_CATEGORIES,
  QUICK_FONT_PILLS,
  findMatchingPreset,
  cleanFontName,
} from '../../../constants/terminalFonts';

// 本地状态
const editableTerminalFontFamily = ref('');
const editableTerminalFontSize = ref(14);
const themeSearchTerm = ref('');
const showAdvancedEffects = ref(false);

const editableTerminalTextStrokeEnabled = ref(false);
const editableTerminalTextStrokeWidth = ref(1);
const editableTerminalTextStrokeColor = ref('#000000');

const editableTerminalTextShadowEnabled = ref(false);
const editableTerminalTextShadowBlur = ref(0);
const editableTerminalTextShadowColor = ref('rgba(0,0,0,0.5)');

// 下拉预设选择状态
const selectedFontPresetId = ref<string>('generic-monospace');

// 默认内置等宽字体预设 (引用全量常量预设值)
const DEFAULT_PRESET_FONTS = TERMINAL_FONT_PRESETS.map(p => p.value);

const STORAGE_KEY_CUSTOM_TERMINAL_FONTS = 'nexus_mobile_custom_terminal_fonts';

// 自定义字体列表与添加卡片状态
const customFonts = ref<string[]>([]);
const showAddFontInput = ref(false);
const newFontName = ref('');

const loadCustomFonts = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CUSTOM_TERMINAL_FONTS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        customFonts.value = parsed.filter(f => typeof f === 'string' && f.trim());
      }
    }
  } catch (e) {
    console.error('读取自定义终端字体失败:', e);
  }
};

const saveCustomFonts = () => {
  try {
    localStorage.setItem(STORAGE_KEY_CUSTOM_TERMINAL_FONTS, JSON.stringify(customFonts.value));
  } catch (e) {
    console.error('存储自定义终端字体失败:', e);
  }
};

const isCustomFont = (font: string) => {
  return customFonts.value.includes(font) && !DEFAULT_PRESET_FONTS.includes(font);
};

// 合并内置预设、自定义字体和当前字体
const allAvailableFonts = computed(() => {
  const result: string[] = [...DEFAULT_PRESET_FONTS];
  customFonts.value.forEach(f => {
    if (!result.includes(f)) {
      result.push(f);
    }
  });
  const cur = editableTerminalFontFamily.value?.trim();
  if (cur && !result.includes(cur)) {
    result.push(cur);
  }
  return result;
});

const syncPresetFromFontValue = (fontVal: string) => {
  const matched = findMatchingPreset(fontVal);
  if (matched) {
    selectedFontPresetId.value = matched.id;
  } else if (!fontVal || fontVal.trim() === 'monospace') {
    selectedFontPresetId.value = 'generic-monospace';
  } else {
    selectedFontPresetId.value = 'custom';
  }
};

const initializeState = () => {
  loadCustomFonts();
  editableTerminalFontFamily.value = currentTerminalFontFamily.value;
  syncPresetFromFontValue(editableTerminalFontFamily.value);
  editableTerminalFontSize.value = currentTerminalFontSize.value;
  editableTerminalTextStrokeEnabled.value = terminalTextStrokeEnabled.value;
  editableTerminalTextStrokeWidth.value = terminalTextStrokeWidth.value;
  editableTerminalTextStrokeColor.value = terminalTextStrokeColor.value;
  editableTerminalTextShadowEnabled.value = terminalTextShadowEnabled.value;
  editableTerminalTextShadowBlur.value = terminalTextShadowBlur.value;
  editableTerminalTextShadowColor.value = terminalTextShadowColor.value;
};

initializeState();

watch(currentTerminalFontSize, val => { editableTerminalFontSize.value = val; });
watch(currentTerminalFontFamily, val => {
  editableTerminalFontFamily.value = val;
  syncPresetFromFontValue(val);
});

// 字体大小增减步进器
const changeFontSize = async (delta: number) => {
  const newSize = Math.max(9, Math.min(28, editableTerminalFontSize.value + delta));
  editableTerminalFontSize.value = newSize;
  try {
    await appearanceStore.setTerminalFontSize(newSize);
  } catch (err: any) {
    notificationsStore.addNotification({ type: 'error', message: err.message || '更新字号失败' });
  }
};

// 选择预设或已有字体
const selectFont = async (font: string) => {
  editableTerminalFontFamily.value = font;
  syncPresetFromFontValue(font);
  try {
    await appearanceStore.setTerminalFontFamily(font);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.terminalFontSaved', '终端字体已更新') });
  } catch (err: any) {
    notificationsStore.addNotification({ type: 'error', message: err.message || '更新字体失败' });
  }
};

// 下拉菜单选择字体预设
const handleSelectPreset = async (presetId: string) => {
  selectedFontPresetId.value = presetId;
  if (presetId === 'custom') {
    return;
  }
  const preset = TERMINAL_FONT_PRESETS.find(p => p.id === presetId);
  if (preset) {
    await selectFont(preset.value);
  }
};

// 应用当前输入框中的自定义字体
const handleApplyCustomFont = async () => {
  const font = editableTerminalFontFamily.value.trim();
  if (!font) {
    notificationsStore.addNotification({ type: 'warning', message: '请输入有效的字体名称' });
    return;
  }
  if (!DEFAULT_PRESET_FONTS.includes(font) && !customFonts.value.includes(font)) {
    customFonts.value.push(font);
    saveCustomFonts();
  }
  try {
    await appearanceStore.setTerminalFontFamily(font);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.terminalFontSaved', '终端字体已更新') });
  } catch (err: any) {
    notificationsStore.addNotification({ type: 'error', message: err.message || '更新字体失败' });
  }
};

// 专门新增字体并保存应用
const handleAddCustomFont = async () => {
  const font = newFontName.value.trim();
  if (!font) {
    notificationsStore.addNotification({ type: 'warning', message: '请输入字体名称' });
    return;
  }
  if (!customFonts.value.includes(font) && !DEFAULT_PRESET_FONTS.includes(font)) {
    customFonts.value.push(font);
    saveCustomFonts();
  }
  newFontName.value = '';
  showAddFontInput.value = false;
  await selectFont(font);
};

// 移除用户自定义字体
const removeCustomFont = (font: string) => {
  customFonts.value = customFonts.value.filter(f => f !== font);
  saveCustomFonts();
  notificationsStore.addNotification({ type: 'info', message: '已移除该自定义字体' });
};

// 过滤后的主题清单
const filteredThemes = computed(() => {
  const q = themeSearchTerm.value.trim().toLowerCase();
  if (!q) return allTerminalThemes.value;
  return allTerminalThemes.value.filter(th => th.name.toLowerCase().includes(q));
});

// 应用主题
const handleApplyTheme = async (theme: TerminalTheme) => {
  if (!theme._id) return;
  const themeIdNum = parseInt(theme._id, 10);
  if (isNaN(themeIdNum) || themeIdNum === activeTerminalThemeId.value) return;

  try {
    await appearanceStore.setActiveTerminalTheme(theme._id);
    notificationsStore.addNotification({
      type: 'success',
      message: t('styleCustomizer.setActiveThemeSuccess', { themeName: theme.name })
    });
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: error.message || '应用主题失败' });
  }
};

// 保存特效设置
const updateStroke = async () => {
  try {
    await appearanceStore.setTerminalTextStrokeEnabled(editableTerminalTextStrokeEnabled.value);
    await appearanceStore.setTerminalTextStrokeWidth(Number(editableTerminalTextStrokeWidth.value));
    await appearanceStore.setTerminalTextStrokeColor(editableTerminalTextStrokeColor.value);
  } catch (e: any) {
    console.error(e);
  }
};

const updateShadow = async () => {
  try {
    await appearanceStore.setTerminalTextShadowEnabled(editableTerminalTextShadowEnabled.value);
    await appearanceStore.setTerminalTextShadowBlur(Number(editableTerminalTextShadowBlur.value));
    await appearanceStore.setTerminalTextShadowColor(editableTerminalTextShadowColor.value);
  } catch (e: any) {
    console.error(e);
  }
};
</script>

<template>
  <div class="mobile-terminal-tab space-y-4 text-foreground">
    <!-- 1. 终端字体与字号调节卡片 -->
    <div class="space-y-1.5">
      <div class="text-xs font-semibold text-text-secondary px-0.5">字体与显示尺寸</div>
      <div class="bg-header/30 border border-border/50 rounded-2xl p-3.5 space-y-3">
        <!-- 字号调节行 -->
        <div class="flex items-center justify-between">
          <div>
            <div class="text-xs font-medium text-foreground">终端字号大小</div>
            <div class="text-[10px] text-text-secondary/60">当前：{{ editableTerminalFontSize }}px</div>
          </div>

          <!-- 步进按钮器 -->
          <div class="flex items-center gap-2 bg-background border border-border/60 rounded-xl p-1 shadow-2xs">
            <button
              type="button"
              @click="changeFontSize(-1)"
              :disabled="editableTerminalFontSize <= 9"
              class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-header/80 active:scale-95 text-xs text-foreground disabled:opacity-40 cursor-pointer"
            >
              <i class="fas fa-minus"></i>
            </button>
            <span class="w-8 text-center font-mono font-semibold text-xs text-foreground">{{ editableTerminalFontSize }}</span>
            <button
              type="button"
              @click="changeFontSize(1)"
              :disabled="editableTerminalFontSize >= 28"
              class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-header/80 active:scale-95 text-xs text-foreground disabled:opacity-40 cursor-pointer"
            >
              <i class="fas fa-plus"></i>
            </button>
          </div>
        </div>

        <!-- 字体族预设选择与自定义添加行 -->
        <div class="space-y-2.5 pt-2 border-t border-border/30">
          <div class="flex items-center justify-between">
            <span class="text-[11px] text-text-secondary/80 font-medium">终端字体族 (Font Family)</span>
            <button
              v-if="!showAddFontInput"
              type="button"
              @click="showAddFontInput = true"
              class="text-[11px] text-primary hover:underline flex items-center gap-1 cursor-pointer font-medium"
            >
              <i class="fas fa-plus text-[10px]"></i>
              <span>添加字体</span>
            </button>
          </div>

          <!-- 预设下拉选择器 -->
          <div class="space-y-1">
            <div class="text-[10px] text-text-secondary/70">精选字体下拉选择：</div>
            <select
              id="mobileTerminalFontSelect"
              v-model="selectedFontPresetId"
              @change="handleSelectPreset(selectedFontPresetId)"
              class="w-full px-2.5 py-1.5 text-xs rounded-xl bg-background border border-border/70 text-foreground font-mono focus:outline-none focus:border-primary transition-colors cursor-pointer"
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

          <!-- 自定义输入并保存应用 -->
          <div class="space-y-1">
            <div class="text-[10px] text-text-secondary/70">当前生效 CSS 字体值：</div>
            <div class="flex items-center gap-2">
              <input
                type="text"
                v-model="editableTerminalFontFamily"
                @keydown.enter.prevent="handleApplyCustomFont"
                placeholder="如 'JetBrains Mono', Consolas, monospace"
                class="flex-grow min-w-0 px-2.5 py-1.5 text-xs rounded-xl bg-background border border-border/70 text-foreground font-mono focus:outline-none focus:border-primary transition-colors"
              />
              <button
                type="button"
                @click="handleApplyCustomFont"
                class="px-3 py-1.5 text-xs font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95 transition-all shrink-0 cursor-pointer shadow-2xs"
              >
                应用
              </button>
            </div>
          </div>

          <!-- 新增自定义字体快捷输入卡片 -->
          <div v-if="showAddFontInput" class="p-2.5 rounded-xl bg-background border border-primary/40 space-y-2 shadow-2xs">
            <div class="flex items-center justify-between">
              <span class="text-[11px] text-primary font-semibold">添加常用字体至列表</span>
              <button
                type="button"
                @click="showAddFontInput = false"
                class="w-5 h-5 flex items-center justify-center text-text-secondary hover:text-foreground text-xs rounded-md cursor-pointer"
              >
                <i class="fas fa-times"></i>
              </button>
            </div>
            <div class="flex items-center gap-2">
              <input
                type="text"
                v-model="newFontName"
                @keydown.enter.prevent="handleAddCustomFont"
                placeholder="字体名称，例如：'Cascadia Code'"
                class="flex-grow min-w-0 px-2.5 py-1.5 text-xs rounded-lg bg-header/60 border border-border/70 text-foreground font-mono focus:outline-none focus:border-primary"
              />
              <button
                type="button"
                @click="handleAddCustomFont"
                class="px-3 py-1.5 text-xs font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95 shrink-0 cursor-pointer shadow-2xs"
              >
                添加并应用
              </button>
            </div>
          </div>

          <!-- 实际渲染效果预览卡片 -->
          <div
            class="p-2.5 rounded-xl border border-border/70 bg-background space-y-1 transition-colors"
            :style="{ fontFamily: editableTerminalFontFamily || 'monospace' }"
          >
            <div class="flex items-center justify-between text-[11px] text-text-secondary font-sans border-b border-border/40 pb-1">
              <span class="flex items-center gap-1 font-medium text-foreground">
                <i class="fas fa-eye text-primary text-[10px]"></i>
                <span>效果预览 ({{ cleanFontName(editableTerminalFontFamily) || '默认' }})</span>
              </span>
            </div>
            <div class="text-[11px] leading-relaxed text-foreground font-normal select-all pt-0.5">
              0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ
            </div>
            <div class="text-[10px] text-text-secondary select-all">
              a != b &amp;&amp; x &lt;= y -&gt; =&gt;
            </div>
          </div>
        </div>

        <!-- 字体预设与自定义标签选择行 -->
        <div class="space-y-1.5 pt-1">
          <div class="text-[11px] text-text-secondary/70">快速切换字体：</div>
          <div class="flex items-center gap-1.5 flex-wrap">
            <div
              v-for="font in allAvailableFonts"
              :key="font"
              class="inline-flex items-center rounded-lg border font-mono text-[11px] transition-colors overflow-hidden"
              :class="editableTerminalFontFamily === font
                ? 'bg-primary border-primary text-primary-foreground font-semibold shadow-2xs'
                : 'bg-background border-border/60 text-text-secondary hover:text-foreground'"
            >
              <button
                type="button"
                @click="selectFont(font)"
                class="px-2.5 py-1 cursor-pointer truncate max-w-[150px]"
                :style="{ fontFamily: font }"
              >
                {{ font.replace(/"/g, '') }}
              </button>
              <button
                v-if="isCustomFont(font)"
                type="button"
                @click.stop="removeCustomFont(font)"
                class="pr-2 pl-0.5 py-1 text-[10px] hover:text-red-400 opacity-70 hover:opacity-100 transition-opacity cursor-pointer"
                title="删除该自定义字体"
              >
                <i class="fas fa-times"></i>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 2. 终端色彩主题切换卡片流 -->
    <div class="space-y-2">
      <div class="flex items-center justify-between px-0.5">
        <div class="text-xs font-semibold text-text-secondary">终端配色方案</div>
        <span class="text-[10px] text-text-secondary/60">共 {{ allTerminalThemes.length }} 款主题</span>
      </div>

      <!-- 搜索栏 -->
      <div class="relative w-full">
        <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-xs text-text-secondary/60 pointer-events-none"></i>
        <input
          type="text"
          v-model="themeSearchTerm"
          placeholder="搜索配色主题 (如 Dracula, Nord...)"
          class="w-full h-8.5 pl-8.5 pr-8 text-xs bg-header/30 border border-border/60 rounded-xl text-foreground placeholder:text-text-secondary/40 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors font-mono shadow-2xs"
        />
        <button
          v-if="themeSearchTerm"
          @click="themeSearchTerm = ''"
          class="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-secondary hover:text-foreground text-xs p-0.5 cursor-pointer"
        >
          <i class="fas fa-times-circle"></i>
        </button>
      </div>

      <!-- 主题列表 (单列卡片) -->
      <div class="space-y-2 max-h-[320px] overflow-y-auto overscroll-contain pr-1 custom-scrollbar">
        <div
          v-for="theme in filteredThemes"
          :key="theme._id"
          @click="handleApplyTheme(theme)"
          class="p-3 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-3 active:scale-98"
          :class="String(theme._id) === String(activeTerminalThemeId)
            ? 'bg-primary/10 border-primary shadow-xs ring-1 ring-primary/40'
            : 'bg-header/20 border-border/50 hover:bg-header/40 hover:border-border'"
        >
          <!-- 主题名与激活标志 -->
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="text-xs font-semibold text-foreground truncate">{{ theme.name }}</span>
              <span
                v-if="String(theme._id) === String(activeTerminalThemeId)"
                class="px-1.5 py-0.2 rounded-full text-[9px] font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
              >
                当前使用
              </span>
            </div>
            <div class="text-[10px] text-text-secondary/60 truncate mt-0.5 font-mono">
              bg: {{ theme.themeData?.background || '#000' }} | fg: {{ theme.themeData?.foreground || '#fff' }}
            </div>
          </div>

          <!-- 色块小调色盘预览 -->
          <div class="flex items-center gap-1 shrink-0 bg-background/80 p-1 rounded-lg border border-border/40">
            <div
              v-for="colorKey in ['background', 'foreground', 'red', 'green', 'blue', 'cyan']"
              :key="colorKey"
              class="w-3.5 h-3.5 rounded-sm border border-black/10 shrink-0"
              :style="{ backgroundColor: (theme.themeData as any)?.[colorKey] || '#888' }"
            ></div>
          </div>
        </div>

        <div v-if="filteredThemes.length === 0" class="py-8 text-center text-xs text-text-secondary/60">
          未找到匹配的终端主题
        </div>
      </div>
    </div>

    <!-- 3. 高级文字特效 (折叠卡片) -->
    <div class="border border-border/50 rounded-2xl bg-header/20 overflow-hidden">
      <button
        type="button"
        @click="showAdvancedEffects = !showAdvancedEffects"
        class="w-full flex items-center justify-between px-3.5 py-3 text-xs font-medium text-text-secondary hover:text-foreground cursor-pointer"
      >
        <span class="flex items-center gap-1.5">
          <i class="fas fa-magic text-xs text-primary/70"></i>
          <span>文字描边与发光阴影特效</span>
        </span>
        <i :class="['fas text-xs transition-transform', showAdvancedEffects ? 'fa-chevron-up' : 'fa-chevron-down']"></i>
      </button>

      <div v-show="showAdvancedEffects" class="px-3.5 pb-3.5 space-y-3.5 border-t border-border/30 pt-3">
        <!-- 描边 -->
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-foreground">文字描边</span>
            <input
              type="checkbox"
              v-model="editableTerminalTextStrokeEnabled"
              @change="updateStroke"
              class="rounded text-primary focus:ring-primary w-4 h-4 cursor-pointer"
            />
          </div>
          <div v-if="editableTerminalTextStrokeEnabled" class="flex items-center gap-2">
            <input
              type="range"
              min="1"
              max="5"
              v-model.number="editableTerminalTextStrokeWidth"
              @change="updateStroke"
              class="flex-1 accent-primary h-1.5 cursor-pointer"
            />
            <span class="text-xs font-mono w-6">{{ editableTerminalTextStrokeWidth }}px</span>
            <input
              type="color"
              v-model="editableTerminalTextStrokeColor"
              @change="updateStroke"
              class="w-7 h-7 rounded border border-border p-0.5 cursor-pointer"
            />
          </div>
        </div>

        <!-- 阴影 -->
        <div class="space-y-2 pt-2 border-t border-border/20">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-foreground">文字阴影 / 辉光</span>
            <input
              type="checkbox"
              v-model="editableTerminalTextShadowEnabled"
              @change="updateShadow"
              class="rounded text-primary focus:ring-primary w-4 h-4 cursor-pointer"
            />
          </div>
          <div v-if="editableTerminalTextShadowEnabled" class="flex items-center gap-2">
            <input
              type="range"
              min="1"
              max="15"
              v-model.number="editableTerminalTextShadowBlur"
              @change="updateShadow"
              class="flex-1 accent-primary h-1.5 cursor-pointer"
            />
            <span class="text-xs font-mono w-6">{{ editableTerminalTextShadowBlur }}px</span>
            <input
              type="color"
              v-model="editableTerminalTextShadowColor"
              @change="updateShadow"
              class="w-7 h-7 rounded border border-border p-0.5 cursor-pointer"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
