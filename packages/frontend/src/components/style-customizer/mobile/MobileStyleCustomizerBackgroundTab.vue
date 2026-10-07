<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppearanceStore } from '../../../stores/appearance.store';
import { useUiNotificationsStore } from '../../../stores/uiNotifications.store';
import { storeToRefs } from 'pinia';
import ToggleSwitch from '../../common/ToggleSwitch.vue';

const { t } = useI18n();
const appearanceStore = useAppearanceStore();
const notificationsStore = useUiNotificationsStore();

const {
  terminalBackgroundImage,
  isTerminalBackgroundEnabled,
  currentTerminalBackgroundOverlayOpacity,
  localHtmlPresets,
} = storeToRefs(appearanceStore);

const {
  fetchLocalHtmlPresets,
  getLocalHtmlPresetContent,
  applyHtmlPreset,
} = appearanceStore;

const terminalBgFileInput = ref<HTMLInputElement | null>(null);
const localOpacity = ref(0.5);
const showPresetSection = ref(false);

onMounted(async () => {
  localOpacity.value = currentTerminalBackgroundOverlayOpacity.value;
  try {
    await fetchLocalHtmlPresets();
  } catch (e) {
    console.error(e);
  }
});

watch(currentTerminalBackgroundOverlayOpacity, val => {
  localOpacity.value = val;
});

// 触发文件选择
const triggerUpload = () => {
  terminalBgFileInput.value?.click();
};

// 处理图片上传
const handleFileUpload = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  if (input.files && input.files[0]) {
    const file = input.files[0];
    try {
      await appearanceStore.uploadTerminalBackground(file);
      notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.terminalBgUploadSuccess', '背景图片上传成功') });
    } catch (err: any) {
      notificationsStore.addNotification({ type: 'error', message: err.message || '上传背景失败' });
    } finally {
      input.value = '';
    }
  }
};

// 移除背景图
const removeBg = async () => {
  try {
    await appearanceStore.removeTerminalBackground();
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.terminalBgRemoved', '已移除背景图片') });
  } catch (err: any) {
    notificationsStore.addNotification({ type: 'error', message: err.message || '移除背景失败' });
  }
};

// 切换背景开关
const toggleEnabled = async (val: boolean) => {
  try {
    await appearanceStore.setTerminalBackgroundEnabled(val);
  } catch (err: any) {
    notificationsStore.addNotification({ type: 'error', message: err.message || '切换背景状态失败' });
  }
};

// 调节不透明度
const updateOpacity = async () => {
  try {
    await appearanceStore.setTerminalBackgroundOverlayOpacity(Number(localOpacity.value));
  } catch (err: any) {
    console.error(err);
  }
};

// 应用动态 HTML 背景预设
const handleApplyPresetByName = async (presetName: string) => {
  try {
    const content = await getLocalHtmlPresetContent(presetName);
    await applyHtmlPreset(content);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.htmlPresetApplied', '已应用动态背景预设') });
  } catch (err: any) {
    notificationsStore.addNotification({ type: 'error', message: err.message || '应用预设失败' });
  }
};

// 重置动态背景
const resetHtmlPreset = async () => {
  try {
    await applyHtmlPreset('');
    notificationsStore.addNotification({ type: 'info', message: '已重置动态背景' });
  } catch (err: any) {
    console.error(err);
  }
};
</script>

<template>
  <div class="mobile-background-tab space-y-4 text-foreground">
    <!-- 隐藏的文件上传 input -->
    <input
      type="file"
      ref="terminalBgFileInput"
      @change="handleFileUpload"
      accept="image/*"
      class="hidden"
    />

    <!-- 1. 背景总开关大卡片 -->
    <div class="bg-header/30 border border-border/50 rounded-2xl p-3.5 flex items-center justify-between gap-3 shadow-2xs">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <div class="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <i class="fas fa-image text-xs"></i>
          </div>
          <span class="text-xs font-semibold text-foreground">启用终端背景</span>
        </div>
        <p class="text-[11px] text-text-secondary/70 mt-1 leading-relaxed">
          在终端渲染半透明图片或动态 HTML 背景
        </p>
      </div>

      <ToggleSwitch
        :model-value="isTerminalBackgroundEnabled"
        @update:model-value="toggleEnabled"
      />
    </div>

    <!-- 2. 图片背景设置卡片 -->
    <div class="bg-header/30 border border-border/50 rounded-2xl p-3.5 space-y-3">
      <div class="text-xs font-semibold text-text-secondary">背景图片</div>

      <!-- 如果已有背景图：缩略图与操作 -->
      <div v-if="terminalBackgroundImage" class="flex items-center gap-3 p-2.5 rounded-xl bg-background/80 border border-border/50">
        <img
          :src="terminalBackgroundImage"
          alt="Terminal Background"
          class="w-14 h-14 object-cover rounded-lg border border-border/60 shrink-0"
        />
        <div class="flex-1 min-w-0">
          <div class="text-xs font-medium text-foreground truncate">已加载自定义背景图</div>
          <div class="flex items-center gap-2 mt-1.5">
            <button
              type="button"
              @click="triggerUpload"
              class="px-2.5 py-1 text-[11px] rounded-lg bg-header border border-border/60 text-foreground hover:bg-border/40 cursor-pointer"
            >
              更换
            </button>
            <button
              type="button"
              @click="removeBg"
              class="px-2.5 py-1 text-[11px] rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-500 hover:bg-rose-500/20 cursor-pointer"
            >
              移除
            </button>
          </div>
        </div>
      </div>

      <!-- 如果暂无背景图：上传按钮 -->
      <div v-else>
        <button
          type="button"
          @click="triggerUpload"
          class="w-full py-4 border-2 border-dashed border-border/70 rounded-xl hover:border-primary/60 hover:bg-header/40 active:scale-98 transition-all flex flex-col items-center justify-center gap-1.5 text-text-secondary cursor-pointer"
        >
          <i class="fas fa-cloud-upload-alt text-xl text-primary/70"></i>
          <span class="text-xs font-medium text-foreground">从手机相册选取背景图</span>
          <span class="text-[10px] text-text-secondary/60">支持 JPG, PNG, WebP 格式</span>
        </button>
      </div>

      <!-- 遮罩不透明度滑块 -->
      <div class="pt-2 border-t border-border/30 space-y-1.5">
        <div class="flex items-center justify-between text-xs">
          <span class="font-medium text-foreground">背景蒙版遮罩浓度</span>
          <span class="font-mono text-text-secondary">{{ Math.round(localOpacity * 100) }}%</span>
        </div>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          v-model.number="localOpacity"
          @change="updateOpacity"
          class="w-full accent-primary h-1.5 cursor-pointer"
        />
        <div class="flex justify-between text-[10px] text-text-secondary/50">
          <span>通透 (0%)</span>
          <span>高对比 (100%)</span>
        </div>
      </div>
    </div>

    <!-- 3. 动态 HTML 背景动效预设 (折叠卡片) -->
    <div class="border border-border/50 rounded-2xl bg-header/20 overflow-hidden">
      <button
        type="button"
        @click="showPresetSection = !showPresetSection"
        class="w-full flex items-center justify-between px-3.5 py-3 text-xs font-medium text-text-secondary hover:text-foreground cursor-pointer"
      >
        <span class="flex items-center gap-1.5">
          <i class="fas fa-code-branch text-xs text-primary/70"></i>
          <span>动态 HTML 粒子与代码雨预设</span>
        </span>
        <i :class="['fas text-xs transition-transform', showPresetSection ? 'fa-chevron-up' : 'fa-chevron-down']"></i>
      </button>

      <div v-show="showPresetSection" class="px-3.5 pb-3.5 space-y-2.5 border-t border-border/30 pt-2.5">
        <div class="flex items-center justify-between">
          <span class="text-[11px] text-text-secondary">精选动效背景库：</span>
          <button
            type="button"
            @click="resetHtmlPreset"
            class="text-[11px] text-rose-500 hover:underline cursor-pointer"
          >
            清除动效
          </button>
        </div>

        <div v-if="localHtmlPresets.length > 0" class="space-y-1.5">
          <div
            v-for="preset in localHtmlPresets"
            :key="preset.name"
            class="flex items-center justify-between p-2.5 rounded-xl bg-background border border-border/60 hover:border-primary/50 transition-colors"
          >
            <span class="text-xs font-medium text-foreground truncate">{{ preset.name.replace(/\.html$/, '') }}</span>
            <button
              type="button"
              @click="handleApplyPresetByName(preset.name)"
              class="px-2.5 py-1 text-[11px] rounded-lg bg-primary text-primary-foreground font-semibold cursor-pointer active:scale-95"
            >
              应用
            </button>
          </div>
        </div>

        <div v-else class="text-center py-4 text-xs text-text-secondary/60">
          暂无本地动态预设
        </div>
      </div>
    </div>
  </div>
</template>
