import { defineStore } from 'pinia';
import apiClient from '../utils/apiClient'; // 使用统一的 apiClient
import { ref, computed } from 'vue'; // 移除 watch
import i18n, { setLocale, defaultLng, availableLocales } from '../i18n'; // Import i18n instance, setLocale, defaultLng, and availableLocales
import type { PaneName } from './layout.store';
import { useAuthStore } from './auth.store';
import type { ConnectionInfo } from './connections.store';

export type SortField = keyof Pick<ConnectionInfo, 'created_at' | 'last_connected_at' | 'updated_at' | 'name' | 'type'>;
export type SortOrder = 'asc' | 'desc';

// Assuming manual definition for now if no shared types exist:
type CaptchaProvider = 'hcaptcha' | 'recaptcha' | 'none';
interface CaptchaSettings {
    enabled: boolean;
    provider: CaptchaProvider;
    hcaptchaSiteKey?: string;
    hcaptchaSecretKey?: string; // Store locally but don't expose via getters easily
    recaptchaSiteKey?: string;
    recaptchaSecretKey?: string; // Store locally but don't expose via getters easily
}
interface UpdateCaptchaSettingsDto {
    enabled?: boolean;
    provider?: CaptchaProvider;
    hcaptchaSiteKey?: string;
    hcaptchaSecretKey?: string;
    recaptchaSiteKey?: string;
    recaptchaSecretKey?: string;
}
// 移除 ITheme 和默认主题定义，这些移到 appearance.store.ts

// 定义通用设置状态类型
interface SettingsState {
  language?: string; // 改为 string 以支持动态语言
  ipWhitelist?: string;
  maxLoginAttempts?: string;
  loginBanDuration?: string;
  showPopupFileEditor?: string; // 'true' or 'false'
  shareFileEditorTabs?: string; // 'true' or 'false'
  ipWhitelistEnabled?: string; // 添加 IP 白名单启用状态 'true' or 'false'
  autoCopyOnSelect?: string; // 'true' or 'false' - 终端选中自动复制
  dockerStatusIntervalSeconds?: string; // Docker 状态刷新间隔 (秒)
  dockerDefaultExpand?: string; // Docker 默认展开详情 'true' or 'false'
  statusMonitorIntervalSeconds?: string; // 状态监控轮询间隔 (秒)
  workspaceSidebarPersistent?: string; // 工作区侧边栏是否固定 'true' or 'false'
  sidebarPaneWidths?: string; // 存储各侧边栏组件宽度的 JSON 字符串
  fileManagerRowSizeMultiplier?: string; // 文件管理器行大小乘数 (e.g., '1.0')
  fileManagerColWidths?: string; // 文件管理器列宽 JSON 字符串 (e.g., '{"name": 300, "size": 100}')
  commandInputSyncTarget?: 'quickCommands' | 'commandHistory' | 'none'; // 命令输入同步目标
  timezone?: string; // 时区设置 (e.g., 'Asia/Shanghai', 'UTC')
  rdpModalWidth?: string; // RDP 模态框宽度
  rdpModalHeight?: string; // RDP 模态框高度
  ipBlacklistEnabled?: string;
  dashboardSortBy?: SortField;
  dashboardSortOrder?: SortOrder;
  showConnectionTags?: string; // 'true' or 'false'
  showQuickCommandTags?: string; // 'true' or 'false'
  layoutLocked?: string; // 'true' or 'false' - NEW: 布局锁定状态
  terminalScrollbackLimit?: string; // 终端回滚行数上限 (e.g., '5000', '0' for unlimited)
  fileManagerShowDeleteConfirmation?: string; // 'true' or 'false' - 文件管理器删除确认提示
  // --- Auto Login Settings ---
  autoLoginIpWhitelistEnabled?: string; // 'true' or 'false'
  autoLoginIpWhitelistAllowedIPs?: string; // Comma-separated IPs
  // --- End Auto Login Settings ---
  [key: string]: string | undefined;
}


export const useSettingsStore = defineStore('settings', () => {
  const authStore = useAuthStore(); // <--- 实例化 authStore

  // --- State ---
  const settings = ref<Partial<SettingsState>>({}); // 通用设置状态 (包含新增的 autoLogin 字段)
  const parsedSidebarPaneWidths = ref<Record<string, string>>({}); // 解析后的侧边栏宽度对象
  const parsedFileManagerColWidths = ref<Record<string, number>>({}); // 解析后的文件管理器列宽对象
  const captchaSettings = ref<CaptchaSettings | null>(null); // CAPTCHA 设置状态
  const isLoading = ref(false);
  const error = ref<string | null>(null);
  // 移除外观相关状态: isStyleCustomizerVisible, currentUiTheme, currentXtermTheme

  // --- Actions ---

  /**
   * Fetches general settings from the backend and updates the store state.
   * Also sets the i18n locale based on the fetched language setting.
   */
  async function loadInitialSettings() {
    isLoading.value = true;
    error.value = null;
    let determinedLang: string | undefined; // 使用 string 类型

    try {
      console.log('[SettingsStore] 加载通用设置...');
      // Fetch all settings, including the new ones
      const [
        generalSettingsResponse,
        showConnectionTagsResponse,
        showQuickCommandTagsResponse
      ] = await Promise.all([
        apiClient.get<Record<string, string>>('/settings'),
        apiClient.get<{ enabled: boolean }>('/settings/show-connection-tags'),
        apiClient.get<{ enabled: boolean }>('/settings/show-quick-command-tags')
      ]);

      settings.value = generalSettingsResponse.data; // Store fetched general settings

      // Store the specific boolean settings
      settings.value.showConnectionTags = String(showConnectionTagsResponse.data.enabled);
      settings.value.showQuickCommandTags = String(showQuickCommandTagsResponse.data.enabled);

      // --- 更详细的日志 ---
      console.log('[SettingsStore] Fetched settings from backend:', JSON.stringify(settings.value));

      // --- 设置默认值 (如果后端未返回) ---
      if (settings.value.showPopupFileEditor === undefined) {
          settings.value.showPopupFileEditor = 'true';
      }
      if (settings.value.shareFileEditorTabs === undefined) {
          settings.value.shareFileEditorTabs = 'true';
      }
      if (settings.value.ipWhitelistEnabled === undefined) {
          settings.value.ipWhitelistEnabled = 'false'; // 默认禁用 IP 白名单
      }
      if (settings.value.maxLoginAttempts === undefined) {
          settings.value.maxLoginAttempts = '5'; // 默认 5 次
      }
       if (settings.value.loginBanDuration === undefined) {
          settings.value.loginBanDuration = '300'; // 默认 300 秒
      }


      // IP Blacklist enabled default
      if (settings.value.ipBlacklistEnabled === undefined) {
          settings.value.ipBlacklistEnabled = 'true'; // 默认启用 IP 黑名单
      }

      if (settings.value.autoCopyOnSelect === undefined) {
          settings.value.autoCopyOnSelect = 'false'; // 默认禁用选中即复制
      }
      // Docker setting defaults
      if (settings.value.dockerStatusIntervalSeconds === undefined) {
          settings.value.dockerStatusIntervalSeconds = '2'; // 默认 2 秒
      }
      if (settings.value.dockerDefaultExpand === undefined) {
          settings.value.dockerDefaultExpand = 'false'; // 默认不展开
      }
      // Status Monitor interval default
      if (settings.value.statusMonitorIntervalSeconds === undefined) {
          settings.value.statusMonitorIntervalSeconds = '3'; // 默认 3 秒
      }
      // Workspace sidebar persistent default
      if (settings.value.workspaceSidebarPersistent === undefined) {
          settings.value.workspaceSidebarPersistent = 'false'; // 默认不固定
      }
      // Load and parse sidebar pane widths
      const defaultPaneWidth = '350px';
      //  Ensure PaneName type is available or define it here 
      const knownPanes: PaneName[] = ['connections', 'fileManager', 'editor', 'statusMonitor', 'commandHistory', 'quickCommands', 'dockerManager']; // Add all possible sidebar panes
      let loadedWidths: Record<string, string> = {};
      try {
          if (settings.value.sidebarPaneWidths) {
              loadedWidths = JSON.parse(settings.value.sidebarPaneWidths);
              if (typeof loadedWidths !== 'object' || loadedWidths === null) {
                  console.warn('[SettingsStore] Invalid sidebarPaneWidths format loaded, resetting.');
                  loadedWidths = {};
              }
          }
      } catch (e) {
          console.error('[SettingsStore] Failed to parse sidebarPaneWidths, resetting.', e);
          loadedWidths = {};
      }
      // Ensure defaults for all known panes
      const finalWidths: Record<string, string> = {};
      knownPanes.forEach(pane => {
          finalWidths[pane] = loadedWidths[pane] || defaultPaneWidth;
      });
      parsedSidebarPaneWidths.value = finalWidths;
      // Optionally save back if defaults were added (might cause extra write on first load)
      // if (Object.keys(loadedWidths).length !== Object.keys(finalWidths).length) {
      //     await updateSetting('sidebarPaneWidths', JSON.stringify(finalWidths));
      // }

      // Load and parse file manager layout settings
      const defaultFileManagerRowMultiplier = '1.0';
      const defaultFileManagerColWidths = { type: 50, name: 300, size: 100, permissions: 120, modified: 180 };

      // Row Size Multiplier
      console.log(`[SettingsStore] Raw fileManagerRowSizeMultiplier from backend: '${settings.value.fileManagerRowSizeMultiplier}'`);
      if (settings.value.fileManagerRowSizeMultiplier === undefined) {
          settings.value.fileManagerRowSizeMultiplier = defaultFileManagerRowMultiplier; // Assign first
          console.log(`[SettingsStore] fileManagerRowSizeMultiplier not found, set to default: ${settings.value.fileManagerRowSizeMultiplier}`); // Log the assigned value
      }
      // Ensure it's a valid number string before parsing later
      const parsedMultiplier = parseFloat(settings.value.fileManagerRowSizeMultiplier);
      if (isNaN(parsedMultiplier) || parsedMultiplier <= 0) {
          console.warn(`[SettingsStore] Invalid fileManagerRowSizeMultiplier loaded ('${settings.value.fileManagerRowSizeMultiplier}'), resetting to default.`);
          settings.value.fileManagerRowSizeMultiplier = defaultFileManagerRowMultiplier;
      }
      console.log(`[SettingsStore] Final fileManagerRowSizeMultiplier value in store: '${settings.value.fileManagerRowSizeMultiplier}'`);

      // Column Widths
      let loadedFmWidths: Record<string, number> = {};
      console.log(`[SettingsStore] Raw fileManagerColWidths from backend: '${settings.value.fileManagerColWidths}'`);
      try {
          if (settings.value.fileManagerColWidths) {
              loadedFmWidths = JSON.parse(settings.value.fileManagerColWidths);
              console.log(`[SettingsStore] Successfully parsed fileManagerColWidths JSON: ${JSON.stringify(loadedFmWidths)}`);
              if (typeof loadedFmWidths !== 'object' || loadedFmWidths === null) {
                  console.warn('[SettingsStore] Invalid fileManagerColWidths format loaded, resetting.');
                  loadedFmWidths = {};
              }
              // Validate that values are numbers
              for (const key in loadedFmWidths) {
                  if (typeof loadedFmWidths[key] !== 'number') {
                      console.warn(`[SettingsStore] Invalid non-numeric value found in fileManagerColWidths for key '${key}', resetting.`);
                      loadedFmWidths = {};
                      break;
                  }
              }
          }
      } catch (e) {
          console.error('[SettingsStore] Failed to parse fileManagerColWidths, resetting.', e);
          loadedFmWidths = {};
      }
      // Ensure defaults for all known columns, merging with loaded valid ones
      const finalFmWidths: Record<string, number> = { ...defaultFileManagerColWidths };
      console.log(`[SettingsStore] Default FM Col Widths: ${JSON.stringify(defaultFileManagerColWidths)}`);
      Object.keys(defaultFileManagerColWidths).forEach(key => {
          if (loadedFmWidths[key] !== undefined && loadedFmWidths[key] > 0) { // Use loaded if valid
              finalFmWidths[key] = loadedFmWidths[key];
          }
      });
      parsedFileManagerColWidths.value = finalFmWidths;
      console.log(`[SettingsStore] Final parsedFileManagerColWidths value in store: ${JSON.stringify(parsedFileManagerColWidths.value)}`);
      // Save back if defaults were added or structure changed (optional, might cause extra write)
      // const currentSavedFmWidthsString = settings.value.fileManagerColWidths;
      // const finalFmWidthsString = JSON.stringify(finalFmWidths);
      // if (currentSavedFmWidthsString !== finalFmWidthsString) {
      //     await updateSetting('fileManagerColWidths', finalFmWidthsString);
      // }

      // Command Input Sync Target default
      if (settings.value.commandInputSyncTarget === undefined) {
          settings.value.commandInputSyncTarget = 'none'; // 默认不同步
      }
      // Timezone default
      if (settings.value.timezone === undefined) {
          settings.value.timezone = 'UTC'; // 默认 UTC
      }
      // RDP Modal Size defaults
      if (settings.value.rdpModalWidth === undefined) {
          settings.value.rdpModalWidth = '1064'; // 默认宽度 (1024 + 40 padding)
      }
      if (settings.value.rdpModalHeight === undefined) {
          settings.value.rdpModalHeight = '858';
      }
    
      if (settings.value.dashboardSortBy === undefined) {
          settings.value.dashboardSortBy = 'last_connected_at';
      }
      if (settings.value.dashboardSortOrder === undefined) {
          settings.value.dashboardSortOrder = 'desc';
      }

      // Tag visibility defaults
      if (settings.value.showConnectionTags === undefined) {
          settings.value.showConnectionTags = 'true'; // 默认显示
      }
      if (settings.value.showQuickCommandTags === undefined) {
          settings.value.showQuickCommandTags = 'true'; // 默认显示
      } //  Add missing closing brace 
      // Layout locked default - Only set if not provided by backend
      if (settings.value.layoutLocked === undefined) {
          settings.value.layoutLocked = 'false'; // 默认不锁定
          console.log('[SettingsStore] layoutLocked not found in fetched settings, set to default: false');
      } else {
          console.log(`[SettingsStore] layoutLocked found in fetched settings: ${settings.value.layoutLocked}`);
      }
      // Terminal scrollback limit default
      if (settings.value.terminalScrollbackLimit === undefined) {
          settings.value.terminalScrollbackLimit = '5000'; // 默认 5000 行
          console.log(`[SettingsStore] terminalScrollbackLimit not found, set to default: ${settings.value.terminalScrollbackLimit}`);
      }
      // File Manager Delete Confirmation default
      if (settings.value.fileManagerShowDeleteConfirmation === undefined) {
        settings.value.fileManagerShowDeleteConfirmation = 'true'; // 默认显示删除确认
        console.log(`[SettingsStore] fileManagerShowDeleteConfirmation not found, set to default: ${settings.value.fileManagerShowDeleteConfirmation}`);
      }
      // Auto Login setting defaults
      if (settings.value.autoLoginIpWhitelistEnabled === undefined) {
          settings.value.autoLoginIpWhitelistEnabled = 'false'; // 默认禁用
      }
      if (settings.value.autoLoginIpWhitelistAllowedIPs === undefined) {
          settings.value.autoLoginIpWhitelistAllowedIPs = ''; // 默认空
      }
        
      // --- 语言设置 ---
      const langFromSettings = settings.value.language;
      console.log(`[SettingsStore] Language from fetched settings: ${langFromSettings}`); // <-- 添加日志
      // 检查从设置加载的语言 (完整区域代码) 是否在可用语言列表中
      if (langFromSettings && availableLocales.includes(langFromSettings)) {
          determinedLang = langFromSettings;
      } else {
          // 如果设置中的语言无效或缺失，尝试浏览器提供的完整区域代码
          const navigatorLocale = navigator.language;
          if (navigatorLocale && availableLocales.includes(navigatorLocale)) {
              determinedLang = navigatorLocale;
          } else {
              // (可选) 尝试浏览器语言的主语言部分
              const navigatorLangPart = navigatorLocale?.split('-')[0];
              if (navigatorLangPart && availableLocales.includes(navigatorLangPart)) {
                  determinedLang = navigatorLangPart;
              } else {
                  // 最后回退到 i18n 配置的默认语言
                  determinedLang = defaultLng;
              }
          }
          console.warn(`[SettingsStore] Invalid or missing language setting ('${langFromSettings}') received from backend. Falling back to '${determinedLang}'.`);
          // Optionally save the fallback language back
          // await updateSetting('language', determinedLang);
      }

      if (determinedLang) {
        console.log(`[SettingsStore] Determined language: ${determinedLang}. Calling setLocale...`); // <-- 添加日志
        setLocale(determinedLang);
      } else {
        // This case should theoretically not happen with the fallback logic above
        console.error('[SettingsStore] Could not determine a valid language. This should not happen.');
        console.log(`[SettingsStore] Falling back to default: ${defaultLng}. Calling setLocale...`); // <-- 添加日志
        setLocale(defaultLng);
      }

    } catch (err: any) {
      console.error('Error loading general settings:', err); // <-- 修改日志
      error.value = err.response?.data?.message || err.message || 'Failed to load settings';
      // 出错时（例如未登录），根据浏览器语言设置回退语言
      const navigatorLang = navigator.language?.split('-')[0];
      // 错误时也尝试浏览器完整区域代码，然后主语言部分，最后默认
      const navigatorLocale = navigator.language;
      const navigatorLangPart = navigatorLocale?.split('-')[0];
      let fallbackLang = defaultLng; // Start with default
      if (navigatorLocale && availableLocales.includes(navigatorLocale)) {
          fallbackLang = navigatorLocale;
      } else if (navigatorLangPart && availableLocales.includes(navigatorLangPart)) {
          fallbackLang = navigatorLangPart;
      }
      console.log(`[SettingsStore] Error loading settings. Falling back to language: ${fallbackLang}. Calling setLocale...`); // <-- 添加日志
      setLocale(fallbackLang);
    } finally {
      isLoading.value = false;
    }
  }

  // 移除外观相关函数: loadAndApplyThemesFromSettings, applyUiTheme, saveCustomThemes, resetCustomThemes, toggleStyleCustomizer

  /**
   * Updates a single general setting value both locally and on the backend.
   * Uses specific endpoints for boolean settings where available.
   * @param key The setting key to update.
   * @param value The new value for the setting (string for general, boolean for specific).
   */
  async function updateSetting(key: keyof SettingsState, value: string | boolean) {
    // 移除外观相关的键检查
    const allowedKeys: Array<keyof SettingsState> = [
        'language', 'ipWhitelist', 'maxLoginAttempts', 'loginBanDuration',
        'showPopupFileEditor', 'shareFileEditorTabs', 'ipWhitelistEnabled',
        'autoCopyOnSelect', 'dockerStatusIntervalSeconds', 'dockerDefaultExpand',
        'statusMonitorIntervalSeconds', //  添加状态监控间隔键 
        'workspaceSidebarPersistent', //  添加侧边栏固定键 
        'sidebarPaneWidths', //  添加侧边栏宽度对象键 
        'fileManagerRowSizeMultiplier', //  添加文件管理器行大小键 
        'fileManagerColWidths', //  添加文件管理器列宽键 
        'commandInputSyncTarget', //  添加命令输入同步目标键 
        'timezone', // 添加时区键
        'rdpModalWidth', // 添加 RDP 模态框宽度键
        'rdpModalHeight', // 添加 RDP 模态框高度键
        'ipBlacklistEnabled',
        'dashboardSortBy',
        'dashboardSortOrder',
        'showConnectionTags', 
        'showQuickCommandTags', 
        'layoutLocked', 
        'terminalScrollbackLimit', 
        'fileManagerShowDeleteConfirmation', 
        'autoLoginIpWhitelistEnabled',
        'autoLoginIpWhitelistAllowedIPs'
      ];
      if (!allowedKeys.includes(key)) {
          console.error(`[SettingsStore] 尝试更新不允许的设置键: ${key}`);
        throw new Error(`不允许更新设置项 '${key}'`);
    }

    // Use specific endpoints for boolean settings
    const booleanEndpoints: Partial<Record<keyof SettingsState, string>> = {
        showConnectionTags: '/settings/show-connection-tags',
        showQuickCommandTags: '/settings/show-quick-command-tags',
        autoCopyOnSelect: '/settings/auto-copy-on-select',
        // Add other boolean settings with specific endpoints here if needed
    };

    try {
        let apiPromise: Promise<any>;
        const endpoint = booleanEndpoints[key];

        if (endpoint && typeof value === 'boolean') {
            console.log(`[SettingsStore] Attempting to update boolean setting via specific endpoint - Key: ${key}, Value: ${value}, Endpoint: ${endpoint}`);
            apiPromise = apiClient.put(endpoint, { enabled: value });
        } else if (typeof value === 'string') {
            console.log(`[SettingsStore] Attempting to update general setting - Key: ${key}, Value: ${value}`);
            const payload = { [key]: value };
            console.log('[SettingsStore] Sending PUT request to /settings with payload:', payload);
            apiPromise = apiClient.put('/settings', payload);
        } else {
            throw new Error(`Invalid value type for setting '${key}': expected boolean for specific endpoint or string for general.`);
        }

        await apiPromise;
        console.log(`[SettingsStore] Successfully updated setting via API - Key: ${key}`);

        // Update store state *after* successful API call
        settings.value = { ...settings.value, [key]: String(value) }; // Store as string internally

      // If updating language, check if it's valid and update i18n
      if (key === 'language' && typeof value === 'string' && availableLocales.includes(value)) {
        console.log(`[SettingsStore] updateSetting: Language updated to ${value}. Calling setLocale...`);
        setLocale(value);
      } else if (key === 'language') {
        console.warn(`[SettingsStore] updateSetting: Attempted to set invalid language '${value}'. Ignoring i18n update.`);
      }
    } catch (err: any) {
      //  Enhanced error logging 
      console.error(`[SettingsStore] Failed to update setting '${key}' via API. Error:`, err);
      if (err.response) {
        console.error('[SettingsStore] API Error Response Data:', err.response.data);
        console.error('[SettingsStore] API Error Response Status:', err.response.status);
        console.error('[SettingsStore] API Error Response Headers:', err.response.headers);
      } else if (err.request) {
        console.error('[SettingsStore] API Error Request:', err.request);
      } else {
        console.error('[SettingsStore] API Error Message:', err.message);
      }
      // Rethrow the error but maybe provide a more specific message if possible
      throw new Error(err.response?.data?.message || `更新设置项 '${key}' 失败: ${err.message}`);
    }
  }

    /**
   * Updates multiple general settings values both locally and on the backend.
   * @param updates An object containing key-value pairs of settings to update.
   */
  async function updateMultipleSettings(updates: Partial<SettingsState>) {
     // 移除外观相关的键检查
    const allowedKeys: Array<keyof SettingsState> = [
        'language', 'ipWhitelist', 'maxLoginAttempts', 'loginBanDuration',
        'showPopupFileEditor', 'shareFileEditorTabs', 'ipWhitelistEnabled',
        'autoCopyOnSelect', 'dockerStatusIntervalSeconds', 'dockerDefaultExpand',
        'statusMonitorIntervalSeconds', //  添加状态监控间隔键 
        'workspaceSidebarPersistent', //  添加侧边栏固定键 
        'sidebarPaneWidths', //  添加侧边栏宽度对象键 
        'fileManagerRowSizeMultiplier', //  添加文件管理器行大小键 
        'fileManagerColWidths', //  添加文件管理器列宽键 
        'commandInputSyncTarget', //  添加命令输入同步目标键 
        'timezone', // 添加时区键
        'rdpModalWidth', // 添加 RDP 模态框宽度键
        'rdpModalHeight', // 添加 RDP 模态框高度键
        'ipBlacklistEnabled',
        'dashboardSortBy',
        'dashboardSortOrder',
        'showConnectionTags', 
        'showQuickCommandTags', 
        'layoutLocked', 
        'terminalScrollbackLimit', 
        'fileManagerShowDeleteConfirmation', 
        'autoLoginIpWhitelistEnabled',
        'autoLoginIpWhitelistAllowedIPs'
      ];
      const filteredUpdates: Partial<SettingsState> = {};
      let languageUpdate: string | undefined = undefined;

    for (const key in updates) {
        if (allowedKeys.includes(key as keyof SettingsState)) {
            filteredUpdates[key as keyof SettingsState] = updates[key];
            if (key === 'language') {
                // Check if the language update is valid before storing it for setLocale
                const langValue = updates[key];
                if (langValue && availableLocales.includes(langValue)) {
                    languageUpdate = langValue; // Store the valid language code
                } else {
                    console.warn(`[SettingsStore] updateMultipleSettings: Received invalid language update '${langValue}'. Ignoring.`);
                }
            }
        } else {
             console.warn(`[SettingsStore] 尝试批量更新不允许的设置键: ${key}`);
        }
      }

    if (Object.keys(filteredUpdates).length === 0) {
        console.log('[SettingsStore] 没有有效的通用设置需要更新。');
        return; // 没有有效设置需要更新
    }

    try {
      // 注意：后端 controller 现在会过滤，但前端也做一层检查更好
      await apiClient.put('/settings', filteredUpdates); // 使用 apiClient
      // Update store state *after* successful API call
      settings.value = { ...settings.value, ...filteredUpdates };

      // If language is updated, apply it
      if (languageUpdate) {
        console.log(`[SettingsStore] updateMultipleSettings: Language updated to ${languageUpdate}. Calling setLocale...`); // <-- 添加日志
        setLocale(languageUpdate);
      }
    } catch (err: any) {
      console.error('批量更新设置失败:', err);
      throw new Error(err.response?.data?.message || err.message || '批量更新设置失败');
    }
  }

  /**
   * Updates the width for a specific sidebar pane.
   * @param paneName The name of the pane (component).
   * @param width The new width string (e.g., '400px').
   */
  async function updateSidebarPaneWidth(paneName: PaneName, width: string) {
    if (!paneName) return;
    const newWidths = { ...parsedSidebarPaneWidths.value, [paneName]: width };
    parsedSidebarPaneWidths.value = newWidths; // Update local reactive state first
    try {
      // Use updateMultipleSettings for consistency, even for one setting
      await updateMultipleSettings({ sidebarPaneWidths: JSON.stringify(newWidths) });
    } catch (error) {
      console.error(`[SettingsStore] Failed to save sidebarPaneWidths after updating ${paneName}:`, error);
      // Optionally revert local state or show error to user
    }
  }

  /**
   * Updates the File Manager layout settings (row size multiplier and column widths).
   * @param multiplier The new row size multiplier (number).
   * @param widths The new column widths object (Record<string, number>).
   */
  async function updateFileManagerLayoutSettings(multiplier: number, widths: Record<string, number>) {
    const multiplierString = multiplier.toFixed(2); // Store with 2 decimal places
    const widthsString = JSON.stringify(widths);

    // Update local parsed state immediately for responsiveness
    parsedFileManagerColWidths.value = widths;
    // The multiplier is handled directly by the component, but update the setting value
    settings.value.fileManagerRowSizeMultiplier = multiplierString;
    settings.value.fileManagerColWidths = widthsString;

    try {
      console.log(`[SettingsStore] Saving FM layout: multiplier=${multiplierString}, widths=${widthsString}`);
      await updateMultipleSettings({
        fileManagerRowSizeMultiplier: multiplierString,
        fileManagerColWidths: widthsString,
      });
    } catch (error) {
      console.error('[SettingsStore] Failed to save file manager layout settings:', error);
      // Optionally revert local state or show error to user
    }
  }

  // --- CAPTCHA Settings Actions ---

  /**
   * Fetches CAPTCHA settings from the backend.
   * Should be called when the settings component mounts.
   */
  async function loadCaptchaSettings() {
    // Avoid reloading if already loaded, unless forced
    // if (captchaSettings.value !== null && !force) return;

    isLoading.value = true;
    error.value = null;
    try {
      console.log('[SettingsStore] 加载 CAPTCHA 设置...');
      // Use the correct endpoint defined in the backend routes
      const response = await apiClient.get<CaptchaSettings>('/settings/captcha');
      captchaSettings.value = response.data;
      console.log('[SettingsStore] CAPTCHA 设置加载完成:', { ...response.data, hcaptchaSecretKey: '***', recaptchaSecretKey: '***' }); // Mask secrets
    } catch (err: any) {
      console.error('加载 CAPTCHA 设置失败:', err);
      error.value = err.response?.data?.message || err.message || '加载 CAPTCHA 设置失败';
      captchaSettings.value = null; // Reset on error
    } finally {
      isLoading.value = false;
    }
  }

  /**
   * Updates CAPTCHA settings on the backend.
   * @param updates - An object containing the CAPTCHA settings fields to update.
   */
  async function updateCaptchaSettings(updates: UpdateCaptchaSettingsDto) {
    isLoading.value = true;
    error.value = null;
    try {
      console.log('[SettingsStore] 更新 CAPTCHA 设置:', { ...updates, hcaptchaSecretKey: '***', recaptchaSecretKey: '***' }); // Mask secrets
      // Use the correct endpoint defined in the backend routes
      await apiClient.put('/settings/captcha', updates);

      // Update local state after successful API call
      // Merge updates into the existing state or reload
      if (captchaSettings.value) {
        captchaSettings.value = { ...captchaSettings.value, ...updates };
      } else {
        // If settings were null, reload them after update
        await loadCaptchaSettings();
      }
      console.log('[SettingsStore] CAPTCHA 设置更新成功。');

      // --- 新增：强制 authStore 重新获取配置 ---
      console.log('[SettingsStore] Triggering authStore to refetch CAPTCHA config...');
      authStore.publicCaptchaConfig = null; // 重置 authStore 的状态以允许重新获取
      await authStore.fetchCaptchaConfig(); // 让 authStore 立即获取最新的配置
      // -----------------------------------------

    } catch (err: any) {
      console.error('更新 CAPTCHA 设置失败:', err);
      error.value = err.response?.data?.message || err.message || '更新 CAPTCHA 设置失败';
      throw error; // Re-throw to allow component to handle UI feedback
    } finally {
      isLoading.value = false;
    }
  }
  
  async function saveDashboardSortPreference(sortBy: SortField, sortOrder: SortOrder) {
      try {
          await updateMultipleSettings({
              dashboardSortBy: sortBy,
              dashboardSortOrder: sortOrder,
          });
      } catch (error) {
          console.error('[SettingsStore] Failed to save dashboard sort preference:', error);
          // Optionally show error to user
      }
  }


  // 移除外观相关 actions: saveCustomThemes, resetCustomThemes, toggleStyleCustomizer

  // --- Getters ---
  // Use defaultLng (which is now 'en-US' or the first available) from i18n.ts as the final fallback
  const language = computed(() => settings.value.language || defaultLng);

  // Getter for the popup editor setting, returning boolean
  const showPopupFileEditorBoolean = computed(() => {
      return settings.value.showPopupFileEditor !== 'false';
  });

  // Getter for sharing setting, returning boolean
  const shareFileEditorTabsBoolean = computed(() => {
      return settings.value.shareFileEditorTabs !== 'false';
  });

  // Getter for IP Whitelist enabled status
  const ipWhitelistEnabled = computed(() => settings.value.ipWhitelistEnabled === 'true');

  // <-- NEW: Getter for IP Blacklist enabled status -->
  const ipBlacklistEnabledBoolean = computed(() => {
      // Default to true if the setting is missing or not 'false'
      return settings.value.ipBlacklistEnabled !== 'false';
  });

  // Getter for auto copy on select setting, returning boolean
  const autoCopyOnSelectBoolean = computed(() => {
      return settings.value.autoCopyOnSelect === 'true';
  });

  // Getter for workspace sidebar persistent setting, returning boolean
  const workspaceSidebarPersistentBoolean = computed(() => {
      return settings.value.workspaceSidebarPersistent === 'true';
  });

  // Getter to get width for a specific sidebar pane
  const getSidebarPaneWidth = computed(() => (paneName: PaneName | null): string => {
    const defaultWidth = '350px';
    if (!paneName) return defaultWidth;
    // Ensure parsedSidebarPaneWidths.value is accessed correctly
    const widths = parsedSidebarPaneWidths.value || {};
    return widths[paneName] || defaultWidth;
  });

  // Getter for Docker default expand setting, returning boolean
  const dockerDefaultExpandBoolean = computed(() => {
      return settings.value.dockerDefaultExpand === 'true';
  });

  // Getter for Status Monitor interval, returning number
  const statusMonitorIntervalSecondsNumber = computed(() => {
      const val = parseInt(settings.value.statusMonitorIntervalSeconds || '3', 10);
      return isNaN(val) || val <= 0 ? 3 : val; // Fallback to 3 if invalid
  });

  // Getter for File Manager row size multiplier, returning number
  const fileManagerRowSizeMultiplierNumber = computed(() => {
      const val = parseFloat(settings.value.fileManagerRowSizeMultiplier || '1.0');
      return isNaN(val) || val <= 0 ? 1.0 : val; // Fallback to 1.0 if invalid
  });

  // Getter for File Manager column widths, returning object
  const fileManagerColWidthsObject = computed(() => {
      // Return the reactive ref directly, which is updated during load and save
      return parsedFileManagerColWidths.value;
  });

  // Getter for command input sync target
  const commandInputSyncTarget = computed(() => {
      const target = settings.value.commandInputSyncTarget;
      if (target === 'quickCommands' || target === 'commandHistory') {
          return target;
      }
      return 'none'; // Default to 'none' if invalid or not set
  });

  // Getter for timezone setting
  const timezone = computed(() => settings.value.timezone || 'UTC');
  
  const dashboardSortBy = computed((): SortField => {
      const savedSortBy = settings.value.dashboardSortBy;
      const validFields: SortField[] = ['created_at', 'last_connected_at', 'updated_at', 'name', 'type'];
      return savedSortBy && validFields.includes(savedSortBy) ? savedSortBy : 'last_connected_at';
  });
  
  const dashboardSortOrder = computed((): SortOrder => {
      const savedSortOrder = settings.value.dashboardSortOrder;
      return savedSortOrder === 'asc' || savedSortOrder === 'desc' ? savedSortOrder : 'desc';
  });
  
  const isCaptchaEnabled = computed(() => captchaSettings.value?.enabled ?? false);
  const captchaProvider = computed(() => captchaSettings.value?.provider ?? 'none');
  const hcaptchaSiteKey = computed(() => captchaSettings.value?.hcaptchaSiteKey ?? '');
  const recaptchaSiteKey = computed(() => captchaSettings.value?.recaptchaSiteKey ?? '');
  // DO NOT expose secret keys via getters

  // Getters for tag visibility
  const showConnectionTagsBoolean = computed(() => {
      return settings.value.showConnectionTags !== 'false'; // Default to true
  });
  const showQuickCommandTagsBoolean = computed(() => {
      return settings.value.showQuickCommandTags !== 'false'; // Default to true
  });

  // Getter for layout locked status
  const layoutLockedBoolean = computed(() => {
      return settings.value.layoutLocked === 'true';
  });

  // Getter for terminal scrollback limit, returning number (0 means Infinity for xterm)
  const terminalScrollbackLimitNumber = computed(() => {
      const valStr = settings.value.terminalScrollbackLimit;
      if (valStr === null || valStr === undefined || valStr.trim() === '') {
          return 5000; // Default value if not set or empty
      }
      const val = parseInt(valStr, 10);
      if (isNaN(val) || val < 0) {
          return 5000; // Default value if invalid number or negative
      }
      return val; // Return 0 if it's 0, or the positive number
  });

  // Getter for File Manager delete confirmation, returning boolean
  const fileManagerShowDeleteConfirmationBoolean = computed(() => {
      return settings.value.fileManagerShowDeleteConfirmation !== 'false'; // Default to true
  });
  
  // --- Auto Login Getters ---
  const autoLoginIpWhitelistEnabledBoolean = computed(() => {
      return settings.value.autoLoginIpWhitelistEnabled === 'true';
  });
  const autoLoginIpWhitelistAllowedIPsString = computed(() => {
      return settings.value.autoLoginIpWhitelistAllowedIPs || '';
  });
  // --- End Auto Login Getters ---

 return {
   settings, // 只包含通用设置 (包括 autoLogin 字段)
    isLoading,
    error,
    language,
    showPopupFileEditorBoolean,
    shareFileEditorTabsBoolean,
    ipWhitelistEnabled, // 暴露 IP 白名单启用状态
    ipBlacklistEnabledBoolean, // <-- NEW: 暴露 IP 黑名单启用状态 getter
    autoCopyOnSelectBoolean,
    dockerDefaultExpandBoolean, //  暴露 Docker 默认展开 getter 
    statusMonitorIntervalSecondsNumber, //  暴露状态监控间隔 getter 
    workspaceSidebarPersistentBoolean, //  暴露侧边栏固定 getter 
    getSidebarPaneWidth, //  暴露获取特定面板宽度的 getter 
    fileManagerRowSizeMultiplierNumber, //  暴露文件管理器行大小 getter 
    fileManagerColWidthsObject, //  暴露文件管理器列宽 getter 
    // CAPTCHA related exports
    captchaSettings, // Expose the full (but reactive) object for the settings page v-model
    isCaptchaEnabled,
    captchaProvider,
    hcaptchaSiteKey,
    recaptchaSiteKey,
    loadCaptchaSettings,
    updateCaptchaSettings,
    // 移除外观相关的 getters 和 actions
    loadInitialSettings,
    updateSetting,
    updateMultipleSettings,
    updateSidebarPaneWidth, //  暴露更新特定面板宽度的 action 
    updateFileManagerLayoutSettings, //  暴露更新文件管理器布局的 action 
    commandInputSyncTarget, //  暴露命令输入同步目标 getter 
    timezone,
    dashboardSortBy,
    dashboardSortOrder,
    saveDashboardSortPreference,
    // Expose tag visibility getters
    showConnectionTagsBoolean,
    showQuickCommandTagsBoolean,
    // Expose layout locked getter
    layoutLockedBoolean,
    terminalScrollbackLimitNumber, // Expose terminal scrollback limit getter
    fileManagerShowDeleteConfirmationBoolean, // Expose file manager delete confirmation getter
    // --- Auto Login Exports ---
    autoLoginIpWhitelistEnabledBoolean,
    autoLoginIpWhitelistAllowedIPsString,
    // --- End Auto Login Exports ---
  };
  });
