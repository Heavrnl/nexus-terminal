<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { useAppearanceStore } from '../../../stores/appearance.store';
import { useUiNotificationsStore } from '../../../stores/uiNotifications.store';
import { storeToRefs } from 'pinia';

const appearanceStore = useAppearanceStore();
const notificationsStore = useUiNotificationsStore();

const {
  currentEditorFontSize,
  currentEditorFontFamily,
} = storeToRefs(appearanceStore);

const editableEditorFontSize = ref(14);
const editableEditorFontFamily = ref('');

const COMMON_EDITOR_FONTS = [
  'monospace',
  'Consolas',
  '"Fira Code"',
  '"JetBrains Mono"',
  '"Source Code Pro"',
];

const initializeState = () => {
  editableEditorFontSize.value = currentEditorFontSize.value;
  editableEditorFontFamily.value = currentEditorFontFamily.value;
};

onMounted(initializeState);

watch(currentEditorFontSize, val => { editableEditorFontSize.value = val; });
watch(currentEditorFontFamily, val => { editableEditorFontFamily.value = val; });

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

        <!-- 字体预设选择行 -->
        <div class="space-y-1.5 pt-1 border-t border-border/30">
          <div class="text-[11px] text-text-secondary/70">快速切换代码字体：</div>
          <div class="flex items-center gap-1.5 flex-wrap">
            <button
              v-for="font in COMMON_EDITOR_FONTS"
              :key="font"
              type="button"
              @click="selectFont(font)"
              class="px-2.5 py-1 text-[11px] rounded-lg border font-mono transition-colors cursor-pointer"
              :class="editableEditorFontFamily === font
                ? 'bg-primary border-primary text-primary-foreground font-semibold shadow-2xs'
                : 'bg-background border-border/60 text-text-secondary hover:text-foreground'"
            >
              {{ font.replace(/"/g, '') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
