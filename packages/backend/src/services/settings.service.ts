import {
    settingsRepository,
    Setting,
    getSidebarConfig as getSidebarConfigFromRepo,
    setSidebarConfig as setSidebarConfigInRepo,
    getCaptchaConfig as getCaptchaConfigFromRepo,
    setCaptchaConfig as setCaptchaConfigInRepo,
} from '../repositories/settings.repository';
import {
    SidebarConfig,
    PaneName,
    UpdateSidebarConfigDto,
    CaptchaSettings,
    UpdateCaptchaSettingsDto,
    CaptchaProvider,
    AutoLoginSettings, // <-- 新增导入
    AutoLoginCloudflareSettings, // <-- 新增导入
    AutoLoginIpWhitelistSettings, // <-- 新增导入
} from '../types/settings.types';

// 环境变量键名定义
const AUTOLOGIN_CLOUDFLARE_ENABLED_KEY = 'AUTOLOGIN_CLOUDFLARE_ENABLED';
const AUTOLOGIN_CLOUDFLARE_TRUSTED_IPS_KEY = 'AUTOLOGIN_CLOUDFLARE_TRUSTED_IPS';
const AUTOLOGIN_IP_WHITELIST_ENABLED_KEY = 'AUTOLOGIN_IP_WHITELIST_ENABLED';
const AUTOLOGIN_IP_WHITELIST_IPS_KEY = 'AUTOLOGIN_IP_WHITELIST_IPS';


// +++ 定义焦点切换完整配置接口 (与前端 store 保持一致) +++
interface FocusItemConfig { // 单个项目的配置
  shortcut?: string;
}
interface FocusSwitcherFullConfig { // 完整配置结构
  sequence: string[];
  shortcuts: Record<string, FocusItemConfig>;
}

const FOCUS_SEQUENCE_KEY = 'focusSwitcherSequence'; // 设置键保持不变
const NAV_BAR_VISIBLE_KEY = 'navBarVisible'; // 导航栏可见性设置键
const LAYOUT_TREE_KEY = 'layoutTree'; // 布局树设置键
const AUTO_COPY_ON_SELECT_KEY = 'autoCopyOnSelect'; // 终端选中自动复制设置键
const STATUS_MONITOR_INTERVAL_SECONDS_KEY = 'statusMonitorIntervalSeconds'; // 状态监控间隔设置键
const DEFAULT_STATUS_MONITOR_INTERVAL_SECONDS = 3; // 默认状态监控间隔
const IP_BLACKLIST_ENABLED_KEY = 'ipBlacklistEnabled'; // IP 黑名单启用设置键
const SHOW_CONNECTION_TAGS_KEY = 'showConnectionTags'; // 连接标签显示设置键
const SHOW_QUICK_COMMAND_TAGS_KEY = 'showQuickCommandTags'; // 快捷指令标签显示设置键

export const settingsService = {
  /**
   * 获取所有设置项
   * @returns 返回包含所有设置项的键值对记录
   */
  async getAllSettings(): Promise<Record<string, string>> {
    // console.log('[Service] Calling repository.getAllSettings...');
    const settingsArray = await settingsRepository.getAllSettings();
    // console.log('[Service] Got settings array from repository:', JSON.stringify(settingsArray));
    const settingsRecord: Record<string, string> = {};
    settingsArray.forEach(setting => {
      settingsRecord[setting.key] = setting.value;
    });
    return settingsRecord;
  },

  /**
   * 获取单个设置项的值
   * @param key 设置项的键
   * @returns 返回设置项的值，如果不存在则返回 null
   */
  async getSetting(key: string): Promise<string | null> {
    return settingsRepository.getSetting(key);
  },

  /**
   * 设置单个设置项的值 (如果键已存在则更新)
   * @param key 设置项的键
   * @param value 设置项的值
   */
  async setSetting(key: string, value: string): Promise<void> {
    await settingsRepository.setSetting(key, value);
  },

  /**
   * 批量设置多个设置项的值
   * @param settings 包含多个设置项键值对的对象
   */
  async setMultipleSettings(settings: Record<string, string>): Promise<void> {
    console.log('[Service] Calling repository.setMultipleSettings with:', JSON.stringify(settings));
    await settingsRepository.setMultipleSettings(settings);
    console.log('[Service] Finished repository.setMultipleSettings.');
  },

  /**
   * 删除单个设置项
   * @param key 要删除的设置项的键
   */
  async deleteSetting(key: string): Promise<void> {
    await settingsRepository.deleteSetting(key);
  },

  /**
   * 获取 IP 白名单设置
   * @returns 返回包含启用状态和白名单列表的对象
   */
  async getIpWhitelistSettings(): Promise<{ enabled: boolean; whitelist: string }> {
    const enabledStr = await settingsRepository.getSetting('ipWhitelistEnabled');
    const whitelist = await settingsRepository.getSetting('ipWhitelist');
    return {
      enabled: enabledStr === 'true',
      whitelist: whitelist ?? '',
    };
  },

  /**
   * 更新 IP 白名单设置
   * @param enabled 是否启用 IP 白名单
   * @param whitelist 允许的 IP 地址/CIDR 列表 (字符串形式)
   */
  async updateIpWhitelistSettings(enabled: boolean, whitelist: string): Promise<void> {
    await Promise.all([
      settingsRepository.setSetting('ipWhitelistEnabled', String(enabled)),
      settingsRepository.setSetting('ipWhitelist', whitelist),
    ]);
  },

  /**
   * 检查 IP 黑名单功能是否已启用
   * @returns 返回是否启用 (boolean)，如果未设置则默认为 true
   */
  async isIpBlacklistEnabled(): Promise<boolean> {
    console.log(`[Service] Attempting to get setting for key: ${IP_BLACKLIST_ENABLED_KEY}`);
    try {
      const enabledStr = await settingsRepository.getSetting(IP_BLACKLIST_ENABLED_KEY);
      console.log(`[Service] Raw value from repository for ${IP_BLACKLIST_ENABLED_KEY}:`, enabledStr);
      // 如果设置存在且值为 'false'，则返回 false，否则都返回 true (包括未设置的情况)
      return enabledStr !== 'false';
    } catch (error) {
      console.error(`[Service] Error getting IP blacklist enabled setting (key: ${IP_BLACKLIST_ENABLED_KEY}):`, error);
      // 出错时返回默认值 true (安全起见，默认启用)
      return true;
    }
  }, // *** 确保这里有逗号 ***

  /**
   * 获取焦点切换顺序
   * @returns 返回存储的完整焦点切换配置对象，如果未设置或无效则返回默认空配置
   */
  async getFocusSwitcherSequence(): Promise<FocusSwitcherFullConfig> { // +++ 更新返回类型 +++
    console.log(`[Service] Attempting to get setting for key: ${FOCUS_SEQUENCE_KEY}`);
    const defaultConfig: FocusSwitcherFullConfig = { sequence: [], shortcuts: {} }; // 默认值
    try {
      const configJson = await settingsRepository.getSetting(FOCUS_SEQUENCE_KEY);
      console.log(`[Service] Raw value from repository for ${FOCUS_SEQUENCE_KEY}:`, configJson);
      if (configJson) {
        const config = JSON.parse(configJson);
        // +++ 验证 FocusSwitcherFullConfig 结构 +++
        if (
          typeof config === 'object' && config !== null &&
          Array.isArray(config.sequence) && config.sequence.every((item: any) => typeof item === 'string') &&
          typeof config.shortcuts === 'object' && config.shortcuts !== null &&
          Object.values(config.shortcuts).every((sc: any) => typeof sc === 'object' && sc !== null && (sc.shortcut === undefined || typeof sc.shortcut === 'string'))
        ) {
          console.log('[Service] Fetched and validated full focus switcher config:', JSON.stringify(config));
          return config as FocusSwitcherFullConfig;
        } else {
          console.warn('[Service] Invalid full focus switcher config format found in settings. Returning default.');
        }
      } else {
        console.log('[Service] No focus switcher config found in settings. Returning default.');
      }
    } catch (error) {
      console.error(`[Service] Error parsing full focus switcher config from settings (key: ${FOCUS_SEQUENCE_KEY}):`, error);
    }
    console.log('[Service] Returning default focus config:', JSON.stringify(defaultConfig));
    return defaultConfig;
  },

  /**
   * 设置完整的焦点切换配置
   * @param fullConfig 包含 sequence 和 shortcuts 的完整配置对象
   */
  async setFocusSwitcherSequence(fullConfig: FocusSwitcherFullConfig): Promise<void> { // +++ 更新参数类型 +++
    console.log('[Service] setFocusSwitcherSequence called with full config:', JSON.stringify(fullConfig));
    // +++ 验证 FocusSwitcherFullConfig 结构 (控制器层已做基本验证) +++
     if (
          !(typeof fullConfig === 'object' && fullConfig !== null &&
          Array.isArray(fullConfig.sequence) && fullConfig.sequence.every((item: any) => typeof item === 'string') &&
          typeof fullConfig.shortcuts === 'object' && fullConfig.shortcuts !== null &&
          Object.values(fullConfig.shortcuts).every((sc: any) => typeof sc === 'object' && sc !== null && (sc.shortcut === undefined || typeof sc.shortcut === 'string')))
     ) {
       console.error('[Service] Attempted to save invalid full focus switcher config format:', fullConfig);
       throw new Error('Invalid full config format provided.');
     }
     // TODO: 可能需要进一步验证 sequence 中的 id 和 shortcuts 中的 key 是否有效

    try {
      const configJson = JSON.stringify(fullConfig); // +++ 序列化完整结构 +++
      console.log(`[Service] Attempting to save setting. Key: ${FOCUS_SEQUENCE_KEY}, Value: ${configJson}`);
      await settingsRepository.setSetting(FOCUS_SEQUENCE_KEY, configJson);
      console.log(`[Service] Successfully saved setting for key: ${FOCUS_SEQUENCE_KEY}`);
    } catch (error) {
      console.error(`[Service] Error calling settingsRepository.setSetting for key ${FOCUS_SEQUENCE_KEY}:`, error);
      throw new Error('Failed to save focus switcher sequence.');
    }
  }, // *** 确保这里有逗号 ***

  /**
   * 获取导航栏可见性设置
   * @returns 返回导航栏是否可见 (boolean)，如果未设置则默认为 true
   */
  async getNavBarVisibility(): Promise<boolean> {
    console.log(`[Service] Attempting to get setting for key: ${NAV_BAR_VISIBLE_KEY}`);
    try {
      const visibleStr = await settingsRepository.getSetting(NAV_BAR_VISIBLE_KEY);
      console.log(`[Service] Raw value from repository for ${NAV_BAR_VISIBLE_KEY}:`, visibleStr);
      // 如果设置存在且值为 'false'，则返回 false，否则都返回 true (包括未设置的情况)
      return visibleStr !== 'false';
    } catch (error) {
      console.error(`[Service] Error getting nav bar visibility setting (key: ${NAV_BAR_VISIBLE_KEY}):`, error);
      // 出错时返回默认值 true
      return true;
    }
  }, // *** 确保这里有逗号 ***

  /**
   * 设置导航栏可见性
   * @param visible 是否可见 (boolean)
   */
  async setNavBarVisibility(visible: boolean): Promise<void> {
    console.log(`[Service] setNavBarVisibility called with: ${visible}`);
    try {
      const visibleStr = String(visible); // 将布尔值转换为 'true' 或 'false'
      console.log(`[Service] Attempting to save setting. Key: ${NAV_BAR_VISIBLE_KEY}, Value: ${visibleStr}`);
      await settingsRepository.setSetting(NAV_BAR_VISIBLE_KEY, visibleStr);
      console.log(`[Service] Successfully saved setting for key: ${NAV_BAR_VISIBLE_KEY}`);
    } catch (error) {
      console.error(`[Service] Error calling settingsRepository.setSetting for key ${NAV_BAR_VISIBLE_KEY}:`, error);
      throw new Error('Failed to save nav bar visibility setting.');
    }
  }, // *** 确保这里有逗号 ***

 /**
  * 获取布局树设置
  * @returns 返回存储的布局树 JSON 字符串，如果未设置则返回 null
  */
 async getLayoutTree(): Promise<string | null> {
   console.log(`[Service] Attempting to get setting for key: ${LAYOUT_TREE_KEY}`);
   try {
     const layoutJson = await settingsRepository.getSetting(LAYOUT_TREE_KEY);
     console.log(`[Service] Raw value from repository for ${LAYOUT_TREE_KEY}:`, layoutJson ? layoutJson.substring(0, 100) + '...' : null); // 只打印部分内容
     return layoutJson; // 直接返回 JSON 字符串或 null
   } catch (error) {
     console.error(`[Service] Error getting layout tree setting (key: ${LAYOUT_TREE_KEY}):`, error);
     return null; // 出错时返回 null
   }
 }, // *** 确保这里有逗号 ***

 /**
  * 设置布局树
  * @param layoutJson 布局树的 JSON 字符串
  */
 async setLayoutTree(layoutJson: string): Promise<void> {
   console.log(`[Service] setLayoutTree called with JSON (first 100 chars): ${layoutJson.substring(0, 100)}...`);
   // 可选：在这里添加 JSON 格式验证
   try {
      JSON.parse(layoutJson); // 尝试解析以验证格式
   } catch (e) {
      console.error('[Service] Invalid JSON format provided for layout tree:', e);
      throw new Error('Invalid layout tree JSON format.');
   }

   try {
     console.log(`[Service] Attempting to save setting. Key: ${LAYOUT_TREE_KEY}`);
     await settingsRepository.setSetting(LAYOUT_TREE_KEY, layoutJson);
     console.log(`[Service] Successfully saved setting for key: ${LAYOUT_TREE_KEY}`);
   } catch (error) {
     console.error(`[Service] Error calling settingsRepository.setSetting for key ${LAYOUT_TREE_KEY}:`, error);
     throw new Error('Failed to save layout tree setting.');
   }
 }, // *** 确保这里有逗号 ***

 /**
  * 获取终端选中自动复制设置
  * @returns 返回是否启用该功能 (boolean)，如果未设置则默认为 false
  */
 async getAutoCopyOnSelect(): Promise<boolean> {
   console.log(`[Service] Attempting to get setting for key: ${AUTO_COPY_ON_SELECT_KEY}`);
   try {
     const enabledStr = await settingsRepository.getSetting(AUTO_COPY_ON_SELECT_KEY);
     console.log(`[Service] Raw value from repository for ${AUTO_COPY_ON_SELECT_KEY}:`, enabledStr);
     // 如果设置存在且值为 'true'，则返回 true，否则都返回 false (包括未设置或值为 'false' 的情况)
     return enabledStr === 'true';
   } catch (error) {
     console.error(`[Service] Error getting auto copy on select setting (key: ${AUTO_COPY_ON_SELECT_KEY}):`, error);
     // 出错时返回默认值 false
     return false;
   }
 }, // *** 确保这里有逗号 ***

 /**
  * 设置终端选中自动复制
  * @param enabled 是否启用 (boolean)
  */
 async setAutoCopyOnSelect(enabled: boolean): Promise<void> {
   console.log(`[Service] setAutoCopyOnSelect called with: ${enabled}`);
   try {
     const enabledStr = String(enabled); // 将布尔值转换为 'true' 或 'false'
     console.log(`[Service] Attempting to save setting. Key: ${AUTO_COPY_ON_SELECT_KEY}, Value: ${enabledStr}`);
     await settingsRepository.setSetting(AUTO_COPY_ON_SELECT_KEY, enabledStr);
     console.log(`[Service] Successfully saved setting for key: ${AUTO_COPY_ON_SELECT_KEY}`);
   } catch (error) {
     console.error(`[Service] Error calling settingsRepository.setSetting for key ${AUTO_COPY_ON_SELECT_KEY}:`, error);
     throw new Error('Failed to save auto copy on select setting.');
   }
 }, // *** 确保这里有逗号 ***

 /**
  * 获取状态监控轮询间隔 (秒)
  * @returns 返回间隔秒数 (number)，如果未设置或无效则返回默认值
  */
 async getStatusMonitorIntervalSeconds(): Promise<number> {
   console.log(`[Service] Attempting to get setting for key: ${STATUS_MONITOR_INTERVAL_SECONDS_KEY}`);
   try {
     const intervalStr = await settingsRepository.getSetting(STATUS_MONITOR_INTERVAL_SECONDS_KEY);
     console.log(`[Service] Raw value from repository for ${STATUS_MONITOR_INTERVAL_SECONDS_KEY}:`, intervalStr);
     if (intervalStr) {
       const intervalNum = parseInt(intervalStr, 10);
       // 验证是否为正整数
       if (!isNaN(intervalNum) && intervalNum > 0) {
         return intervalNum;
       } else {
         console.warn(`[Service] Invalid status monitor interval value found ('${intervalStr}'). Returning default.`);
       }
     } else {
       console.log(`[Service] No status monitor interval found in settings. Returning default.`);
     }
   } catch (error) {
     console.error(`[Service] Error getting status monitor interval setting (key: ${STATUS_MONITOR_INTERVAL_SECONDS_KEY}):`, error);
   }
   // 返回默认值
   return DEFAULT_STATUS_MONITOR_INTERVAL_SECONDS;
 }, // *** 确保这里有逗号 ***

 /**
  * 设置状态监控轮询间隔 (秒)
  * @param interval 间隔秒数 (number)
  */
 async setStatusMonitorIntervalSeconds(interval: number): Promise<void> {
   console.log(`[Service] setStatusMonitorIntervalSeconds called with: ${interval}`);
   // 验证输入是否为正整数
   if (!Number.isInteger(interval) || interval <= 0) {
     console.error(`[Service] Attempted to save invalid status monitor interval: ${interval}`);
     throw new Error('Invalid interval value provided. Must be a positive integer.');
   }
   try {
     const intervalStr = String(interval);
     console.log(`[Service] Attempting to save setting. Key: ${STATUS_MONITOR_INTERVAL_SECONDS_KEY}, Value: ${intervalStr}`);
     await settingsRepository.setSetting(STATUS_MONITOR_INTERVAL_SECONDS_KEY, intervalStr);
     console.log(`[Service] Successfully saved setting for key: ${STATUS_MONITOR_INTERVAL_SECONDS_KEY}`);
   } catch (error) {
     console.error(`[Service] Error calling settingsRepository.setSetting for key ${STATUS_MONITOR_INTERVAL_SECONDS_KEY}:`, error);
     throw new Error('Failed to save status monitor interval setting.');
   }
 }, // *** 确保这里有逗号 ***

 // --- Sidebar Config Specific Functions ---

 /**
  * 获取侧栏配置
  * @returns Promise<SidebarConfig>
  */
 async getSidebarConfig(): Promise<SidebarConfig> {
     console.log('[SettingsService] Getting sidebar config...');
     // Directly call the specific repository function
     const config = await getSidebarConfigFromRepo();
     console.log('[SettingsService] Returning sidebar config:', config);
     return config;
 },

 /**
  * 设置侧栏配置
  * @param configDto - The sidebar configuration object from DTO
  * @returns Promise<void>
  */
 async setSidebarConfig(configDto: UpdateSidebarConfigDto): Promise<void> {
     console.log('[SettingsService] Setting sidebar config:', configDto);

     // --- Validation ---
     if (!configDto || typeof configDto !== 'object' || !Array.isArray(configDto.left) || !Array.isArray(configDto.right)) {
         throw new Error('无效的侧栏配置格式。必须包含 left 和 right 数组。');
     }

     // Validate PaneName (using the type imported)
     const validPaneNames: Set<PaneName> = new Set([
         'connections', 'terminal', 'commandBar', 'fileManager',
         'editor', 'statusMonitor', 'commandHistory', 'quickCommands',
         'dockerManager'
     ]);

     const validatePaneArray = (arr: any[], side: string) => {
         if (!arr.every(item => typeof item === 'string' && validPaneNames.has(item as PaneName))) {
             const invalidItems = arr.filter(item => typeof item !== 'string' || !validPaneNames.has(item as PaneName));
             throw new Error(`侧栏配置 (${side}) 包含无效的面板名称: ${invalidItems.join(', ')}`);
         }
     };

     validatePaneArray(configDto.left, 'left');
     validatePaneArray(configDto.right, 'right');

     // Prevent duplicates (optional, uncomment if needed)
     // const allPanes = [...configDto.left, ...configDto.right];
     // const uniquePanes = new Set(allPanes);
     // if (allPanes.length !== uniquePanes.size) {
     //     throw new Error('侧栏配置中不允许包含重复的面板。');
     // }

     // Prepare the data in the exact SidebarConfig format expected by the repo
     const configToSave: SidebarConfig = {
         left: configDto.left,
         right: configDto.right,
     };

     // Directly call the specific repository function
     await setSidebarConfigInRepo(configToSave);
     console.log('[SettingsService] Sidebar config successfully set.');
 }, // <-- Add comma here

 // --- CAPTCHA Settings Specific Functions ---

 /**
  * 获取 CAPTCHA 配置
  * @returns Promise<CaptchaSettings>
  */
 async getCaptchaConfig(): Promise<CaptchaSettings> {
     console.log('[SettingsService] Getting CAPTCHA config...');
     // Directly call the specific repository function
     const config = await getCaptchaConfigFromRepo();
     // Mask secret keys before logging
     const maskedConfig = { ...config, hcaptchaSecretKey: '***', recaptchaSecretKey: '***' };
     console.log('[SettingsService] Returning CAPTCHA config:', maskedConfig);
     return config;
 },

 /**
  * 设置 CAPTCHA 配置
  * @param configDto - The CAPTCHA configuration object from DTO
  * @returns Promise<void>
  */
 async setCaptchaConfig(configDto: UpdateCaptchaSettingsDto): Promise<void> {
     console.log('[SettingsService] Setting CAPTCHA config (DTO):', { ...configDto, hcaptchaSecretKey: '***', recaptchaSecretKey: '***' }); // Mask secrets in log

     // --- Validation ---
     if (!configDto || typeof configDto !== 'object') {
         throw new Error('无效的 CAPTCHA 配置格式。');
     }

     // Fetch the current settings to merge with the DTO
     const currentConfig = await getCaptchaConfigFromRepo();
     const configToSave: CaptchaSettings = { ...currentConfig };

     // Validate and update individual fields from DTO
     if (configDto.enabled !== undefined) {
         if (typeof configDto.enabled !== 'boolean') throw new Error('captcha.enabled 必须是布尔值。');
         configToSave.enabled = configDto.enabled;
     }
     if (configDto.provider !== undefined) {
         const validProviders: CaptchaProvider[] = ['hcaptcha', 'recaptcha', 'none'];
         if (!validProviders.includes(configDto.provider)) throw new Error(`无效的 CAPTCHA 提供商: ${configDto.provider}`);
         configToSave.provider = configDto.provider;
     }
     if (configDto.hcaptchaSiteKey !== undefined) {
         if (typeof configDto.hcaptchaSiteKey !== 'string') throw new Error('hcaptchaSiteKey 必须是字符串。');
         configToSave.hcaptchaSiteKey = configDto.hcaptchaSiteKey;
     }
     if (configDto.hcaptchaSecretKey !== undefined) {
         if (typeof configDto.hcaptchaSecretKey !== 'string') throw new Error('hcaptchaSecretKey 必须是字符串。');
         configToSave.hcaptchaSecretKey = configDto.hcaptchaSecretKey;
     }
     if (configDto.recaptchaSiteKey !== undefined) {
         if (typeof configDto.recaptchaSiteKey !== 'string') throw new Error('recaptchaSiteKey 必须是字符串。');
         configToSave.recaptchaSiteKey = configDto.recaptchaSiteKey;
     }
     if (configDto.recaptchaSecretKey !== undefined) {
         if (typeof configDto.recaptchaSecretKey !== 'string') throw new Error('recaptchaSecretKey 必须是字符串。');
         configToSave.recaptchaSecretKey = configDto.recaptchaSecretKey;
     }

     // Ensure consistency: if disabled, provider should ideally be 'none' (optional enforcement)
     // if (!configToSave.enabled) {
     //     configToSave.provider = 'none';
     // }

     // Directly call the specific repository function with the full, validated config
     await setCaptchaConfigInRepo(configToSave);
     console.log('[SettingsService] CAPTCHA config successfully set.');
 }, // <-- Add comma here

 // --- Show Connection Tags ---
 async getShowConnectionTags(): Promise<boolean> {
   console.log(`[Service] Attempting to get setting for key: ${SHOW_CONNECTION_TAGS_KEY}`);
   try {
     const valueStr = await settingsRepository.getSetting(SHOW_CONNECTION_TAGS_KEY);
     console.log(`[Service] Raw value from repository for ${SHOW_CONNECTION_TAGS_KEY}:`, valueStr);
     // 默认显示，所以只有当值为 'false' 时才返回 false
     return valueStr !== 'false';
   } catch (error) {
     console.error(`[Service] Error getting show connection tags setting (key: ${SHOW_CONNECTION_TAGS_KEY}):`, error);
     return true; // 默认返回 true
   }
 }, // *** 确保这里有逗号 ***

 async setShowConnectionTags(enabled: boolean): Promise<void> {
   console.log(`[Service] setShowConnectionTags called with: ${enabled}`);
   try {
     const valueStr = String(enabled);
     console.log(`[Service] Attempting to save setting. Key: ${SHOW_CONNECTION_TAGS_KEY}, Value: ${valueStr}`);
     await settingsRepository.setSetting(SHOW_CONNECTION_TAGS_KEY, valueStr);
     console.log(`[Service] Successfully saved setting for key: ${SHOW_CONNECTION_TAGS_KEY}`);
   } catch (error) {
     console.error(`[Service] Error calling settingsRepository.setSetting for key ${SHOW_CONNECTION_TAGS_KEY}:`, error);
     throw new Error('Failed to save show connection tags setting.');
   }
 }, // *** 确保这里有逗号 ***

 // --- Show Quick Command Tags ---
 async getShowQuickCommandTags(): Promise<boolean> {
   console.log(`[Service] Attempting to get setting for key: ${SHOW_QUICK_COMMAND_TAGS_KEY}`);
   try {
     const valueStr = await settingsRepository.getSetting(SHOW_QUICK_COMMAND_TAGS_KEY);
     console.log(`[Service] Raw value from repository for ${SHOW_QUICK_COMMAND_TAGS_KEY}:`, valueStr);
     // 默认显示，所以只有当值为 'false' 时才返回 false
     return valueStr !== 'false';
   } catch (error) {
     console.error(`[Service] Error getting show quick command tags setting (key: ${SHOW_QUICK_COMMAND_TAGS_KEY}):`, error);
     return true; // 默认返回 true
   }
 }, // *** 确保这里有逗号 ***

 async setShowQuickCommandTags(enabled: boolean): Promise<void> {
   console.log(`[Service] setShowQuickCommandTags called with: ${enabled}`);
   try {
     const valueStr = String(enabled);
     console.log(`[Service] Attempting to save setting. Key: ${SHOW_QUICK_COMMAND_TAGS_KEY}, Value: ${valueStr}`);
     await settingsRepository.setSetting(SHOW_QUICK_COMMAND_TAGS_KEY, valueStr);
     console.log(`[Service] Successfully saved setting for key: ${SHOW_QUICK_COMMAND_TAGS_KEY}`);
   } catch (error) {
     console.error(`[Service] Error calling settingsRepository.setSetting for key ${SHOW_QUICK_COMMAND_TAGS_KEY}:`, error);
     throw new Error('Failed to save show quick command tags setting.');
   }
 }, // <-- Add comma here for new methods

 // --- Auto Login Settings ---

 /**
  * 获取 Cloudflare Access 自动登录设置
  * @returns Promise<AutoLoginCloudflareSettings>
  */
 async getAutoLoginCloudflareSettings(): Promise<AutoLoginCloudflareSettings> {
   // 仅从数据库读取
   const dbEnabledStr = await settingsRepository.getSetting('autoLoginCloudflareEnabled');
   const dbTrustedIPsStr = await settingsRepository.getSetting('autoLoginCloudflareTrustedIPs');

   // 如果数据库中没有设置，则默认为禁用和空列表
   const enabled = dbEnabledStr === 'true'; // 如果 dbEnabledStr 为 null 或 'false'，则为 false
   const trustedIPsString = dbTrustedIPsStr || ''; // 如果 dbTrustedIPsStr 为 null，则为空字符串
   
   const trustedIPs = trustedIPsString ? trustedIPsString.split(',').map(ip => ip.trim()).filter(ip => ip) : [];
   
   console.log(`[SettingsService] Cloudflare AutoLogin (DB Only) Enabled: ${enabled} (DB value: ${dbEnabledStr}), Trusted IPs: ${trustedIPs.join(', ')} (DB value: ${dbTrustedIPsStr})`);
   return { enabled, trustedIPs };
 },

 /**
  * 获取 IP 白名单自动登录设置
  * @returns Promise<AutoLoginIpWhitelistSettings>
  */
 async getAutoLoginIpWhitelistSettings(): Promise<AutoLoginIpWhitelistSettings> {
   // 仅从数据库读取
   const dbEnabledStr = await settingsRepository.getSetting('autoLoginIpWhitelistEnabled');
   const dbAllowedIPsStr = await settingsRepository.getSetting('autoLoginIpWhitelistAllowedIPs');

   // 如果数据库中没有设置，则默认为禁用和空列表
   const enabled = dbEnabledStr === 'true'; // 如果 dbEnabledStr 为 null 或 'false'，则为 false
   const allowedIPsString = dbAllowedIPsStr || ''; // 如果 dbAllowedIPsStr 为 null，则为空字符串

   const allowedIPs = allowedIPsString ? allowedIPsString.split(',').map(ip => ip.trim()).filter(ip => ip) : [];

   console.log(`[SettingsService] IP Whitelist AutoLogin (DB Only) Enabled: ${enabled} (DB value: ${dbEnabledStr}), Allowed IPs: ${allowedIPs.join(', ')} (DB value: ${dbAllowedIPsStr})`);
   return { enabled, allowedIPs };
 },

 /**
  * 获取所有自动登录相关的设置
  * @returns Promise<AutoLoginSettings>
  */
 async getAutoLoginSettings(): Promise<AutoLoginSettings> {
   const cloudflare = await this.getAutoLoginCloudflareSettings();
   const ipWhitelist = await this.getAutoLoginIpWhitelistSettings();
   return {
     cloudflare,
     ipWhitelist,
   };
 },

 /**
  * 启用 IP 白名单自动登录并将当前 IP 添加到白名单中。
  * @param clientIp 要添加到白名单的客户端 IP 地址。
  */
 async enableIpWhitelistAndAddCurrentIp(clientIp: string): Promise<void> {
   if (!clientIp) {
     console.warn('[SettingsService] enableIpWhitelistAndAddCurrentIp: clientIp is empty, skipping.');
     return;
   }

   console.log(`[SettingsService] Attempting to enable IP whitelist auto-login and add IP: ${clientIp}`);
   try {
     // 1. 获取当前的 IP 白名单自动登录设置 (优先从数据库读取)
     const currentEnabledStr = await settingsRepository.getSetting('autoLoginIpWhitelistEnabled');
     const currentAllowedIPsStr = await settingsRepository.getSetting('autoLoginIpWhitelistAllowedIPs');

     let newEnabled = 'true'; // 总是尝试启用
     let currentAllowedIPsArray: string[] = [];

     if (currentAllowedIPsStr) {
       currentAllowedIPsArray = currentAllowedIPsStr.split(',').map(ip => ip.trim()).filter(ip => ip);
     }

     // 2. 添加新的 IP (如果不存在)
     if (!currentAllowedIPsArray.includes(clientIp)) {
       currentAllowedIPsArray.push(clientIp);
     }

     const newAllowedIPsStr = currentAllowedIPsArray.join(',');

     // 3. 准备要更新的设置
     const settingsToUpdate: Record<string, string> = {
       autoLoginIpWhitelistEnabled: newEnabled,
       autoLoginIpWhitelistAllowedIPs: newAllowedIPsStr,
     };

     // 4. 保存回数据库
     await this.setMultipleSettings(settingsToUpdate); // 使用 this 调用
     console.log(`[SettingsService] IP whitelist auto-login enabled and IP ${clientIp} added/confirmed in whitelist.`);

   } catch (error) {
     console.error(`[SettingsService] Error enabling IP whitelist auto-login or adding IP ${clientIp}:`, error);
     // 可以选择性地重新抛出错误，或者静默处理
     // throw error;
   }
 }

}; // <-- End of settingsService object definition
