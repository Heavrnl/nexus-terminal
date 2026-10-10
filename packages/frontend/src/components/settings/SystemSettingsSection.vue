<template>
  <div v-if="settings" class="bg-background border border-border rounded-lg shadow-sm overflow-hidden">
    <h2 class="text-lg font-semibold text-foreground px-6 py-4 border-b border-border bg-header/50">{{ $t('settings.category.system') }}</h2>
    <div class="p-6 space-y-6">
      <!-- Language -->
      <div class="settings-section-content">
         <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.language.title') }}</h3>
         <form @submit.prevent="handleUpdateLanguage" class="space-y-4">
           <div>
             <label for="languageSelect" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.language.selectLabel') }}</label>
             <select id="languageSelect" v-model="selectedLanguage"
                     class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary appearance-none bg-no-repeat bg-right pr-8"
                     style="background-image: url('data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3e%3cpath fill=\'none\' stroke=\'%236c757d\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M2 5l6 6 6-6\'/%3e%3c/svg%3e'); background-position: right 0.75rem center; background-size: 16px 12px;">
               <option v-for="locale in availableLocales" :key="locale" :value="locale">
                 {{ languageNames[locale] || locale }} <!-- Display mapped name or locale code -->
               </option>
             </select>
           </div>
           <div class="flex items-center justify-between">
              <button type="submit"
                      class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                {{ $t('settings.language.saveButton') }}
              </button>
              <p v-if="languageMessage" :class="['text-sm', languageSuccess ? 'text-success' : 'text-error']">{{ languageMessage }}</p>
           </div>
         </form>
      </div>
      <hr class="border-border/50"> <!-- Separator -->
      <!-- Timezone Setting -->
      <div class="settings-section-content">
         <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.timezone.title') }}</h3>
         <form @submit.prevent="handleUpdateTimezone" class="space-y-4">
           <div>
             <label for="timezoneSelect" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.timezone.selectLabel') }}</label>
             <select id="timezoneSelect" v-model="selectedTimezone"
                     class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary appearance-none bg-no-repeat bg-right pr-8"
                     style="background-image: url('data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3e%3cpath fill=\'none\' stroke=\'%236c757d\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M2 5l6 6 6-6\'/%3e%3c/svg%3e'); background-position: right 0.75rem center; background-size: 16px 12px;">
               <option v-for="tz in commonTimezones" :key="tz" :value="tz">
                 {{ tz }}
               </option>
             </select>
              <small class="block mt-1 text-xs text-text-secondary">{{ $t('settings.timezone.description') }}</small>
           </div>
           <div class="flex items-center justify-between">
              <button type="submit"
                      class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                {{ $t('common.save') }}
              </button>
              <p v-if="timezoneMessage" :class="['text-sm', timezoneSuccess ? 'text-success' : 'text-error']">{{ timezoneMessage }}</p>
           </div>
         </form>
      </div>

      <!-- Desktop Specific Setting: Window Close Behavior (仅在桌面客户端下展示) -->
      <div v-if="isDesktop" class="settings-section-content">
        <hr class="border-border/50 mb-6">
        <h3 class="text-base font-semibold text-foreground mb-3 flex items-center gap-2">
          <i class="fas fa-desktop text-primary"></i>
          {{ $t('settings.desktop.title', '桌面客户端设置') }}
        </h3>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-text-secondary mb-2">
              {{ $t('settings.desktop.closeBehaviorLabel', '关闭主窗口时') }}
            </label>
            <div class="space-y-2">
              <label class="flex items-center space-x-3 cursor-pointer select-none">
                <input
                  type="radio"
                  name="closeBehavior"
                  value="minimize_to_tray"
                  v-model="closeBehavior"
                  @change="handleUpdateCloseBehavior"
                  class="text-primary focus:ring-primary h-4 w-4 cursor-pointer"
                />
                <span class="text-sm text-foreground">
                  {{ $t('settings.desktop.minimizeToTray', '最小化到系统托盘') }}
                </span>
              </label>
              <label class="flex items-center space-x-3 cursor-pointer select-none">
                <input
                  type="radio"
                  name="closeBehavior"
                  value="quit"
                  v-model="closeBehavior"
                  @change="handleUpdateCloseBehavior"
                  class="text-primary focus:ring-primary h-4 w-4 cursor-pointer"
                />
                <span class="text-sm text-foreground">
                  {{ $t('settings.desktop.quitApp', '退出 Nexus Terminal') }}
                </span>
              </label>
            </div>
            
            <!-- 记住选择开关 (极简纯净) -->
            <div class="mt-3 pt-3 border-t border-border/50">
              <label class="flex items-center space-x-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  v-model="rememberCloseChoice"
                  @change="handleUpdateCloseBehavior"
                  class="rounded border-border text-primary focus:ring-primary h-4 w-4 cursor-pointer"
                />
                <span class="text-sm text-foreground">
                  {{ $t('settings.desktop.rememberChoice', '记住我的选择') }}
                </span>
              </label>
            </div>
          </div>
          <p v-if="desktopMessage" :class="['text-sm', desktopSuccess ? 'text-success' : 'text-error']">
            {{ desktopMessage }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useSettingsStore } from '../../stores/settings.store';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useSystemSettings } from '../../composables/settings/useSystemSettings';
import { isDesktopApp } from '../../utils/platform';
import axios from 'axios';

const settingsStore = useSettingsStore();
const { settings } = storeToRefs(settingsStore); 
const { t } = useI18n();

const {
  selectedLanguage,
  languageMessage,
  languageSuccess,
  languageNames,
  availableLocales,
  handleUpdateLanguage,
  selectedTimezone,
  timezoneMessage,
  timezoneSuccess,
  commonTimezones,
  handleUpdateTimezone,
} = useSystemSettings();

// --- 桌面客户端专属设置逻辑 ---
const isDesktop = ref(isDesktopApp());
const closeBehavior = ref<'minimize_to_tray' | 'quit'>('minimize_to_tray');
const rememberCloseChoice = ref(false);
const desktopMessage = ref('');
const desktopSuccess = ref(true);

onMounted(async () => {
  if (isDesktop.value) {
    // 优先从本地缓存快速回显
    const cached = localStorage.getItem('nexus_close_behavior');
    if (cached === 'quit' || cached === 'minimize_to_tray') {
      closeBehavior.value = cached;
    }
    const cachedRemember = localStorage.getItem('nexus_remember_close_choice');
    if (cachedRemember !== null) {
      rememberCloseChoice.value = cachedRemember === 'true';
    }

    // 从服务端/便携配置读取真实值
    try {
      const res = await axios.get('/api/v1/desktop/settings');
      if (res.data) {
        if (res.data.closeBehavior) {
          closeBehavior.value = res.data.closeBehavior;
          localStorage.setItem('nexus_close_behavior', res.data.closeBehavior);
        }
        if (typeof res.data.rememberCloseChoice === 'boolean') {
          rememberCloseChoice.value = res.data.rememberCloseChoice;
          localStorage.setItem('nexus_remember_close_choice', String(res.data.rememberCloseChoice));
        }
      }
    } catch (err) {
      console.warn('[DesktopSettings] 获取桌面端配置失败:', err);
    }
  }
});

const handleUpdateCloseBehavior = async () => {
  desktopMessage.value = '';
  try {
    localStorage.setItem('nexus_close_behavior', closeBehavior.value);
    localStorage.setItem('nexus_remember_close_choice', String(rememberCloseChoice.value));

    // 双通道同步 1: 请求后端接口更新便携配置文件 data/desktop-settings.json
    await axios.put('/api/v1/desktop/settings', {
      closeBehavior: closeBehavior.value,
      rememberCloseChoice: rememberCloseChoice.value,
    });

    // 双通道同步 2: 如果存在 Tauri IPC，同步调用 Tauri 命令
    try {
      const tauri = (window as any).__TAURI__;
      if (tauri?.core?.invoke) {
        await tauri.core.invoke('set_desktop_settings', {
          closeBehavior: closeBehavior.value,
          rememberCloseChoice: rememberCloseChoice.value,
        });
      }
    } catch {}

    desktopSuccess.value = true;
    desktopMessage.value = t('common.saved', '已保存');
    setTimeout(() => {
      desktopMessage.value = '';
    }, 2500);
  } catch (err: any) {
    desktopSuccess.value = false;
    desktopMessage.value = err.response?.data?.error || t('common.saveFailed', '保存失败');
  }
};
</script>

