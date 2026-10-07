<template>
  <MobileSettingsView v-if="isMobile" />
  <div v-else class="p-4 bg-background text-foreground min-h-screen"> <!-- Outer container -->
    <div class="max-w-7xl mx-auto"> <!-- Inner container for max-width -->
      <!-- Tabs Navigation -->
      <div class="mb-6 flex space-x-1 bg-background z-10 py-2">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          @click="activeTab = tab.key"
          :class="['px-4 py-2 text-sm font-medium rounded-md focus:outline-none transition-colors duration-150 ease-in-out',
                   activeTab === tab.key ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground']"
        >
          <span class="relative flex items-center" :class="{'text-warning': tab.key === 'about' && isUpdateAvailable}">
            {{ tab.label }}
          </span>
        </button>
      </div>

      <!-- Error state (Show first if error exists) -->
      <div v-if="settingsError" class="p-4 mb-4 border-l-4 border-error bg-error/10 text-error rounded">
        {{ settingsError }}
      </div>

      <!-- Settings Content based on activeTab -->
      <div v-else class="space-y-6">
        <!-- Security Tab Content -->
        <div v-if="activeTab === 'security'">
          <div v-if="settings" class="bg-background border border-border rounded-lg shadow-sm overflow-hidden">
            <h2 class="text-lg font-semibold text-foreground px-6 py-4 border-b border-border bg-header/50">{{ $t('settings.category.security') }}</h2>
            <div class="p-6 space-y-6">
              <ChangePasswordForm />
              <hr class="border-border/50">
              <PasskeyManagement />
              <hr class="border-border/50">
              <TwoFactorAuthSettings />
              <hr class="border-border/50">
              <CaptchaSettingsForm />
            </div>
          </div>
          <div v-else class="p-4 text-center text-muted-foreground">{{ $t('settings.loading', '加载中...') }}</div>
        </div>

        <!-- IP Control Tab Content -->
        <div v-if="activeTab === 'ipControl'">
          <div v-if="settings" class="bg-background border border-border rounded-lg shadow-sm overflow-hidden mb-6">
            <h2 class="text-lg font-semibold text-foreground px-6 py-4 border-b border-border bg-header/50">{{ $t('settings.ipWhitelist.title') }}</h2>
            <div class="p-6 space-y-6">
               <IpWhitelistSettings />
            </div>
          </div>
          <IpBlacklistSettings v-if="settings" />
          <div v-else-if="!settings && activeTab === 'ipControl'" class="p-4 text-center text-muted-foreground">{{ $t('settings.loading', '加载中...') }}</div>
        </div>
        
        <!-- Workspace Tab Content -->
        <div v-if="activeTab === 'workspace'">
          <WorkspaceSettingsSection v-if="settings" />
          <div v-else class="p-4 text-center text-muted-foreground">{{ $t('settings.loading', '加载中...') }}</div>
        </div>

        <!-- System Tab Content -->
        <div v-if="activeTab === 'system'">
          <SystemSettingsSection v-if="settings" />
          <div v-else class="p-4 text-center text-muted-foreground">{{ $t('settings.loading', '加载中...') }}</div>
        </div>

        <!-- Data Management Tab Content -->
        <div v-if="activeTab === 'dataManagement'">
          <DataManagementSection v-if="settings" />
          <div v-else class="p-4 text-center text-muted-foreground">{{ $t('settings.loading', '加载中...') }}</div>
        </div>
        
        <!-- Appearance Tab Content -->
        <div v-if="activeTab === 'appearance'">
          <AppearanceSection v-if="settings" />
          <div v-else class="p-4 text-center text-muted-foreground">{{ $t('settings.loading', '加载中...') }}</div>
        </div>

        <!-- About Tab Content -->
        <div v-if="activeTab === 'about'">
          <AboutSection />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'; 
import { useAuthStore } from '../stores/auth.store';
import { useSettingsStore } from '../stores/settings.store';
import { useAppearanceStore } from '../stores/appearance.store'; 
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useVersionCheck } from '../composables/settings/useVersionCheck';
import ChangePasswordForm from '../components/settings/ChangePasswordForm.vue';
import PasskeyManagement from '../components/settings/PasskeyManagement.vue';
import TwoFactorAuthSettings from '../components/settings/TwoFactorAuthSettings.vue';
import CaptchaSettingsForm from '../components/settings/CaptchaSettingsForm.vue';
import IpWhitelistSettings from '../components/settings/IpWhitelistSettings.vue';
import IpBlacklistSettings from '../components/settings/IpBlacklistSettings.vue';
import AboutSection from '../components/settings/AboutSection.vue';
import WorkspaceSettingsSection from '../components/settings/WorkspaceSettingsSection.vue';
import SystemSettingsSection from '../components/settings/SystemSettingsSection.vue';
import DataManagementSection from '../components/settings/DataManagementSection.vue';
import AppearanceSection from '../components/settings/AppearanceSection.vue';
import { useDeviceDetection } from '../composables/useDeviceDetection';
import MobileSettingsView from './MobileSettingsView.vue';

const { isMobile } = useDeviceDetection();

const authStore = useAuthStore();
const settingsStore = useSettingsStore();
const appearanceStore = useAppearanceStore(); // 实例化外观 store
const { t } = useI18n();
const { isUpdateAvailable, checkLatestVersion } = useVersionCheck();

// Define tabs for settings sections
const tabs = ref([
  { key: 'workspace', label: t('settings.tabs.workspace', '工作区') },
  { key: 'system', label: t('settings.tabs.system', '系统') },
  { key: 'security', label: t('settings.tabs.security', '安全') },
  { key: 'ipControl', label: t('settings.tabs.ipControl', 'IP 管控') },
  { key: 'dataManagement', label: t('settings.tabs.dataManagement', '数据管理') },
  { key: 'appearance', label: t('settings.tabs.appearance', '外观') },
  { key: 'about', label: t('settings.tabs.about', '关于') },
]);
const activeTab = ref(tabs.value[0].key);

// --- Reactive state from store ---
// 使用 storeToRefs 获取响应式 getter，包括 language
const {
    settings,
    isLoading: settingsLoading,
    error: settingsError,
    language: storeLanguage,
} = storeToRefs(settingsStore);



onMounted(async () => {
  // await fetchIpBlacklist(); // REMOVED - Handled by useIpBlacklist.ts onMounted
  await settingsStore.loadCaptchaSettings(); // <-- Load CAPTCHA settings
  await checkLatestVersion(); // 检查版本更新
});

</script>

<style scoped>
/* Remove all scoped styles as they are now handled by Tailwind utility classes */
</style>

