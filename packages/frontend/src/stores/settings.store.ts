import { defineStore } from 'pinia';
import apiClient from '../utils/apiClient'; 
import { ref, computed } from 'vue'; 
import i18n, { setLocale, defaultLng, availableLocales } from '../i18n'; 
import type { PaneName } from './layout.store';
import { useAuthStore } from './auth.store';
import { isDesktopApp } from '../utils/platform';
import type { ConnectionInfo } from './connections.store';
import { SETTING_DEFAULTS, isWritableSettingKey } from './settings.schema.generated';

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
  showPopupFileManager?: string; // 'true' or 'false' - NEW: 弹窗文件管理器
  shareFileEditorTabs?: string; // 'true' or 'false'
  fileEditorLargeFileConfirm?: string; // 'true' or 'false' - 打开大文件前是否二次确认（记住后置 false）
  ipWhitelistEnabled?: string; // 添加 IP 白名单启用状态 'true' or 'false'
  autoCopyOnSelect?: string; // 'true' or 'false' - 终端选中自动复制
  dockerStatusIntervalSeconds?: string; //  Docker 状态刷新间隔 (秒)
  dockerDefaultExpand?: string; //  Docker 默认展开详情 'true' or 'false'
  statusMonitorIntervalSeconds?: string; //  状态监控轮询间隔 (秒)
  workspaceSidebarPersistent?: string; //  工作区侧边栏是否固定 'true' or 'false'
  sidebarPaneWidths?: string; //  存储各侧边栏组件宽度的 JSON 字符串
  fileManagerRowSizeMultiplier?: string; //  文件管理器行大小乘数 (e.g., '1.0')
  fileManagerColWidths?: string; //  文件管理器列宽 JSON 字符串 (e.g., '{"name": 300, "size": 100}')
  commandInputSyncTarget?: 'quickCommands' | 'commandHistory' | 'none'; //  命令输入同步目标
  timezone?: string; //  时区设置 (e.g., 'Asia/Shanghai', 'UTC')
  rdpModalWidth?: string; //  RDP 模态框宽度
  rdpModalHeight?: string; //  RDP 模态框高度
  vncModalWidth?: string; //  VNC 模态框宽度
  vncModalHeight?: string; //  VNC 模态框高度
  ipBlacklistEnabled?: string;
  dashboardSortBy?: SortField;
  dashboardSortOrder?: SortOrder;
  showConnectionFolders?: string; // 'true' or 'false'
  showQuickCommandFolders?: string; // 'true' or 'false'
  layoutLocked?: string; // 'true' or 'false' - NEW: 布局锁定状态
  terminalScrollbackLimit?: string; //  终端回滚行数上限 (e.g., '5000', '0' for unlimited)
  fileManagerShowDeleteConfirmation?: string;
  fileManagerDoubleClickToOpen?: string; // 'true' or 'false' - 双击打开文件/文件夹 (默认 false) //  'true' or 'false' - 文件管理器删除确认提示
  fileManagerHighlightChanges?: string; // 'true' or 'false' - 文件列表增量变动(新增/修改)时高亮闪烁 (默认 true)
  fileManagerSearchFixed?: string; // 'true' or 'false' - 文件管理器搜索栏固定（跨端同步，默认 false）
  fileManagerShowHidden?: string; // 'true' or 'false' - 文件管理器显示以 . 开头的隐藏文件 (默认 false)
  terminalEnableRightClickPaste?: string; //  'true' or 'false' - 终端右键粘贴
  terminalRightClickBehavior?: string; // 'contextMenu' | 'paste' | 'copy' | 'openPath' | 'openFile' | 'saveQuickCommand' | 'none'
  terminalContextMenuItems?: string; // JSON string of TerminalContextMenuSettings
  terminalNoWrap?: string; // 'true' or 'false' - 终端不换行 (默认 false)
  showStatusMonitorIpAddress?: string; // 'true' or 'false' - 状态监视器显示IP地址
  quickCommandRowSizeMultiplier?: string; // +++ 快捷命令列表行大小乘数 (e.g., '1.0') +++
  quickCommandsCompactMode?: string; // +++ 快捷指令视图紧凑模式 (e.g., 'false') +++
  fileEditorModalWidth?: string; // 文本编辑器弹窗宽度 (px)
  fileEditorModalHeight?: string; // 文本编辑器弹窗高度 (px)
  desktopFileOpenMode?: string; // 'builtin' | 'external' - 桌面客户端打开文件的方式
  markdownDefaultViewMode?: string; // 'preview' | 'split' | 'edit'
  markdownDefaultViewModeMobile?: string; // 'preview' | 'split' | 'edit'
  rememberLastRoute?: string; // 'true' or 'false' - 记住上次停留页面
  terminalSwitchPaneShortcut?: string; // 终端多窗格焦点切换快捷键 (默认 'Alt+`')
  remoteSessionHostingEnabled?: string; // 'true' or 'false' - 启用目标机自托管 SSH 会话
  remoteSessionAutoDeploy?: string; // 'true' or 'false' - 自动向目标机静默部署 nexus-mux
  remoteSessionDetachedIdleHours?: string; // 活跃脱离托管会话空闲回收小时数（'0' 表示永不自动强杀）
  desktopWorkspaceSyncEnabled?: string; // 'true' or 'false' - 桌面端是否接入云端工作区实时同步
  [key: string]: string | undefined;
}


export type TerminalRightClickBehavior = 'contextMenu' | 'paste' | 'copy' | 'openPath' | 'openFile' | 'saveQuickCommand' | 'none';

/**
 * 桌面客户端打开文件的方式：
 *   builtin  —— 走内置编辑器（弹窗 / 共享标签页 / 会话内标签页，原有的三分支逻辑）
 *   external —— 下载成本地临时副本后交给系统默认程序（Tauri 侧用默认程序打开）
 * Web / 移动端不受此设置影响，永远走内置编辑器。
 */
export type DesktopFileOpenMode = 'builtin' | 'external';

export interface TerminalContextMenuSettings {
  copy: boolean;
  paste: boolean;
  openPath: boolean;
  openFile: boolean;
  saveQuickCommand: boolean;
}

export const DEFAULT_TERMINAL_CONTEXT_MENU_ITEMS: TerminalContextMenuSettings = {
  copy: true,
  paste: true,
  openPath: true,
  openFile: true,
  saveQuickCommand: true,
};

export const useSettingsStore = defineStore('settings', () => {
  const authStore = useAuthStore(); // <--- 实例化 authStore

  // --- State ---
  const settings = ref<Partial<SettingsState>>({}); // 通用设置状态
  const parsedSidebarPaneWidths = ref<Record<string, string>>({}); //  解析后的侧边栏宽度对象
  const parsedFileManagerColWidths = ref<Record<string, number>>({}); //  解析后的文件管理器列宽对象
  const captchaSettings = ref<CaptchaSettings | null>(null); //  CAPTCHA 设置状态
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

    // 先用 schema 默认值铺底：即使下面的请求失败，界面也不会因为读到 undefined 而退化。
    // 默认值只在 settings.schema.json 维护一份（由 tools/gen-settings-schema.mjs 生成副本）。
    //
    // ⚠️ 只在**第一次加载**时铺底。切屏回来 / 云端同步完成都会再调一次这个函数
    // （refreshAllStores → loadInitialSettings），如果每次都铺一遍默认值，
    // 用户已配置的开关会瞬间被打回默认（这些键默认都是 'false'），
    // 表现为：状态监视器的 IP 胶囊、命令输入栏的文件夹图标、文件管理器的固定搜索栏
    // 跟着 v-if 卸载再挂回 —— 也就是「切屏回来闪一下」。
    // 用「settings 里有没有键」来判断，登出清空后会自然回到首次加载的语义。
    if (Object.keys(settings.value).length === 0) {
      settings.value = { ...SETTING_DEFAULTS };
    }

    try {
      console.log('[SettingsStore] 加载通用设置...');
      // Fetch all settings, including the new ones
      const [
        generalSettingsResponse,
        showConnectionFoldersResponse,
        showQuickCommandFoldersResponse
      ] = await Promise.all([
        apiClient.get<Record<string, string>>('/settings'),
        apiClient.get<{ enabled: boolean }>('/settings/show-connection-folders'),
        apiClient.get<{ enabled: boolean }>('/settings/show-quick-command-folders')
      ]);

      settings.value = { ...settings.value, ...generalSettingsResponse.data };

      // 这两个开关有独立接口，以独立接口的返回为准
      settings.value.showConnectionFolders = String(showConnectionFoldersResponse.data.enabled);
      settings.value.showQuickCommandFolders = String(showQuickCommandFoldersResponse.data.enabled);

      console.log('[SettingsStore] Fetched settings from backend:', JSON.stringify(settings.value));

      // --- 侧边栏宽度：JSON 解析 + 已知面板缺省补齐 ---
      const defaultPaneWidth = '350px';
      const knownPanes: PaneName[] = ['connections', 'fileManager', 'editor', 'statusMonitor', 'commandHistory', 'quickCommands', 'dockerManager'];
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
      const finalWidths: Record<string, string> = {};
      knownPanes.forEach(pane => {
          finalWidths[pane] = loadedWidths[pane] || defaultPaneWidth;
      });
      parsedSidebarPaneWidths.value = finalWidths;

      // --- 文件管理器行高倍率：非法值回落默认 ---
      const parsedMultiplier = parseFloat(settings.value.fileManagerRowSizeMultiplier || '1.0');
      if (isNaN(parsedMultiplier) || parsedMultiplier <= 0) {
          console.warn(`[SettingsStore] Invalid fileManagerRowSizeMultiplier loaded ('${settings.value.fileManagerRowSizeMultiplier}'), resetting to default.`);
          settings.value.fileManagerRowSizeMultiplier = '1.0';
      }

      // --- 文件管理器列宽：JSON 解析 + 数值校验 + 缺省补齐 ---
      const defaultFileManagerColWidths = { type: 50, name: 300, size: 100, permissions: 120, modified: 180 };
      let loadedFmWidths: Record<string, number> = {};
      try {
          if (settings.value.fileManagerColWidths) {
              loadedFmWidths = JSON.parse(settings.value.fileManagerColWidths);
              if (typeof loadedFmWidths !== 'object' || loadedFmWidths === null) {
                  console.warn('[SettingsStore] Invalid fileManagerColWidths format loaded, resetting.');
                  loadedFmWidths = {};
              }
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
      const finalFmWidths: Record<string, number> = { ...defaultFileManagerColWidths };
      Object.keys(defaultFileManagerColWidths).forEach(key => {
          if (loadedFmWidths[key] !== undefined && loadedFmWidths[key] > 0) { // Use loaded if valid
              finalFmWidths[key] = loadedFmWidths[key];
          }
      });
      parsedFileManagerColWidths.value = finalFmWidths;

      // --- 快捷指令的两个偏好：localStorage 优先（历史行为，跨设备不共享）---
      const localQcRowSizeMultiplier = localStorage.getItem('nexus_quickCommandRowSizeMultiplier');
      if (localQcRowSizeMultiplier) {
        const parsedLocalMultiplier = parseFloat(localQcRowSizeMultiplier);
        if (!isNaN(parsedLocalMultiplier) && parsedLocalMultiplier > 0) {
          settings.value.quickCommandRowSizeMultiplier = localQcRowSizeMultiplier;
        } else {
          console.warn(`[SettingsStore] Invalid quickCommandRowSizeMultiplier in localStorage: ${localQcRowSizeMultiplier}. Using server/default.`);
        }
      }

      const localQcCompactMode = localStorage.getItem('nexus_quickCommandsCompactMode');
      if (localQcCompactMode === 'true' || localQcCompactMode === 'false') {
        settings.value.quickCommandsCompactMode = localQcCompactMode;
      } else if (localQcCompactMode !== null) {
        console.warn(`[SettingsStore] Invalid quickCommandsCompactMode in localStorage: ${localQcCompactMode}. Using server/default.`);
      }

      // --- rememberLastRoute：schema 故意不给默认值，首次以 localStorage 为准 ---
      if (settings.value.rememberLastRoute === undefined) {
        const localRemember = localStorage.getItem('nexus_remember_last_route');
        settings.value.rememberLastRoute = localRemember !== null ? localRemember : 'true';
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
    // 白名单来自 settings.schema.json（前端副本由 tools/gen-settings-schema.mjs 生成）：
    // 不在 schema 里声明的键一律拒绝，避免和后端"静默过滤"叠加成静默失败。
    if (!isWritableSettingKey(String(key))) {
      console.error(`[SettingsStore] 尝试更新未在 schema 中声明的设置键: ${key}`);
      throw new Error(`不允许更新设置项 '${key}'`);
    }

    // Use specific endpoints for boolean settings
    const booleanEndpoints: Partial<Record<keyof SettingsState, string>> = {
        showConnectionFolders: '/settings/show-connection-folders',
        showQuickCommandFolders: '/settings/show-quick-command-folders',
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
            // --- 添加针对 terminalEnableRightClickPaste 的特定日志 ---
            if (key === 'terminalEnableRightClickPaste') {
                console.log(`[SettingsStore DEBUG] Updating terminalEnableRightClickPaste. Value type: ${typeof value}, Value: '${value}'`);
            }
            // --- 日志结束 ---
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

        // --- 保存到 localStorage  ---
        if (key === 'quickCommandsCompactMode' && (String(value) === 'true' || String(value) === 'false')) {
          try {
            localStorage.setItem('nexus_quickCommandsCompactMode', String(value));
            console.log(`[SettingsStore] Saved quickCommandsCompactMode to localStorage: ${String(value)}`);
          } catch (e) {
            console.error('[SettingsStore] Failed to save quickCommandsCompactMode to localStorage:', e);
          }
        }
        // quickCommandRowSizeMultiplier 由其专用 action 处理 localStorage 保存

      // If updating language, check if it's valid and update i18n
      if (key === 'language' && typeof value === 'string' && availableLocales.includes(value)) {
        console.log(`[SettingsStore] updateSetting: Language updated to ${value}. Calling setLocale...`);
        setLocale(value);
      } else if (key === 'language') {
        console.warn(`[SettingsStore] updateSetting: Attempted to set invalid language '${value}'. Ignoring i18n update.`);
      }
    } catch (err: any) {
      // +++ Enhanced error logging +++
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
    // 白名单同上（schema 唯一来源），被拒的键会打日志而不是静默丢弃
      const filteredUpdates: Partial<SettingsState> = {};
      let languageUpdate: string | undefined = undefined;

    for (const key in updates) {
        if (isWritableSettingKey(key)) {
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
             console.warn(`[SettingsStore] 跳过未在 schema 中声明的设置键: ${key}`);
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

  /**
   * Updates the Quick Command row size multiplier.
   * @param multiplier The new row size multiplier (number).
   */
  async function updateQuickCommandRowSizeMultiplier(multiplier: number) {
    const multiplierString = multiplier.toFixed(2);
    try {
      await updateSetting('quickCommandRowSizeMultiplier', multiplierString);
      // 本地状态 settings.value 会在 updateSetting 成功后更新
      // --- 保存到 localStorage ---
      try {
        localStorage.setItem('nexus_quickCommandRowSizeMultiplier', multiplierString);
        console.log(`[SettingsStore] Saved quickCommandRowSizeMultiplier to localStorage: ${multiplierString}`);
      } catch (e) {
        console.error('[SettingsStore] Failed to save quickCommandRowSizeMultiplier to localStorage:', e);
      }
      console.log(`[SettingsStore] Quick Command row size multiplier updated to: ${multiplierString}`);
    } catch (error) {
      console.error('[SettingsStore] Failed to save Quick Command row size multiplier:', error);
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

      // --- 强制 authStore 重新获取配置 ---
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
 
  // +++ Getter for popup file manager setting, returning boolean +++
  const showPopupFileManagerBoolean = computed(() => {
      return settings.value.showPopupFileManager !== 'false'; // Default to true
  });
 
  // Getter for sharing setting, returning boolean
  const shareFileEditorTabsBoolean = computed(() => {
      return settings.value.shareFileEditorTabs !== 'false';
  });

  // 打开大文件前是否二次确认（默认 true；用户在弹窗里勾"记住"后写成 false）
  const fileEditorLargeFileConfirmBoolean = computed(() => {
      return settings.value.fileEditorLargeFileConfirm !== 'false';
  });

  // 桌面客户端打开文件的方式（默认内置编辑器；external 只在桌面端生效）
  const desktopFileOpenModeString = computed<DesktopFileOpenMode>(() => {
      return settings.value.desktopFileOpenMode === 'external' ? 'external' : 'builtin';
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

  //  Getter for workspace sidebar persistent setting, returning boolean
  const workspaceSidebarPersistentBoolean = computed(() => {
      return settings.value.workspaceSidebarPersistent === 'true';
  });

  //  Getter to get width for a specific sidebar pane
  const getSidebarPaneWidth = computed(() => (paneName: PaneName | null): string => {
    const defaultWidth = '350px';
    if (!paneName) return defaultWidth;
    // Ensure parsedSidebarPaneWidths.value is accessed correctly
    const widths = parsedSidebarPaneWidths.value || {};
    return widths[paneName] || defaultWidth;
  });

  //  Getter for Docker default expand setting, returning boolean
  const dockerDefaultExpandBoolean = computed(() => {
      return settings.value.dockerDefaultExpand === 'true';
  });

  //  Getter for Status Monitor interval, returning number
  const statusMonitorIntervalSecondsNumber = computed(() => {
      const val = parseInt(settings.value.statusMonitorIntervalSeconds || '3', 10);
      return isNaN(val) || val <= 0 ? 3 : val; // Fallback to 3 if invalid
  });

  //  Getter for File Manager row size multiplier, returning number
  const fileManagerRowSizeMultiplierNumber = computed(() => {
      const val = parseFloat(settings.value.fileManagerRowSizeMultiplier || '1.0');
      return isNaN(val) || val <= 0 ? 1.0 : val; // Fallback to 1.0 if invalid
  });

  //  Getter for File Manager column widths, returning object
  const fileManagerColWidthsObject = computed(() => {
      // Return the reactive ref directly, which is updated during load and save
      return parsedFileManagerColWidths.value;
  });

  //  Getter for command input sync target
  const commandInputSyncTarget = computed(() => {
      const target = settings.value.commandInputSyncTarget;
      if (target === 'quickCommands' || target === 'commandHistory') {
          return target;
      }
      return 'none'; // Default to 'none' if invalid or not set
  });

  //  Getter for timezone setting
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

  //  Getters for folder visibility
  const showConnectionFoldersBoolean = computed(() => {
      return settings.value.showConnectionFolders !== 'false'; // Default to true
  });
  const showQuickCommandFoldersBoolean = computed(() => {
      return settings.value.showQuickCommandFolders !== 'false'; // Default to true
  });

  //  Getter for layout locked status
  const layoutLockedBoolean = computed(() => {
      return settings.value.layoutLocked === 'true';
  });

  //  Getter for terminal scrollback limit, returning number (0 means Infinity for xterm)
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

  //  Getter for File Manager delete confirmation, returning boolean
  const fileManagerDoubleClickToOpenBoolean = computed(() => {
      return settings.value.fileManagerDoubleClickToOpen === 'true'; // Default to false
  });

  const fileManagerShowDeleteConfirmationBoolean = computed(() => {
      return settings.value.fileManagerShowDeleteConfirmation !== 'false'; // Default to true
  });

  // 文件列表增量变动（新增/修改）高亮闪烁，默认开启
  const fileManagerHighlightChangesBoolean = computed(() => {
      return settings.value.fileManagerHighlightChanges !== 'false';
  });

  // 文件管理器是否显示隐藏文件（以 . 开头），默认关闭
  const fileManagerShowHiddenBoolean = computed(() => {
      return settings.value.fileManagerShowHidden === 'true';
  });

  //  Getter for Terminal Right Click Paste, returning boolean
  const terminalNoWrapBoolean = computed(() => {
      return settings.value.terminalNoWrap === 'true'; // Default to false
  });

  const terminalRightClickBehaviorString = computed<TerminalRightClickBehavior>(() => {
    const val = settings.value.terminalRightClickBehavior;
    const validValues: TerminalRightClickBehavior[] = ['contextMenu', 'paste', 'copy', 'openPath', 'openFile', 'saveQuickCommand', 'none'];
    if (val && validValues.includes(val as TerminalRightClickBehavior)) {
      return val as TerminalRightClickBehavior;
    }
    if (settings.value.terminalEnableRightClickPaste === 'false') {
      return 'none';
    }
    return 'contextMenu';
  });

  const terminalContextMenuItemsObject = computed<TerminalContextMenuSettings>(() => {
    const valStr = settings.value.terminalContextMenuItems;
    if (!valStr) {
      return { ...DEFAULT_TERMINAL_CONTEXT_MENU_ITEMS };
    }
    try {
      const parsed = JSON.parse(valStr);
      return {
        copy: parsed.copy !== false,
        paste: parsed.paste !== false,
        openPath: parsed.openPath !== false,
        openFile: parsed.openFile !== false,
        saveQuickCommand: parsed.saveQuickCommand !== false,
      };
    } catch {
      return { ...DEFAULT_TERMINAL_CONTEXT_MENU_ITEMS };
    }
  });

  const updateTerminalRightClickBehavior = async (behavior: TerminalRightClickBehavior) => {
    await updateSetting('terminalRightClickBehavior', behavior);
  };

  const updateTerminalContextMenuItems = async (items: TerminalContextMenuSettings) => {
    await updateSetting('terminalContextMenuItems', JSON.stringify(items));
  };

  const terminalSwitchPaneShortcutString = computed<string>(() => {
    return settings.value.terminalSwitchPaneShortcut || 'Alt+`';
  });

  const updateTerminalSwitchPaneShortcut = async (shortcut: string) => {
    await updateSetting('terminalSwitchPaneShortcut', shortcut);
  };

  const terminalEnableRightClickPasteBoolean = computed(() => {
      return settings.value.terminalEnableRightClickPaste !== 'false'; // Default to true
  });

    // Getter for remember last route setting, returning boolean
  const rememberLastRouteBoolean = computed(() => {
    return settings.value.rememberLastRoute !== 'false';
  });

  async function setRememberLastRoute(enabled: boolean) {
    const strVal = enabled ? 'true' : 'false';
    try {
      localStorage.setItem('nexus_remember_last_route', strVal);
      if (!enabled) {
        localStorage.removeItem('nexus_last_route');
        if (isDesktopApp()) {
          apiClient.post('/desktop/route', { clear: true }).catch(() => {});
        }
      } else {
        const currentPath = window.location.pathname;
        if (currentPath && currentPath !== '/login' && currentPath !== '/setup') {
          localStorage.setItem('nexus_last_route', currentPath);
          if (isDesktopApp()) {
            apiClient.post('/desktop/route', { route: currentPath }).catch(() => {});
          }
        }
      }
      await updateSetting('rememberLastRoute', strVal);
    } catch (err) {
      console.error('[SettingsStore] 保存 rememberLastRoute 失败:', err);
      throw err;
    }
  }

  const statusMonitorShowIpBoolean = computed(() => {
    return settings.value.showStatusMonitorIpAddress === 'true';
  });

  // +++ Getter for Quick Command row size multiplier, returning number +++
  const quickCommandRowSizeMultiplierNumber = computed(() => {
    const valStr = settings.value.quickCommandRowSizeMultiplier;
    if (valStr === null || valStr === undefined || valStr.trim() === '') {
      return 1.0; // Default value
    }
    const val = parseFloat(valStr);
    return isNaN(val) || val <= 0 ? 1.0 : val; // Fallback to 1.0 if invalid
  });

  // +++ Getter for Quick Command compact mode, returning boolean +++
  const quickCommandsCompactModeBoolean = computed(() => {
    return settings.value.quickCommandsCompactMode === 'true';
  });
  
  const setFileEditorModalSize = async (width: number, height: number) => {
    const w = String(Math.round(width));
    const h = String(Math.round(height));
    if (settings.value.fileEditorModalWidth === w && settings.value.fileEditorModalHeight === h) {
      return;
    }
    settings.value.fileEditorModalWidth = w;
    settings.value.fileEditorModalHeight = h;
    try {
      await updateMultipleSettings({
        fileEditorModalWidth: w,
        fileEditorModalHeight: h,
      });
    } catch (e) {
      console.warn('[SettingsStore] 保存文本编辑器窗口尺寸失败:', e);
    }
  };
  const markdownDefaultViewModeString = computed<'preview' | 'split' | 'edit'>(() => {
    const val = settings.value.markdownDefaultViewMode;
    return (val === 'preview' || val === 'edit') ? val : 'split';
  });

  const markdownDefaultViewModeMobileString = computed<'preview' | 'split' | 'edit'>(() => {
    const val = settings.value.markdownDefaultViewModeMobile;
    return (val === 'split' || val === 'edit') ? val : 'preview';
  });

  const updateMarkdownDefaultViewMode = async (mode: 'preview' | 'split' | 'edit') => {
    await updateSetting('markdownDefaultViewMode', mode);
  };

  const updateMarkdownDefaultViewModeMobile = async (mode: 'preview' | 'split' | 'edit') => {
    await updateSetting('markdownDefaultViewModeMobile', mode);
  };

 return {
    setFileEditorModalSize,
    markdownDefaultViewModeString,
    markdownDefaultViewModeMobileString,
    updateMarkdownDefaultViewMode,
    updateMarkdownDefaultViewModeMobile,
    settings, // 只包含通用设置
    isLoading,
    error,
    language,
    showPopupFileEditorBoolean,
    showPopupFileManagerBoolean, // +++ 暴露弹窗文件管理器 getter +++
    shareFileEditorTabsBoolean,
    fileEditorLargeFileConfirmBoolean,
    desktopFileOpenModeString, // 桌面端文件打开方式 getter
    ipWhitelistEnabled, // 暴露 IP 白名单启用状态
    ipBlacklistEnabledBoolean, // <-- NEW: 暴露 IP 黑名单启用状态 getter
    autoCopyOnSelectBoolean,
    dockerDefaultExpandBoolean, // +++ 暴露 Docker 默认展开 getter +++
    statusMonitorIntervalSecondsNumber, // +++ 暴露状态监控间隔 getter +++
    workspaceSidebarPersistentBoolean, // +++ 暴露侧边栏固定 getter +++
    getSidebarPaneWidth, // +++ 暴露获取特定面板宽度的 getter +++
    fileManagerRowSizeMultiplierNumber, // +++ 暴露文件管理器行大小 getter +++
    fileManagerColWidthsObject, // +++ 暴露文件管理器列宽 getter +++
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
    updateSidebarPaneWidth, // +++ 暴露更新特定面板宽度的 action +++
    updateFileManagerLayoutSettings, // +++ 暴露更新文件管理器布局的 action +++
    updateQuickCommandRowSizeMultiplier, // +++ 暴露快捷命令大小更新 action +++
    commandInputSyncTarget, // +++ 暴露命令输入同步目标 getter +++
    timezone,
    quickCommandRowSizeMultiplierNumber, // +++ 暴露快捷命令大小 getter +++
    quickCommandsCompactModeBoolean, // +++ 暴露快捷指令紧凑模式 getter +++
    dashboardSortBy,
    dashboardSortOrder,
    saveDashboardSortPreference,
    //  Expose folder visibility getters
    showConnectionFoldersBoolean,
    showQuickCommandFoldersBoolean,
    //  Expose layout locked getter
    layoutLockedBoolean,
    terminalScrollbackLimitNumber, //  Expose terminal scrollback limit getter
    fileManagerShowDeleteConfirmationBoolean, //  Expose file manager delete confirmation getter
    fileManagerHighlightChangesBoolean, //  文件列表增量变动高亮开关
    fileManagerShowHiddenBoolean, //  文件管理器显示隐藏文件开关
    fileManagerDoubleClickToOpenBoolean, //  Expose file manager double click to open getter
    terminalEnableRightClickPasteBoolean, //  Expose terminal right click paste getter
    terminalRightClickBehaviorString,
    terminalContextMenuItemsObject,
    updateTerminalRightClickBehavior,
    updateTerminalContextMenuItems,
    terminalNoWrapBoolean, // Expose terminal no wrap getter
    statusMonitorShowIpBoolean, // 暴露状态监视器显示IP getter
    rememberLastRouteBoolean, // 暴露记住上次停留页面 getter
    setRememberLastRoute, // 暴露设置记住上次停留页面 action
    terminalSwitchPaneShortcutString,
    updateTerminalSwitchPaneShortcut,
  };
  });
