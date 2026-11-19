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
             <AppSelect id="languageSelect" v-model="selectedLanguage"
                     class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary appearance-none bg-no-repeat bg-right pr-8">
               <option v-for="locale in availableLocales" :key="locale" :value="locale">
                 {{ languageNames[locale] || locale }} <!-- Display mapped name or locale code -->
               </option>
             </AppSelect>
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
             <AppSelect id="timezoneSelect" v-model="selectedTimezone"
                     class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary appearance-none bg-no-repeat bg-right pr-8">
               <option v-for="tz in commonTimezones" :key="tz" :value="tz">
                 {{ tz }}
               </option>
             </AppSelect>
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

      <hr class="border-border/50"> <!-- Separator -->
      <!-- Remember Last Route Setting (极简单行纯净开关) -->
      <div class="settings-section-content">
        <div class="flex items-center justify-between">
          <h3 class="text-base font-semibold text-foreground">
            {{ $t('settings.rememberLastRoute.title') }}
          </h3>
          <!-- 纯 Switch 滑块开关 -->
          <button
            type="button"
            @click="handleToggleRememberLastRoute"
            :disabled="isUpdatingRememberRoute"
            :class="[
              'relative inline-flex flex-shrink-0 h-6 w-11 border-2 border-transparent rounded-full cursor-pointer transition-colors ease-in-out duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary',
              rememberLastRouteBoolean ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
            ]"
            role="switch"
            :aria-checked="rememberLastRouteBoolean"
          >
            <span
              aria-hidden="true"
              :class="[
                'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform ring-0 transition ease-in-out duration-200',
                rememberLastRouteBoolean ? 'translate-x-5' : 'translate-x-0'
              ]"
            ></span>
          </button>
        </div>
        <p v-if="rememberRouteMessage" :class="['text-xs mt-2', rememberRouteSuccess ? 'text-success' : 'text-error']">
          {{ rememberRouteMessage }}
        </p>
      </div>

      <hr class="border-border/50"> <!-- Separator -->
      <!-- 测试连接超时（Issue #123） -->
      <div class="settings-section-content">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <h3 class="text-base font-semibold text-foreground">{{ $t('settings.testTimeout.title', '测试连接超时') }}</h3>
          <div class="flex items-center gap-3 flex-wrap">
            <div class="relative flex items-center">
              <input
                type="number"
                id="connectionTestTimeout"
                v-model.number="testTimeoutLocal"
                min="5"
                max="120"
                step="1"
                @change="handleUpdateTestTimeout"
                @keydown.enter.prevent="handleUpdateTestTimeout"
                class="w-28 sm:w-32 h-9 px-3 text-sm border border-border rounded-lg shadow-2xs bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              />
              <span class="text-sm text-text-secondary ml-2 shrink-0">{{ $t('settings.testTimeout.unit', '秒') }}</span>
            </div>
            <span v-if="testTimeoutMessage" :class="['text-sm', testTimeoutSuccess ? 'text-success' : 'text-error']">
              {{ testTimeoutMessage }}
            </span>
          </div>
        </div>
      </div>

      <!-- Cloud Server Sync API Key Setting (仅在 Web / 云端部署环境下展示) -->
      <div v-if="!isDesktop" class="settings-section-content">
        <hr class="border-border/50 mb-6">
        <h3 class="text-base font-semibold text-foreground mb-3 flex items-center justify-between">
          <span class="flex items-center gap-2">
            <i class="fas fa-key text-primary"></i>
            {{ $t('settings.serverSync.title', '数据同步服务密钥 (API Key)') }}
          </span>
        </h3>
        <p class="text-xs text-text-secondary mb-3">
          {{ $t('settings.serverSync.description', '用于桌面端与本云端服务器进行双向数据同步鉴权与加密通信。密钥直接持久化保存在数据库中，修改后即刻生效，无需配置环境变量或重启服务。') }}
        </p>

        <form @submit.prevent="handleSaveServerApiKey" class="space-y-3.5">
          <div>
            <label class="block text-xs font-medium text-text-secondary mb-1">
              {{ $t('settings.serverSync.keyLabel', '同步 API Key') }}
            </label>
            <div class="relative">
              <input
                :type="showServerApiKey ? 'text' : 'password'"
                v-model="serverApiKey"
                placeholder="请输入用于客户端同步鉴权的 API Key"
                class="w-full px-3 py-1.5 pr-24 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-sm font-mono"
              />
              <div class="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
                <button
                  type="button"
                  @click="showServerApiKey = !showServerApiKey"
                  :title="showServerApiKey ? '隐藏密钥' : '显示密钥'"
                  class="p-1 text-text-secondary hover:text-foreground text-xs cursor-pointer"
                >
                  <i :class="showServerApiKey ? 'fas fa-eye-slash' : 'fas fa-eye'"></i>
                </button>
                <button
                  type="button"
                  @click="handleCopyServerApiKey"
                  title="复制密钥"
                  class="p-1 text-text-secondary hover:text-foreground text-xs cursor-pointer"
                >
                  <i class="fas fa-copy"></i>
                </button>
                <button
                  type="button"
                  @click="handleGenerateServerApiKey"
                  title="随机生成新密钥"
                  class="p-1 text-text-secondary hover:text-foreground text-xs cursor-pointer"
                >
                  <i class="fas fa-dice"></i>
                </button>
              </div>
            </div>
          </div>

          <!-- 提示信息 -->
          <div v-if="serverApiKeyMessage" :class="['text-xs flex items-center gap-1.5', serverApiKeySuccess ? 'text-success' : 'text-error']">
            <i :class="serverApiKeySuccess ? 'fas fa-check-circle' : 'fas fa-exclamation-triangle'"></i>
            {{ serverApiKeyMessage }}
          </div>

          <div class="flex items-center gap-2.5 pt-1">
            <button
              type="submit"
              :disabled="isSavingServerApiKey || !serverApiKey.trim()"
              class="px-3 py-1.5 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover disabled:opacity-50 transition text-xs font-medium flex items-center gap-1.5 cursor-pointer"
            >
              <i v-if="isSavingServerApiKey" class="fas fa-spinner fa-spin"></i>
              <i v-else class="fas fa-save"></i>
              {{ $t('common.save', '保存密钥') }}
            </button>
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

      <!-- Desktop Specific Setting: Cloud Sync (仅在桌面独立客户端下展示) -->
      <div v-if="isDesktop" class="settings-section-content">
        <hr class="border-border/50 my-6">
        <h3 class="text-base font-semibold text-foreground mb-3 flex items-center justify-between">
          <span class="flex items-center gap-2">
            <i class="fas fa-cloud text-primary"></i>
            {{ $t('settings.desktop.cloudSyncTitle', '云端数据同步') }}
          </span>
          <span v-if="desktopSyncStore.lastSyncTime > 0" class="text-xs font-normal text-text-secondary">
            {{ $t('settings.desktop.lastSynced', '上次同步') }}: {{ formatSyncTime(desktopSyncStore.lastSyncTime) }}
          </span>
        </h3>

        <form @submit.prevent="handleSaveSyncConfig" class="space-y-3.5">
          <!-- 服务器地址输入 -->
          <div>
            <label class="block text-xs font-medium text-text-secondary mb-1">
              {{ $t('settings.desktop.vpsUrlLabel', '服务器地址') }}
            </label>
            <input
              type="text"
              v-model="syncVpsUrl"
              placeholder="https://vps.example.com"
              class="w-full px-3 py-1.5 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-sm"
            />
          </div>

          <!-- API Key 输入 -->
          <div>
            <label class="block text-xs font-medium text-text-secondary mb-1">
              {{ $t('settings.desktop.syncApiKeyLabel', 'API Key') }}
            </label>
            <div class="relative">
              <input
                :type="showApiKey ? 'text' : 'password'"
                v-model="syncApiKey"
                :placeholder="desktopSyncStore.hasApiKey ? `已配置 (${desktopSyncStore.apiKeyMasked || '****'})，留空则保持不变` : '输入 API Key'"
                class="w-full px-3 py-1.5 pr-10 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-sm font-mono"
              />
              <button
                type="button"
                @click="showApiKey = !showApiKey"
                class="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary hover:text-foreground text-xs"
              >
                <i :class="showApiKey ? 'fas fa-eye-slash' : 'fas fa-eye'"></i>
              </button>
            </div>
          </div>

          <!-- 同步内容范围：大类 + 可展开的细项 -->
          <div class="pt-2 border-t border-border/40">
            <div class="flex items-center justify-between mb-2">
              <label class="text-xs font-medium text-text-secondary">
                {{ $t('settings.desktop.syncModulesTitle', '同步内容范围') }}
              </label>
              <div class="flex items-center gap-2 text-xs">
                <span class="text-text-secondary/70">
                  {{ desktopSyncStore.selectedModules.length }}/{{ ALL_SYNC_ITEM_KEYS.length }}
                </span>
                <button
                  type="button"
                  @click="handleSelectAllModules"
                  class="text-primary hover:underline cursor-pointer"
                >
                  {{ $t('common.selectAll', '全选') }}
                </button>
                <span class="text-border">|</span>
                <button
                  type="button"
                  @click="handleInvertModules"
                  class="text-text-secondary hover:text-foreground cursor-pointer"
                >
                  {{ $t('common.invertSelection', '反选') }}
                </button>
              </div>
            </div>

            <div class="space-y-1.5">
              <div
                v-for="cat in SYNC_CATEGORIES"
                :key="cat.key"
                class="rounded-lg border border-border/60 bg-background/50 overflow-hidden"
              >
                <!-- 大类行 -->
                <div class="flex items-center gap-2 px-2.5 py-1.5 hover:bg-header/40 transition-colors">
                  <input
                    type="checkbox"
                    :checked="isCategoryFullySelected(cat.key)"
                    :indeterminate="isCategoryPartiallySelected(cat.key)"
                    @change="handleToggleCategory(cat.key)"
                    class="rounded border-border text-primary focus:ring-primary h-3.5 w-3.5 cursor-pointer shrink-0"
                  />
                  <button
                    type="button"
                    @click="toggleCategoryExpanded(cat.key)"
                    class="flex-1 flex items-center gap-2 text-left cursor-pointer min-w-0"
                  >
                    <span class="text-xs font-medium text-foreground shrink-0">{{ cat.label }}</span>
                    <span class="text-[11px] text-text-secondary/70 truncate">{{ cat.description }}</span>
                    <span class="ml-auto flex items-center gap-1.5 shrink-0">
                      <span class="text-[10px] text-text-secondary/70 tabular-nums">
                        {{ selectedCountInCategory(cat.key) }}/{{ SYNC_CATEGORY_ITEM_KEYS[cat.key].length }}
                      </span>
                      <i
                        class="fas text-[10px] text-text-secondary"
                        :class="expandedCategories.includes(cat.key) ? 'fa-chevron-up' : 'fa-chevron-down'"
                      ></i>
                    </span>
                  </button>
                </div>

                <!-- 细项（展开后可见） -->
                <div
                  v-if="expandedCategories.includes(cat.key)"
                  class="px-2.5 pb-2 pt-0.5 grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1 border-t border-border/40"
                >
                  <label
                    v-for="item in cat.items"
                    :key="item.key"
                    class="flex items-start gap-2 py-1 cursor-pointer select-none rounded hover:bg-header/30 px-1"
                    :title="item.description"
                  >
                    <input
                      type="checkbox"
                      :checked="desktopSyncStore.selectedModules.includes(item.key)"
                      @change="handleToggleModule(item.key)"
                      class="rounded border-border text-primary focus:ring-primary h-3.5 w-3.5 cursor-pointer mt-0.5 shrink-0"
                    />
                    <span class="min-w-0">
                      <span class="block text-[11px] font-medium text-foreground leading-tight">{{ item.label }}</span>
                      <span class="block text-[10px] text-text-secondary/70 leading-tight truncate">{{ item.description }}</span>
                    </span>
                  </label>
                </div>
              </div>
            </div>

            <p v-if="desktopSyncStore.selectedModules.length === 0" class="text-[11px] text-warning mt-1.5">
              至少需要保留一项同步内容
            </p>
          </div>

          <!-- 对齐策略 (极简单行) -->
          <div class="flex items-center justify-between text-xs text-text-secondary pt-0.5">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="text-text-secondary">当前模式:</span>
              <span class="font-medium text-foreground px-1.5 py-0.5 rounded bg-muted/40 border border-border/60 text-[11px]">
                {{ currentSyncModeLabel }}
              </span>
            </div>
            <button
              type="button"
              @click="desktopSyncStore.showFirstSyncModal = true"
              class="text-primary hover:underline font-medium cursor-pointer"
            >
              {{ $t('settings.desktop.chooseAlignment', '对齐向导') }}
            </button>
          </div>
          <div class="text-[11px] text-text-secondary/80 flex items-center gap-1.5">
            <i class="fas fa-info-circle text-[10px]"></i>
            <span>各节点登录账号密码独立存储，同步仅涵盖主机资产、密钥与外观设置。</span>
          </div>

          <!-- 状态提示 -->
          <div v-if="desktopSyncStore.testLatency !== null" class="text-xs text-success flex items-center gap-1.5">
            <i class="fas fa-check-circle"></i>
            {{ $t('settings.desktop.testSuccess', '连通正常') }} ({{ desktopSyncStore.testLatency }}ms)
          </div>
          <div v-if="desktopSyncStore.testError" class="text-xs text-error flex items-center gap-1.5">
            <i class="fas fa-exclamation-triangle"></i>
            {{ desktopSyncStore.testError }}
          </div>
          <div v-if="desktopSyncStore.syncSuccessMessage" class="text-xs text-success flex items-center gap-1.5">
            <i class="fas fa-check-circle"></i>
            {{ desktopSyncStore.syncSuccessMessage }}
          </div>
          <div v-if="desktopSyncStore.syncError" class="text-xs text-error flex items-center gap-1.5">
            <i class="fas fa-exclamation-triangle"></i>
            {{ desktopSyncStore.syncError }}
          </div>

          <!-- 操作按钮组 -->
          <div class="flex items-center gap-2.5 pt-1">
            <!-- 测试连接 -->
            <button
              type="button"
              @click="handleTestSyncConnection"
              :disabled="!syncVpsUrl.trim() || (!syncApiKey.trim() && !desktopSyncStore.hasApiKey) || desktopSyncStore.isTesting"
              class="px-3 py-1.5 border border-border bg-header text-foreground rounded-md shadow-sm hover:bg-border disabled:opacity-50 disabled:cursor-not-allowed transition text-xs font-medium flex items-center gap-1.5"
            >
              <i v-if="desktopSyncStore.isTesting" class="fas fa-spinner fa-spin"></i>
              <i v-else class="fas fa-plug"></i>
              {{ desktopSyncStore.isTesting ? $t('settings.desktop.testing', '测试中...') : $t('settings.desktop.testConnection', '测试连接') }}
            </button>

            <!-- 保存配置 -->
            <button
              type="submit"
              :disabled="isSavingSync"
              class="px-3 py-1.5 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover disabled:opacity-50 transition text-xs font-medium flex items-center gap-1.5"
            >
              <i v-if="isSavingSync" class="fas fa-spinner fa-spin"></i>
              <i v-else class="fas fa-save"></i>
              {{ $t('common.save', '保存设置') }}
            </button>

            <!-- 立即同步 (仅在配置有效时可点击，否则禁用置灰) -->
            <button
              type="button"
              @click="handleTriggerSyncNow"
              :disabled="!isSyncButtonEnabled"
              :title="isSyncButtonEnabled ? `立即同步 (当前模式: ${currentSyncModeLabel})` : $t('settings.desktop.syncDisabledTooltip', '请先配置服务器地址和 API Key')"
              class="px-3 py-1.5 rounded-md shadow-sm transition text-xs font-medium flex items-center gap-1.5 ml-auto"
              :class="isSyncButtonEnabled ? 'bg-primary text-white hover:bg-primary/90 cursor-pointer' : 'bg-border/60 text-text-secondary cursor-not-allowed opacity-50'"
            >
              <i class="fas fa-sync-alt"></i>
              {{ $t('settings.desktop.syncNow', '立即同步') }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useSettingsStore } from '../../stores/settings.store';
import {
  useDesktopSyncStore,
  SYNC_CATEGORIES,
  SYNC_CATEGORY_ITEM_KEYS,
  ALL_SYNC_ITEM_KEYS,
  type SyncCategoryKey,
  type SyncItemKey
} from '../../stores/desktopSync.store';
import { useWorkspaceSyncStore } from '../../stores/workspaceSync.store';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useSystemSettings } from '../../composables/settings/useSystemSettings';
import { isDesktopApp } from '../../utils/platform';
import axios from 'axios';
import AppSelect from '../common/AppSelect.vue';

const settingsStore = useSettingsStore();
const desktopSyncStore = useDesktopSyncStore();
const { settings, rememberLastRouteBoolean } = storeToRefs(settingsStore);
const { setRememberLastRoute } = settingsStore;

// --- 路由记忆设置状态 ---
const isUpdatingRememberRoute = ref(false);
const rememberRouteMessage = ref('');
const rememberRouteSuccess = ref(true);

const handleToggleRememberLastRoute = async () => {
  if (isUpdatingRememberRoute.value) return;
  const newValue = !rememberLastRouteBoolean.value;
  isUpdatingRememberRoute.value = true;
  rememberRouteMessage.value = '';
  try {
    await setRememberLastRoute(newValue);
    rememberRouteSuccess.value = true;
    rememberRouteMessage.value = newValue
      ? t('settings.rememberLastRoute.enabledSuccess')
      : t('settings.rememberLastRoute.disabledSuccess');
    setTimeout(() => {
      rememberRouteMessage.value = '';
    }, 3000);
  } catch (err: any) {
    rememberRouteSuccess.value = false;
    rememberRouteMessage.value = err.message || t('common.saveFailed', '保存设置失败');
  } finally {
    isUpdatingRememberRoute.value = false;
  }
}; 
const { t } = useI18n();

// --- 测试连接超时（Issue #123） ---
const TEST_TIMEOUT_MIN = 5;
const TEST_TIMEOUT_MAX = 120;
const testTimeoutLocal = ref(15);
const testTimeoutMessage = ref('');
const testTimeoutSuccess = ref(true);

watch(
  () => settings.value?.connectionTestTimeoutSeconds,
  (val) => {
    const n = parseInt(String(val ?? ''), 10);
    if (!isNaN(n) && n > 0) testTimeoutLocal.value = n;
  },
  { immediate: true }
);

const handleUpdateTestTimeout = async () => {
  let n = Number(testTimeoutLocal.value);
  if (!Number.isFinite(n) || n <= 0) n = 15;
  n = Math.min(TEST_TIMEOUT_MAX, Math.max(TEST_TIMEOUT_MIN, Math.round(n)));
  testTimeoutLocal.value = n;
  if (String(settings.value?.connectionTestTimeoutSeconds ?? '') === String(n)) return;
  testTimeoutMessage.value = '';
  try {
    await settingsStore.updateSetting('connectionTestTimeoutSeconds', String(n));
    testTimeoutSuccess.value = true;
    testTimeoutMessage.value = t('settings.testTimeout.saved', '已保存');
    setTimeout(() => { testTimeoutMessage.value = ''; }, 2000);
  } catch (err: any) {
    testTimeoutSuccess.value = false;
    testTimeoutMessage.value = err?.message || t('common.saveFailed', '保存设置失败');
  }
};

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

// --- 云端服务端 API Key 设置状态 (Web 云端环境独有) ---
const serverApiKey = ref('');
const showServerApiKey = ref(false);
const isSavingServerApiKey = ref(false);
const serverApiKeyMessage = ref('');
const serverApiKeySuccess = ref(true);

const fetchServerApiKey = async () => {
  try {
    const res = await axios.get('/api/v1/settings/sync-api-key');
    if (res.data && res.data.success && res.data.apiKey) {
      serverApiKey.value = res.data.apiKey;
    }
  } catch (err: any) {
    console.warn('[SystemSettings] 获取同步 API Key 失败:', err);
  }
};

const handleSaveServerApiKey = async () => {
  if (!serverApiKey.value.trim()) return;
  isSavingServerApiKey.value = true;
  serverApiKeyMessage.value = '';
  try {
    const res = await axios.put('/api/v1/settings/sync-api-key', {
      apiKey: serverApiKey.value.trim()
    });
    if (res.data && res.data.success) {
      serverApiKeySuccess.value = true;
      serverApiKeyMessage.value = t('common.saved', '同步 API Key 已成功保存至数据库');
      setTimeout(() => {
        if (serverApiKeyMessage.value === t('common.saved', '同步 API Key 已成功保存至数据库')) {
          serverApiKeyMessage.value = '';
        }
      }, 3000);
    } else {
      serverApiKeySuccess.value = false;
      serverApiKeyMessage.value = res.data?.error || t('common.saveFailed', '保存失败');
    }
  } catch (err: any) {
    serverApiKeySuccess.value = false;
    serverApiKeyMessage.value = err.response?.data?.error || err.message || t('common.saveFailed', '保存失败');
  } finally {
    isSavingServerApiKey.value = false;
  }
};

const handleCopyServerApiKey = async () => {
  if (!serverApiKey.value) return;
  try {
    await navigator.clipboard.writeText(serverApiKey.value);
    serverApiKeySuccess.value = true;
    serverApiKeyMessage.value = 'API Key 已复制到剪贴板';
    setTimeout(() => {
      if (serverApiKeyMessage.value === 'API Key 已复制到剪贴板') {
        serverApiKeyMessage.value = '';
      }
    }, 2500);
  } catch (e) {
    serverApiKeySuccess.value = false;
    serverApiKeyMessage.value = '复制失败，请手动选中复制';
  }
};

const handleGenerateServerApiKey = () => {
  const array = new Uint8Array(16);
  window.crypto.getRandomValues(array);
  const randomHex = Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
  serverApiKey.value = `nexus-sync-${randomHex}`;
  serverApiKeySuccess.value = true;
  serverApiKeyMessage.value = '已生成新密钥，请点击保存以持久化到数据库';
};
const closeBehavior = ref<'minimize_to_tray' | 'quit'>('minimize_to_tray');
const rememberCloseChoice = ref(false);
const desktopMessage = ref('');
const desktopSuccess = ref(true);

// --- 云端同步表单状态 ---
const syncVpsUrl = ref('');
const syncApiKey = ref('');
const showApiKey = ref(false);
const isSavingSync = ref(false);

// --- 同步范围（大类 + 细项）---
const expandedCategories = ref<SyncCategoryKey[]>(['connections']);

const toggleCategoryExpanded = (key: SyncCategoryKey) => {
  const idx = expandedCategories.value.indexOf(key);
  if (idx > -1) expandedCategories.value.splice(idx, 1);
  else expandedCategories.value.push(key);
};

const selectedCountInCategory = (key: SyncCategoryKey) => {
  return SYNC_CATEGORY_ITEM_KEYS[key].filter(k => desktopSyncStore.selectedModules.includes(k)).length;
};

const isCategoryFullySelected = (key: SyncCategoryKey) => {
  return selectedCountInCategory(key) === SYNC_CATEGORY_ITEM_KEYS[key].length;
};

const isCategoryPartiallySelected = (key: SyncCategoryKey) => {
  const count = selectedCountInCategory(key);
  return count > 0 && count < SYNC_CATEGORY_ITEM_KEYS[key].length;
};

const handleToggleCategory = (key: SyncCategoryKey) => {
  const catKeys = SYNC_CATEGORY_ITEM_KEYS[key];
  const current = [...desktopSyncStore.selectedModules];
  if (isCategoryFullySelected(key)) {
    // 整类取消；若取消后一项都不剩则保留（至少一项的防呆）
    const next = current.filter(k => !catKeys.includes(k));
    if (next.length === 0) return;
    desktopSyncStore.setSelectedModules(next);
  } else {
    const next = new Set<SyncItemKey>([...current, ...catKeys]);
    desktopSyncStore.setSelectedModules([...next]);
  }
};

const handleToggleModule = (key: SyncItemKey) => {
  const current = [...desktopSyncStore.selectedModules];
  const idx = current.indexOf(key);
  if (idx > -1) {
    if (current.length === 1) {
      return; // 至少保留一项，防呆
    }
    current.splice(idx, 1);
  } else {
    current.push(key);
  }
  desktopSyncStore.setSelectedModules(current);
};

const handleSelectAllModules = () => {
  desktopSyncStore.setSelectedModules([...ALL_SYNC_ITEM_KEYS]);
};

const handleInvertModules = () => {
  const inverted = ALL_SYNC_ITEM_KEYS.filter(k => !desktopSyncStore.selectedModules.includes(k));
  if (inverted.length === 0) {
    desktopSyncStore.setSelectedModules([...ALL_SYNC_ITEM_KEYS]);
  } else {
    desktopSyncStore.setSelectedModules(inverted);
  }
};

/**
 * 云端同步按钮是否允许点击 (只有配置了域名和 apikey 才可以点击，否则禁用置灰)
 */
const isSyncButtonEnabled = computed(() => {
  const hasKey = syncApiKey.value.trim().length > 0 || desktopSyncStore.hasApiKey;
  return syncVpsUrl.value.trim().length > 0 && hasKey && desktopSyncStore.selectedModules.length > 0;
});

const currentSyncModeLabel = computed(() => {
  switch (desktopSyncStore.syncMode) {
    case 'cloud_to_local':
      return '以云端 VPS 为准 (覆盖本地)';
    case 'local_to_cloud':
      return '以当前本地为准 (覆盖云端)';
    case 'bidirectional':
    default:
      return '智能双向合并 (推荐)';
  }
});

const formatSyncTime = (timestamp: number) => {
  if (!timestamp) return '从未';
  // 如果是秒级时间戳转换为毫秒级
  const date = new Date(timestamp > 1e11 ? timestamp : timestamp * 1000);
  return date.toLocaleString();
};

onMounted(async () => {
  if (isDesktop.value) {
    // 优先从本地缓存快速回显关闭行为
    const cached = localStorage.getItem('nexus_close_behavior');
    if (cached === 'quit' || cached === 'minimize_to_tray') {
      closeBehavior.value = cached;
    }
    const cachedRemember = localStorage.getItem('nexus_remember_close_choice');
    if (cachedRemember !== null) {
      rememberCloseChoice.value = cachedRemember === 'true';
    }

    // 读取桌面端设置与同步配置
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

    // 加载同步配置
    try {
      await desktopSyncStore.fetchConfig();
      syncVpsUrl.value = desktopSyncStore.vpsUrl;
      syncApiKey.value = desktopSyncStore.apiKey;
    } catch (err) {
      console.warn('[DesktopSettings] 获取云端同步配置失败:', err);
    }
  } else {
    fetchServerApiKey();
  }
});

const handleSaveSyncConfig = async () => {
  isSavingSync.value = true;
  desktopSyncStore.syncError = null;
  desktopSyncStore.syncSuccessMessage = null;
  try {
    await desktopSyncStore.saveConfig({
      vpsUrl: syncVpsUrl.value,
      ...(syncApiKey.value.trim() ? { apiKey: syncApiKey.value.trim() } : {}),
    });
    syncApiKey.value = '';
    desktopSyncStore.syncSuccessMessage = t('common.saved', '配置已保存');
    setTimeout(() => {
      if (desktopSyncStore.syncSuccessMessage === t('common.saved', '配置已保存')) {
        desktopSyncStore.syncSuccessMessage = null;
      }
    }, 2500);
  } catch (err: any) {
    desktopSyncStore.syncError = err.message || t('common.saveFailed', '保存失败');
  } finally {
    isSavingSync.value = false;
  }
};

const handleTestSyncConnection = async () => {
  desktopSyncStore.syncError = null;
  desktopSyncStore.syncSuccessMessage = null;
  await desktopSyncStore.testConnection(syncVpsUrl.value, syncApiKey.value);
};

const handleTriggerSyncNow = async () => {
  if (!isSyncButtonEnabled.value) return;
  // 先自动保存一次最新配置
  await handleSaveSyncConfig();
  try {
    const wsStore = useWorkspaceSyncStore();
    // 桌面端不触发工作区动态快照保存
  } catch {}
  await desktopSyncStore.requestSync();
};

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

