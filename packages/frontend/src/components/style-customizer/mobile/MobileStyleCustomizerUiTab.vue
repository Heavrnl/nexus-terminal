<script setup lang="ts">
import { ref, watch, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppearanceStore } from '../../../stores/appearance.store';
import { useUiNotificationsStore } from '../../../stores/uiNotifications.store';
import { storeToRefs } from 'pinia';
import { defaultUiTheme } from '../../../features/appearance/config/default-themes';
import { safeJsonParse } from '../../../stores/appearance.store';

const { t } = useI18n();
const appearanceStore = useAppearanceStore();
const notificationsStore = useUiNotificationsStore();
const { appearanceSettings } = storeToRefs(appearanceStore);

const editableUiTheme = ref<Record<string, string>>({});
const editableUiThemeString = ref('');
const themeParseError = ref<string | null>(null);
const showAdvancedJson = ref(false);

// 黑暗模式主题预设
const darkModeTheme = {
  '--app-bg-color': '#212529',
  '--text-color': '#e9ecef',
  '--text-color-secondary': '#adb5bd',
  '--border-color': '#495057',
  '--link-color': '#BB86FC',
  '--link-hover-color': '#D1A9FF',
  '--link-active-color': '#A06CD5',
  '--link-active-bg-color': 'rgba(160, 108, 213, 0.2)',
  '--nav-item-active-bg-color': 'var(--link-active-bg-color)',
  '--header-bg-color': '#343a40',
  '--footer-bg-color': '#343a40',
  '--button-bg-color': 'var(--link-active-color)',
  '--button-text-color': '#ffffff',
  '--button-hover-bg-color': '#8E44AD',
  '--icon-color': 'var(--text-color-secondary)',
  '--icon-hover-color': 'var(--link-hover-color)',
  '--split-line-color': 'var(--border-color)',
  '--split-line-hover-color': 'var(--border-color)',
  '--input-focus-border-color': 'var(--link-active-color)',
  '--input-focus-glow': 'var(--link-active-color)',
  '--overlay-bg-color': 'rgba(0, 0, 0, 0.8)',
  '--color-success': '#5cb85c',
  '--color-error': '#d9534f',
  '--color-warning': '#f0ad4e',
  '--font-family-sans-serif': 'sans-serif',
  '--base-padding': '1rem',
  '--base-margin': '0.5rem'
};

// 友好分类映射
const COLOR_GROUPS = [
  {
    title: '基础与背景',
    icon: 'fas fa-palette',
    items: [
      { key: '--app-bg-color', label: '应用背景' },
      { key: '--text-color', label: '主要文字' },
      { key: '--text-color-secondary', label: '次要文字' },
      { key: '--border-color', label: '边框与分割' },
    ]
  },
  {
    title: '强调与操作',
    icon: 'fas fa-mouse-pointer',
    items: [
      { key: '--link-active-color', label: '主题主色' },
      { key: '--button-bg-color', label: '按钮背景' },
      { key: '--button-text-color', label: '按钮文字' },
      { key: '--icon-color', label: '图标主色' },
    ]
  },
  {
    title: '导航与底栏',
    icon: 'fas fa-bars',
    items: [
      { key: '--header-bg-color', label: '顶栏背景' },
      { key: '--footer-bg-color', label: '底栏背景' },
    ]
  },
  {
    title: '状态反馈色',
    icon: 'fas fa-info-circle',
    items: [
      { key: '--color-success', label: '成功状态' },
      { key: '--color-warning', label: '警告提示' },
      { key: '--color-error', label: '错误危险' },
    ]
  }
];

const initializeEditableState = () => {
  const userThemeJson = appearanceSettings.value.customUiTheme;
  const userTheme = safeJsonParse(userThemeJson, {});
  const mergedTheme = { ...defaultUiTheme, ...userTheme };
  editableUiTheme.value = JSON.parse(JSON.stringify(mergedTheme));
  themeParseError.value = null;

  try {
    const lines = Object.entries(editableUiTheme.value).map(([key, value]) => `${key}: ${value}`);
    editableUiThemeString.value = lines.join('\n');
  } catch (e) {
    console.error('初始化 UI 主题失败:', e);
  }
};

onMounted(initializeEditableState);

watch(() => appearanceSettings.value.customUiTheme, () => {
  initializeEditableState();
}, { deep: true });

const handleSaveUiTheme = async () => {
  try {
    await appearanceStore.saveCustomUiTheme(editableUiTheme.value);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.uiThemeSaved', 'UI 主题设置已保存') });
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.uiThemeSaveFailed', { message: error.message }) });
  }
};

const handleResetUiTheme = async () => {
  try {
    await appearanceStore.resetCustomUiTheme();
    notificationsStore.addNotification({ type: 'info', message: t('styleCustomizer.uiThemeReset', '已恢复默认主题') });
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.uiThemeResetFailed', { message: error.message }) });
  }
};

const applyDarkMode = async () => {
  try {
    editableUiTheme.value = JSON.parse(JSON.stringify(darkModeTheme));
    await appearanceStore.saveCustomUiTheme(editableUiTheme.value);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.darkModeApplied', '已应用深色主题') });
  } catch (error: any) {
    notificationsStore.addNotification({ type: 'error', message: error.message || '切换失败' });
  }
};

const isColorValue = (val?: string) => {
  if (!val) return false;
  return val.startsWith('#') || val.startsWith('rgb') || val.startsWith('hsl');
};

const handleUiThemeStringChange = () => {
  themeParseError.value = null;
  const inputText = editableUiThemeString.value.trim();
  if (!inputText) return;

  try {
    const lines = inputText.split('\n');
    const newTheme: Record<string, string> = { ...editableUiTheme.value };
    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx > -1) {
        const k = line.substring(0, idx).trim();
        const v = line.substring(idx + 1).trim().replace(/;$/, '');
        if (k && v) {
          newTheme[k] = v;
        }
      }
    }
    editableUiTheme.value = newTheme;
  } catch (err: any) {
    themeParseError.value = err.message || '解析语法错误';
  }
};

defineExpose({
  handleSaveUiTheme,
  handleResetUiTheme
});
</script>

<template>
  <div class="mobile-ui-tab space-y-4 text-foreground">
    <!-- 1. 快速模式预设大卡片 -->
    <div class="space-y-1.5">
      <div class="text-xs font-semibold text-text-secondary px-0.5">预设色彩模式</div>
      <div class="grid grid-cols-2 gap-2.5">
        <button
          type="button"
          @click="handleResetUiTheme"
          class="flex items-center gap-2.5 p-3 rounded-xl border border-border/60 bg-header/40 active:scale-98 transition-all text-left cursor-pointer hover:border-primary/50"
        >
          <div class="w-8 h-8 rounded-lg bg-amber-500/10 text-amber-500 flex items-center justify-center shrink-0">
            <i class="fas fa-sun text-base"></i>
          </div>
          <div class="min-w-0">
            <div class="text-xs font-semibold text-foreground">明亮预设</div>
            <div class="text-[10px] text-text-secondary/70 truncate">经典清爽配色</div>
          </div>
        </button>

        <button
          type="button"
          @click="applyDarkMode"
          class="flex items-center gap-2.5 p-3 rounded-xl border border-border/60 bg-header/40 active:scale-98 transition-all text-left cursor-pointer hover:border-primary/50"
        >
          <div class="w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center shrink-0">
            <i class="fas fa-moon text-base"></i>
          </div>
          <div class="min-w-0">
            <div class="text-xs font-semibold text-foreground">深邃暗黑</div>
            <div class="text-[10px] text-text-secondary/70 truncate">护眼暗色模式</div>
          </div>
        </button>
      </div>
    </div>

    <!-- 2. 分组颜色列表 -->
    <div v-for="group in COLOR_GROUPS" :key="group.title" class="space-y-1.5">
      <div class="text-xs font-semibold text-text-secondary px-0.5 flex items-center gap-1.5">
        <i :class="[group.icon, 'text-[11px] text-primary/70']"></i>
        <span>{{ group.title }}</span>
      </div>

      <div class="bg-header/30 border border-border/50 rounded-2xl divide-y divide-border/30 overflow-hidden">
        <div
          v-for="item in group.items"
          :key="item.key"
          class="flex items-center justify-between px-3.5 py-2.5 hover:bg-header/60 transition-colors"
        >
          <div class="min-w-0 flex-1 pr-2">
            <div class="text-xs font-medium text-foreground">{{ item.label }}</div>
            <div class="text-[10px] font-mono text-text-secondary/60 truncate">{{ item.key }}</div>
          </div>

          <!-- 右侧颜色控制 -->
          <div class="flex items-center gap-2 shrink-0">
            <span class="text-xs font-mono text-text-secondary select-all">
              {{ editableUiTheme[item.key] || '--' }}
            </span>
            <div class="relative w-7 h-7 rounded-full overflow-hidden border border-border/80 shadow-2xs shrink-0 cursor-pointer active:scale-95 transition-transform">
              <input
                v-if="isColorValue(editableUiTheme[item.key])"
                type="color"
                v-model="editableUiTheme[item.key]"
                class="absolute -inset-2 w-12 h-12 opacity-0 cursor-pointer"
              />
              <div
                class="w-full h-full"
                :style="{ backgroundColor: editableUiTheme[item.key] || 'transparent' }"
              ></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 3. 高级自定义 JSON 编辑折叠卡片 -->
    <div class="border border-border/50 rounded-2xl bg-header/20 overflow-hidden">
      <button
        type="button"
        @click="showAdvancedJson = !showAdvancedJson"
        class="w-full flex items-center justify-between px-3.5 py-3 text-xs font-medium text-text-secondary hover:text-foreground cursor-pointer"
      >
        <span class="flex items-center gap-1.5">
          <i class="fas fa-code text-xs text-primary/70"></i>
          <span>高级设置：CSS 变量配置文本</span>
        </span>
        <i :class="['fas text-xs transition-transform', showAdvancedJson ? 'fa-chevron-up' : 'fa-chevron-down']"></i>
      </button>

      <div v-show="showAdvancedJson" class="px-3.5 pb-3.5 space-y-2 border-t border-border/30 pt-2">
        <p class="text-[11px] text-text-secondary/70 leading-relaxed">
          可直接编辑各变量键值对，失焦后即时解析：
        </p>
        <textarea
          v-model="editableUiThemeString"
          @blur="handleUiThemeStringChange"
          rows="8"
          spellcheck="false"
          class="w-full font-mono text-xs leading-snug border border-border/70 rounded-xl p-2.5 bg-background text-foreground resize-y outline-none focus:ring-1 focus:ring-primary focus:border-primary shadow-2xs"
        ></textarea>
        <p v-if="themeParseError" class="text-xs text-rose-500 bg-rose-500/10 border border-rose-500/20 px-2.5 py-1.5 rounded-lg">
          {{ themeParseError }}
        </p>
      </div>
    </div>
  </div>
</template>
