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

// 常见移动端终端优质等宽字体
const COMMON_FONTS = [
  'monospace',
  'Consolas',
  '"Fira Code"',
  '"JetBrains Mono"',
  '"Courier New"',
];

const initializeState = () => {
  editableTerminalFontFamily.value = currentTerminalFontFamily.value;
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
watch(currentTerminalFontFamily, val => { editableTerminalFontFamily.value = val; });

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

// 选择预设字体
const selectFont = async (font: string) => {
  editableTerminalFontFamily.value = font;
  try {
    await appearanceStore.setTerminalFontFamily(font);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.terminalFontSaved', '终端字体已更新') });
  } catch (err: any) {
    notificationsStore.addNotification({ type: 'error', message: err.message || '更新字体失败' });
  }
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

        <!-- 字体预设选择行 -->
        <div class="space-y-1.5 pt-1 border-t border-border/30">
          <div class="text-[11px] text-text-secondary/70">快速切换等宽字体：</div>
          <div class="flex items-center gap-1.5 flex-wrap">
            <button
              v-for="font in COMMON_FONTS"
              :key="font"
              type="button"
              @click="selectFont(font)"
              class="px-2.5 py-1 text-[11px] rounded-lg border font-mono transition-colors cursor-pointer"
              :class="editableTerminalFontFamily === font
                ? 'bg-primary border-primary text-primary-foreground font-semibold shadow-2xs'
                : 'bg-background border-border/60 text-text-secondary hover:text-foreground'"
            >
              {{ font.replace(/"/g, '') }}
            </button>
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
