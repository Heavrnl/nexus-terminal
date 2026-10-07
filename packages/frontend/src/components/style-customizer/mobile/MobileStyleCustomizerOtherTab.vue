<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppearanceStore } from '../../../stores/appearance.store';
import { useUiNotificationsStore } from '../../../stores/uiNotifications.store';
import { storeToRefs } from 'pinia';

const { t } = useI18n();
const appearanceStore = useAppearanceStore();
const notificationsStore = useUiNotificationsStore();

const {
  currentEditorFontSize,
  currentEditorFontFamily,
} = storeToRefs(appearanceStore);

const editableEditorFontSize = ref(14);
const editableEditorFontFamily = ref('');

// 基础内置等宽代码字体预设
const DEFAULT_PRESET_EDITOR_FONTS = [
  'monospace',
  'Consolas',
  '"Fira Code"',
  '"JetBrains Mono"',
  '"Source Code Pro"',
];

const STORAGE_KEY_CUSTOM_EDITOR_FONTS = 'nexus_mobile_custom_editor_fonts';

// 自定义字体列表与添加卡片状态
const customEditorFonts = ref<string[]>([]);
const showAddFontInput = ref(false);
const newFontName = ref('');

const loadCustomFonts = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CUSTOM_EDITOR_FONTS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        customEditorFonts.value = parsed.filter(f => typeof f === 'string' && f.trim());
      }
    }
  } catch (e) {
    console.error('读取自定义编辑器字体失败:', e);
  }
};

const saveCustomFonts = () => {
  try {
    localStorage.setItem(STORAGE_KEY_CUSTOM_EDITOR_FONTS, JSON.stringify(customEditorFonts.value));
  } catch (e) {
    console.error('存储自定义编辑器字体失败:', e);
  }
};

const isCustomFont = (font: string) => {
  return customEditorFonts.value.includes(font) && !DEFAULT_PRESET_EDITOR_FONTS.includes(font);
};

// 合并内置预设、自定义字体和当前字体
const allAvailableFonts = computed(() => {
  const result: string[] = [...DEFAULT_PRESET_EDITOR_FONTS];
  customEditorFonts.value.forEach(f => {
    if (!result.includes(f)) {
      result.push(f);
    }
  });
  const cur = editableEditorFontFamily.value?.trim();
  if (cur && !result.includes(cur)) {
    result.push(cur);
  }
  return result;
});

const initializeState = () => {
  loadCustomFonts();
  editableEditorFontSize.value = currentEditorFontSize.value;
  editableEditorFontFamily.value = currentEditorFontFamily.value || '';
};

onMounted(initializeState);

watch(currentEditorFontSize, val => { editableEditorFontSize.value = val; });
watch(currentEditorFontFamily, val => { editableEditorFontFamily.value = val || ''; });

// 步进调节字号
const changeFontSize = async (delta: number) => {
  const newSize = Math.max(10, Math.min(26, editableEditorFontSize.value + delta));
  editableEditorFontSize.value = newSize;
  try {
    await appearanceStore.setEditorFontSize(newSize);
  } catch (err: any) {
    notificationsStore.addNotification({ type: 'error', message: err.message || '更新字号失败' });
  }
};

// 预设字体选择
const selectFont = async (font: string) => {
  editableEditorFontFamily.value = font;
  try {
    await appearanceStore.setEditorFontFamily(font);
    notificationsStore.addNotification({ type: 'success', message: '编辑器字体已更新' });
  } catch (err: any) {
    notificationsStore.addNotification({ type: 'error', message: err.message || '更新字体失败' });
  }
};

// 应用当前输入框中的自定义字体
const handleApplyCustomFont = async () => {
  const font = editableEditorFontFamily.value.trim();
  if (!font) {
    notificationsStore.addNotification({ type: 'warning', message: '请输入有效的字体名称' });
    return;
  }
  if (!DEFAULT_PRESET_EDITOR_FONTS.includes(font) && !customEditorFonts.value.includes(font)) {
    customEditorFonts.value.push(font);
    saveCustomFonts();
  }
  try {
    await appearanceStore.setEditorFontFamily(font);
    notificationsStore.addNotification({ type: 'success', message: '编辑器字体已更新' });
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
  if (!customEditorFonts.value.includes(font) && !DEFAULT_PRESET_EDITOR_FONTS.includes(font)) {
    customEditorFonts.value.push(font);
    saveCustomFonts();
  }
  newFontName.value = '';
  showAddFontInput.value = false;
  await selectFont(font);
};

// 移除用户自定义字体
const removeCustomFont = (font: string) => {
  customEditorFonts.value = customEditorFonts.value.filter(f => f !== font);
  saveCustomFonts();
  notificationsStore.addNotification({ type: 'info', message: '已移除该自定义字体' });
};
</script>

<template>
  <div class="mobile-other-tab space-y-4 text-foreground">
    <!-- 编辑器字体设置卡片 -->
    <div class="space-y-1.5">
      <div class="text-xs font-semibold text-text-secondary px-0.5">代码编辑器配置</div>
      <div class="bg-header/30 border border-border/50 rounded-2xl p-3.5 space-y-3">
        <!-- 字号调节行 -->
        <div class="flex items-center justify-between">
          <div>
            <div class="text-xs font-medium text-foreground">编辑器字号大小</div>
            <div class="text-[10px] text-text-secondary/60">当前：{{ editableEditorFontSize }}px</div>
          </div>

          <!-- 步进按钮器 -->
          <div class="flex items-center gap-2 bg-background border border-border/60 rounded-xl p-1 shadow-2xs">
            <button
              type="button"
              @click="changeFontSize(-1)"
              :disabled="editableEditorFontSize <= 10"
              class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-header/80 active:scale-95 text-xs text-foreground disabled:opacity-40 cursor-pointer"
            >
              <i class="fas fa-minus"></i>
            </button>
            <span class="w-8 text-center font-mono font-semibold text-xs text-foreground">{{ editableEditorFontSize }}</span>
            <button
              type="button"
              @click="changeFontSize(1)"
              :disabled="editableEditorFontSize >= 26"
              class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-header/80 active:scale-95 text-xs text-foreground disabled:opacity-40 cursor-pointer"
            >
              <i class="fas fa-plus"></i>
            </button>
          </div>
        </div>

        <!-- 字体族输入与自定义添加行 -->
        <div class="space-y-2 pt-2 border-t border-border/30">
          <div class="flex items-center justify-between">
            <span class="text-[11px] text-text-secondary/80 font-medium">编辑器字体族 (Font Family)</span>
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

          <!-- 自定义输入并保存应用 -->
          <div class="flex items-center gap-2">
            <input
              type="text"
              v-model="editableEditorFontFamily"
              @keydown.enter.prevent="handleApplyCustomFont"
              placeholder="如 'Fira Code', Consolas, monospace"
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
                placeholder="字体名称，例如：'Source Code Pro'"
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
        </div>

        <!-- 字体预设与自定义标签选择行 -->
        <div class="space-y-1.5 pt-1">
          <div class="text-[11px] text-text-secondary/70">快速切换代码字体：</div>
          <div class="flex items-center gap-1.5 flex-wrap">
            <div
              v-for="font in allAvailableFonts"
              :key="font"
              class="inline-flex items-center rounded-lg border font-mono text-[11px] transition-colors overflow-hidden"
              :class="editableEditorFontFamily === font
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
  </div>
</template>
