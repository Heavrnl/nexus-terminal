<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TerminalTheme } from '../types/terminal-theme.types';
import StyleCustomizerUiTab from './style-customizer/StyleCustomizerUiTab.vue';
import StyleCustomizerTerminalTab from './style-customizer/StyleCustomizerTerminalTab.vue';
import StyleCustomizerHighlightTab from './style-customizer/StyleCustomizerHighlightTab.vue';
import StyleCustomizerBackgroundTab from './style-customizer/StyleCustomizerBackgroundTab.vue';
import StyleCustomizerOtherTab from './style-customizer/StyleCustomizerOtherTab.vue';

const { t } = useI18n();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const currentTab = ref<'ui' | 'terminal' | 'highlight' | 'background' | 'other'>('ui');
const isEditingTheme = ref(false);
const editingTheme = ref<TerminalTheme | null>(null);

const uiTabRef = ref<InstanceType<typeof StyleCustomizerUiTab> | null>(null);
const modalRootRef = ref<HTMLDivElement | null>(null);

// 标签项配置
const tabs = [
  { key: 'ui' as const, labelKey: 'styleCustomizer.uiStyles', defaultLabel: '界面样式', icon: 'fas fa-desktop' },
  { key: 'terminal' as const, labelKey: 'styleCustomizer.terminalStyles', defaultLabel: '终端样式', icon: 'fas fa-terminal' },
  { key: 'highlight' as const, labelKey: 'styleCustomizer.terminalHighlight', defaultLabel: '代码高亮', icon: 'fas fa-highlighter' },
  { key: 'background' as const, labelKey: 'styleCustomizer.backgroundSettings', defaultLabel: '背景设置', icon: 'fas fa-image' },
  { key: 'other' as const, labelKey: 'styleCustomizer.otherSettings', defaultLabel: '其他设置', icon: 'fas fa-sliders-h' },
];

const handleClose = () => {
  isEditingTheme.value = false;
  editingTheme.value = null;
  emit('close');
};

const handleSaveUiTheme = async () => {
  if (uiTabRef.value) {
    await uiTabRef.value.handleSaveUiTheme();
  }
};

const handleResetUiTheme = async () => {
  if (uiTabRef.value) {
    await uiTabRef.value.handleResetUiTheme();
  }
};
</script>

<template>
  <Teleport to="body">
    <Transition name="bottom-sheet">
      <div
        ref="modalRootRef"
        class="fixed inset-0 z-[1000] flex flex-col justify-end bg-black/60 backdrop-blur-xs select-none"
        @click.self="handleClose"
      >
        <!-- 移动端底部抽屉主体 -->
        <div class="mobile-customizer-sheet w-full h-[90vh] max-h-[92vh] bg-background border-t border-border/80 rounded-t-2xl shadow-2xl flex flex-col overflow-hidden select-text">
          <!-- 1. 顶部手柄条与标题栏 -->
          <div class="sheet-top shrink-0 select-none border-b border-border/40 bg-header/40">
            <!-- 拖拽把手指示条 -->
            <div
              class="sheet-handle-zone pt-2.5 pb-1 flex flex-col items-center justify-center cursor-pointer active:opacity-60 transition-opacity"
              @click="handleClose"
              title="点击收起"
            >
              <div class="w-10 h-1.5 bg-border/80 rounded-full hover:bg-text-secondary/40 transition-colors"></div>
            </div>

            <!-- 顶栏标题与收起按钮 -->
            <div class="flex items-center justify-between px-4 py-2">
              <div class="flex items-center gap-2">
                <div class="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  <i class="fas fa-paint-brush text-sm"></i>
                </div>
                <h3 class="text-base font-semibold text-foreground tracking-tight">
                  {{ t('styleCustomizer.title', '外观自定义') }}
                </h3>
              </div>

              <!-- 右侧收起按钮 (统一向下箭头) -->
              <button
                type="button"
                @click="handleClose"
                class="w-7 h-7 flex items-center justify-center rounded-lg text-text-secondary hover:text-foreground hover:bg-border/40 active:scale-95 transition-all cursor-pointer"
                :title="t('common.close', '收起')"
              >
                <i class="fas fa-chevron-down text-sm"></i>
              </button>
            </div>

            <!-- 2. 横向滚动分类药丸标签导航 -->
            <div class="tabs-scroll-bar px-3 pb-2.5 pt-1 overflow-x-auto flex items-center gap-1.5 no-scrollbar">
              <button
                v-for="tab in tabs"
                :key="tab.key"
                type="button"
                @click="currentTab = tab.key"
                :disabled="isEditingTheme && tab.key !== 'terminal'"
                class="h-7.5 px-3 rounded-lg text-xs font-medium border flex items-center gap-1.5 shrink-0 transition-colors duration-150 cursor-pointer outline-none disabled:opacity-40 disabled:cursor-not-allowed"
                :class="currentTab === tab.key
                  ? 'bg-primary border-primary text-primary-foreground shadow-2xs font-semibold'
                  : 'bg-background/80 border-border/60 text-text-secondary hover:text-foreground hover:bg-header/60'"
              >
                <i :class="[tab.icon, 'text-xs', currentTab === tab.key ? 'text-primary-foreground' : 'text-text-secondary/70']"></i>
                <span>{{ t(tab.labelKey, tab.defaultLabel) }}</span>
              </button>
            </div>
          </div>

          <!-- 3. 主内容区域 (纵向可滚动) -->
          <div class="sheet-body flex-grow overflow-y-auto px-4 py-3 space-y-4 overscroll-contain">
            <StyleCustomizerUiTab v-if="currentTab === 'ui'" ref="uiTabRef" />
            
            <StyleCustomizerTerminalTab
              v-if="currentTab === 'terminal'"
              :modal-root-ref="modalRootRef"
              :is-editing-theme="isEditingTheme"
              :editing-theme="editingTheme"
              @update:is-editing-theme="val => isEditingTheme = val"
              @update:editing-theme="val => editingTheme = val"
            />
            
            <StyleCustomizerHighlightTab v-if="currentTab === 'highlight'" />
            <StyleCustomizerBackgroundTab v-if="currentTab === 'background'" />
            <StyleCustomizerOtherTab v-if="currentTab === 'other'" />

            <!-- 垫高占位，避免被底栏遮挡 -->
            <div class="h-6"></div>
          </div>

          <!-- 4. 底部动作栏 (在 UI 界面样式 Tab 下提供移动端大按钮保存/重置) -->
          <div
            v-if="currentTab === 'ui'"
            class="sheet-footer shrink-0 px-4 py-2.5 border-t border-border/40 bg-header/30 flex items-center justify-end gap-2.5 select-none"
          >
            <button
              type="button"
              @click="handleResetUiTheme"
              class="h-8.5 px-4 rounded-xl border border-border/70 bg-header/80 text-foreground text-xs font-medium hover:bg-border/60 active:scale-95 transition-all cursor-pointer"
            >
              {{ t('styleCustomizer.resetUiTheme', '重置主题') }}
            </button>
            <button
              type="button"
              @click="handleSaveUiTheme"
              class="h-8.5 px-4.5 rounded-xl bg-primary text-primary-foreground text-xs font-semibold shadow-xs hover:bg-primary/90 active:scale-95 transition-all cursor-pointer"
            >
              {{ t('styleCustomizer.saveUiTheme', '保存主题') }}
            </button>
          </div>

          <!-- 底部安全区垫高 -->
          <div class="sheet-safe-bottom shrink-0 bg-header/30"></div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.bottom-sheet-enter-active,
.bottom-sheet-leave-active {
  transition: opacity 0.25s ease, transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

.bottom-sheet-enter-from,
.bottom-sheet-leave-to {
  opacity: 0;
  transform: translateY(100%);
}

.sheet-safe-bottom {
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

/* 隐藏横向滚动条 */
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
