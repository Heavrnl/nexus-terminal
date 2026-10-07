<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useSettingsStore } from '../stores/settings.store';
import { useAppearanceStore } from '../stores/appearance.store';
import { useVersionCheck } from '../composables/settings/useVersionCheck';
import WorkspaceSettingsSection from '../components/settings/WorkspaceSettingsSection.vue';
import SystemSettingsSection from '../components/settings/SystemSettingsSection.vue';
import ChangePasswordForm from '../components/settings/ChangePasswordForm.vue';
import PasskeyManagement from '../components/settings/PasskeyManagement.vue';
import TwoFactorAuthSettings from '../components/settings/TwoFactorAuthSettings.vue';
import CaptchaSettingsForm from '../components/settings/CaptchaSettingsForm.vue';
import IpWhitelistSettings from '../components/settings/IpWhitelistSettings.vue';
import IpBlacklistSettings from '../components/settings/IpBlacklistSettings.vue';
import DataManagementSection from '../components/settings/DataManagementSection.vue';
import AboutSection from '../components/settings/AboutSection.vue';

const router = useRouter();
const { t } = useI18n();
const settingsStore = useSettingsStore();
const appearanceStore = useAppearanceStore();
const { isUpdateAvailable, checkLatestVersion } = useVersionCheck();

const {
  settings,
  error: settingsError,
} = storeToRefs(settingsStore);

// 移动端设置分类配置
const tabs = [
  { key: 'workspace' as const, label: t('settings.tabs.workspace', '工作区'), icon: 'fas fa-laptop-code' },
  { key: 'system' as const, label: t('settings.tabs.system', '系统'), icon: 'fas fa-cogs' },
  { key: 'security' as const, label: t('settings.tabs.security', '安全'), icon: 'fas fa-shield-alt' },
  { key: 'ipControl' as const, label: t('settings.tabs.ipControl', 'IP 管控'), icon: 'fas fa-network-wired' },
  { key: 'dataManagement' as const, label: t('settings.tabs.dataManagement', '数据管理'), icon: 'fas fa-database' },
  { key: 'appearance' as const, label: t('settings.tabs.appearance', '外观'), icon: 'fas fa-palette' },
  { key: 'about' as const, label: t('settings.tabs.about', '关于'), icon: 'fas fa-info-circle' },
];

const activeTab = ref<typeof tabs[number]['key']>('workspace');

// 返回工作区
const handleGoBack = () => {
  router.push('/workspace');
};

// 呼出外观自定义抽屉
const openStyleCustomizerModal = () => {
  appearanceStore.toggleStyleCustomizer(true);
};

onMounted(async () => {
  await settingsStore.loadCaptchaSettings();
  await checkLatestVersion();
});
</script>

<template>
  <div class="mobile-settings-view flex flex-col h-full bg-background text-foreground overflow-hidden select-text">
    <!-- 1. 移动端吸顶顶栏 -->
    <header class="shrink-0 bg-header/40 border-b border-border/50 px-4 py-2.5 flex items-center justify-between select-none">
      <div class="flex items-center gap-2.5">
        <button
          type="button"
          @click="handleGoBack"
          class="w-8 h-8 rounded-xl bg-header border border-border/60 flex items-center justify-center text-text-secondary hover:text-foreground active:scale-95 transition-all cursor-pointer"
          :title="t('common.back', '返回')"
        >
          <i class="fas fa-chevron-left text-sm"></i>
        </button>
        <h1 class="text-base font-semibold text-foreground tracking-tight">
          {{ t('settings.title', '设置') }}
        </h1>
      </div>

      <!-- 更新徽标提示 -->
      <div v-if="isUpdateAvailable" class="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-amber-500/15 text-amber-500 border border-amber-500/30">
        <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
        <span>有新版本</span>
      </div>
    </header>

    <!-- 2. 横向平滑滑动分类药丸栏 -->
    <nav class="shrink-0 bg-header/20 border-b border-border/40 px-3 py-2 overflow-x-auto flex items-center gap-1.5 no-scrollbar select-none">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        @click="activeTab = tab.key"
        class="h-7.5 px-3 rounded-lg text-xs font-medium border flex items-center gap-1.5 shrink-0 transition-colors duration-150 cursor-pointer outline-none"
        :class="activeTab === tab.key
          ? 'bg-primary border-primary text-primary-foreground shadow-2xs font-semibold'
          : 'bg-background/80 border-border/60 text-text-secondary hover:text-foreground hover:bg-header/60'"
      >
        <i :class="[tab.icon, 'text-xs', activeTab === tab.key ? 'text-primary-foreground' : 'text-text-secondary/70']"></i>
        <span>{{ tab.label }}</span>
        <!-- 关于标签有更新提示红点 -->
        <span
          v-if="tab.key === 'about' && isUpdateAvailable"
          class="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0"
        ></span>
      </button>
    </nav>

    <!-- 3. 内容滚动区 -->
    <main class="flex-grow overflow-y-auto px-3.5 py-3 space-y-4 overscroll-contain pb-[env(safe-area-inset-bottom,20px)]">
      <!-- 异常状态提示 -->
      <div v-if="settingsError" class="p-3 border border-red-500/30 bg-red-500/10 text-red-400 text-xs rounded-xl">
        {{ settingsError }}
      </div>

      <template v-else>
        <!-- 1. 工作区设置 -->
        <div v-if="activeTab === 'workspace'" class="mobile-section-wrapper">
          <WorkspaceSettingsSection v-if="settings" />
          <div v-else class="py-12 text-center text-xs text-text-secondary">{{ t('common.loading', '加载中...') }}</div>
        </div>

        <!-- 2. 系统设置 -->
        <div v-if="activeTab === 'system'" class="mobile-section-wrapper">
          <SystemSettingsSection v-if="settings" />
          <div v-else class="py-12 text-center text-xs text-text-secondary">{{ t('common.loading', '加载中...') }}</div>
        </div>

        <!-- 3. 安全设置 (手机端分类卡片排布) -->
        <div v-if="activeTab === 'security'" class="space-y-3 mobile-section-wrapper">
          <div v-if="settings" class="space-y-3">
            <div class="bg-background border border-border/60 rounded-2xl p-4 shadow-2xs">
              <ChangePasswordForm />
            </div>
            <div class="bg-background border border-border/60 rounded-2xl p-4 shadow-2xs">
              <PasskeyManagement />
            </div>
            <div class="bg-background border border-border/60 rounded-2xl p-4 shadow-2xs">
              <TwoFactorAuthSettings />
            </div>
            <div class="bg-background border border-border/60 rounded-2xl p-4 shadow-2xs">
              <CaptchaSettingsForm />
            </div>
          </div>
          <div v-else class="py-12 text-center text-xs text-text-secondary">{{ t('common.loading', '加载中...') }}</div>
        </div>

        <!-- 4. IP 管控 -->
        <div v-if="activeTab === 'ipControl'" class="space-y-3 mobile-section-wrapper">
          <div v-if="settings" class="space-y-3">
            <div class="bg-background border border-border/60 rounded-2xl p-4 shadow-2xs">
              <IpWhitelistSettings />
            </div>
            <div class="bg-background border border-border/60 rounded-2xl p-4 shadow-2xs">
              <IpBlacklistSettings />
            </div>
          </div>
          <div v-else class="py-12 text-center text-xs text-text-secondary">{{ t('common.loading', '加载中...') }}</div>
        </div>

        <!-- 5. 数据管理 -->
        <div v-if="activeTab === 'dataManagement'" class="mobile-section-wrapper">
          <DataManagementSection v-if="settings" />
          <div v-else class="py-12 text-center text-xs text-text-secondary">{{ t('common.loading', '加载中...') }}</div>
        </div>

        <!-- 6. 外观设置 (移动端专属增强卡片) -->
        <div v-if="activeTab === 'appearance'" class="space-y-3 mobile-section-wrapper">
          <!-- 唤起移动端专属外观自定义抽屉的卡片 -->
          <div class="bg-gradient-to-br from-primary/10 via-header/40 to-background border border-primary/30 rounded-2xl p-4 shadow-2xs space-y-3">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-xl bg-primary/20 text-primary flex items-center justify-center shrink-0 text-lg">
                <i class="fas fa-palette"></i>
              </div>
              <div class="min-w-0">
                <div class="text-sm font-semibold text-foreground">外观与主题定制</div>
                <div class="text-xs text-text-secondary/80 mt-0.5">调色盘、终端主题、代码高亮、背景图片</div>
              </div>
            </div>

            <button
              type="button"
              @click="openStyleCustomizerModal"
              class="w-full h-9 rounded-xl bg-primary text-primary-foreground font-semibold text-xs shadow-xs hover:bg-primary/90 active:scale-98 transition-all flex items-center justify-center gap-2 cursor-pointer"
            >
              <i class="fas fa-sliders-h text-xs"></i>
              <span>打开移动端外观定制面板</span>
            </button>
          </div>

          <div class="bg-background border border-border/60 rounded-2xl p-4 shadow-2xs">
            <div class="text-xs font-semibold text-foreground mb-2">默认设置</div>
            <p class="text-xs text-text-secondary leading-relaxed">
              您也可以在终端或各工具栏随时点击画笔图标调出外观抽屉进行即时微调。
            </p>
          </div>
        </div>

        <!-- 7. 关于与更新 -->
        <div v-if="activeTab === 'about'" class="mobile-section-wrapper">
          <AboutSection />
        </div>
      </template>

      <!-- 底部安全留白垫高 -->
      <div class="h-6 shrink-0"></div>
    </main>
  </div>
</template>

<style scoped>
/* 隐藏横向滚动条 */
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

/* 移动端设置内容区紧凑卡片微调 */
:deep(.mobile-section-wrapper .bg-background) {
  border-radius: 1rem !important;
}

:deep(.mobile-section-wrapper h2) {
  padding-left: 1rem !important;
  padding-right: 1rem !important;
  padding-top: 0.75rem !important;
  padding-bottom: 0.75rem !important;
  font-size: 0.95rem !important;
}

:deep(.mobile-section-wrapper .p-6) {
  padding: 1rem !important;
}

:deep(.mobile-section-wrapper .px-6) {
  padding-left: 1rem !important;
  padding-right: 1rem !important;
}

:deep(.mobile-section-wrapper .py-4\.5) {
  padding-top: 0.75rem !important;
  padding-bottom: 0.75rem !important;
}
</style>
