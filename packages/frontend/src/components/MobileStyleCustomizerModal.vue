<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import MobileStyleCustomizerUiTab from './style-customizer/mobile/MobileStyleCustomizerUiTab.vue';
import MobileStyleCustomizerTerminalTab from './style-customizer/mobile/MobileStyleCustomizerTerminalTab.vue';
import MobileStyleCustomizerHighlightTab from './style-customizer/mobile/MobileStyleCustomizerHighlightTab.vue';
import MobileStyleCustomizerBackgroundTab from './style-customizer/mobile/MobileStyleCustomizerBackgroundTab.vue';
import MobileStyleCustomizerOtherTab from './style-customizer/mobile/MobileStyleCustomizerOtherTab.vue';
import MobileBottomSheet from './common/MobileBottomSheet.vue';

const props = withDefaults(
  defineProps<{
    visible?: boolean;
  }>(),
  {
    visible: true,
  }
);

const { t } = useI18n();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const currentTab = ref<'ui' | 'terminal' | 'highlight' | 'background' | 'other'>('ui');
const uiTabRef = ref<InstanceType<typeof MobileStyleCustomizerUiTab> | null>(null);

// 标签项配置
const tabs = [
  { key: 'ui' as const, labelKey: 'styleCustomizer.uiStyles', defaultLabel: '界面样式', icon: 'fas fa-desktop' },
  { key: 'terminal' as const, labelKey: 'styleCustomizer.terminalStyles', defaultLabel: '终端样式', icon: 'fas fa-terminal' },
  { key: 'highlight' as const, labelKey: 'styleCustomizer.terminalHighlight', defaultLabel: '代码高亮', icon: 'fas fa-highlighter' },
  { key: 'background' as const, labelKey: 'styleCustomizer.backgroundSettings', defaultLabel: '背景设置', icon: 'fas fa-image' },
  { key: 'other' as const, labelKey: 'styleCustomizer.otherSettings', defaultLabel: '其他设置', icon: 'fas fa-sliders-h' },
];

const handleClose = () => {
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
  <MobileBottomSheet
    :visible="props.visible"
    :title="t('styleCustomizer.title', '外观自定义')"
    icon="fas fa-paint-brush"
    height="h-[90vh]"
    max-height="max-h-[92vh]"
    :z-index="1000"
    @close="handleClose"
  >
    <!-- 2. 横向滚动分类药丸标签导航 -->
    <template #sub-header>
      <div class="tabs-scroll-bar px-3 pb-2.5 pt-1 overflow-x-auto flex items-center gap-1.5 no-scrollbar border-b border-border/40 bg-header/20">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          @click="currentTab = tab.key"
          class="h-7.5 px-3 rounded-lg text-xs font-medium border flex items-center gap-1.5 shrink-0 transition-colors duration-150 cursor-pointer outline-none"
          :class="currentTab === tab.key
            ? 'bg-primary border-primary text-primary-foreground shadow-2xs font-semibold'
            : 'bg-background/80 border-border/60 text-text-secondary hover:text-foreground hover:bg-header/60'"
        >
          <i :class="[tab.icon, 'text-xs', currentTab === tab.key ? 'text-primary-foreground' : 'text-text-secondary/70']"></i>
          <span>{{ t(tab.labelKey, tab.defaultLabel) }}</span>
        </button>
      </div>
    </template>

    <!-- 3. 主内容区域 (纵向可滚动，全屏宽卡片流适配) -->
    <div class="sheet-body flex-grow overflow-y-auto px-4 py-3 space-y-4 overscroll-contain">
      <MobileStyleCustomizerUiTab v-if="currentTab === 'ui'" ref="uiTabRef" />
      <MobileStyleCustomizerTerminalTab v-if="currentTab === 'terminal'" />
      <MobileStyleCustomizerHighlightTab v-if="currentTab === 'highlight'" />
      <MobileStyleCustomizerBackgroundTab v-if="currentTab === 'background'" />
      <MobileStyleCustomizerOtherTab v-if="currentTab === 'other'" />

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
  </MobileBottomSheet>
</template>

<style scoped>
.sheet-safe-bottom {
  padding-bottom: max(env(safe-area-inset-bottom, 0px), 12px);
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
