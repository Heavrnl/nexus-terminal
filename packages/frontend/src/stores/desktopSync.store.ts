import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import axios from 'axios';
import { isDesktopApp } from '../utils/platform';
import { useConnectionsStore } from './connections.store';

export type SyncCategoryKey = 'appearance' | 'layout' | 'commandHistory' | 'quickCommands' | 'connections';

export type SyncItemKey =
  | 'connections.hosts'
  | 'connections.folders'
  | 'connections.keys'
  | 'connections.proxies'
  | 'connections.favoritePaths'
  | 'quickCommands.items'
  | 'quickCommands.folders'
  | 'appearance.terminalTheme'
  | 'appearance.font'
  | 'appearance.background'
  | 'appearance.textEffect'
  | 'appearance.uiTheme'
  | 'appearance.highlight'
  | 'appearance.misc'
  | 'layout.presets'
  | 'layout.componentStates'
  | 'layout.focusSwitcher'
  | 'layout.uiSettings'
  | 'commandHistory.history';

/** 兼容旧写法：同步范围里既可能是大类，也可能是子项 */
export type SyncModuleKey = SyncCategoryKey | SyncItemKey;

export interface SyncItemOption {
  key: SyncItemKey;
  label: string;
  description: string;
}

export interface SyncCategoryOption {
  key: SyncCategoryKey;
  label: string;
  description: string;
  items: SyncItemOption[];
}

/**
 * 同步范围清单。必须与后端 `packages/backend/src/sync/sync.items.ts` 一一对应，
 * 少一个子项后端就会把「用户关掉的内容」当成未登记项放行。
 */
export const SYNC_CATEGORIES: SyncCategoryOption[] = [
  {
    key: 'connections',
    label: '主机与资产',
    description: 'SSH 主机、分组、密钥、代理与常用路径',
    items: [
      { key: 'connections.hosts', label: '主机', description: '主机信息、跳板/代理绑定、端口转发、文件夹配色' },
      { key: 'connections.folders', label: '主机文件夹', description: '文件夹及其背景颜色' },
      { key: 'connections.keys', label: 'SSH 密钥', description: '密钥与口令（信封加密传输）' },
      { key: 'connections.proxies', label: '代理服务器', description: 'SOCKS / HTTP 代理配置' },
      { key: 'connections.favoritePaths', label: '常用路径', description: '文件管理器中收藏的路径' },
    ],
  },
  {
    key: 'quickCommands',
    label: '快捷指令',
    description: '快捷指令条目与文件夹',
    items: [
      { key: 'quickCommands.items', label: '快捷指令', description: '指令内容、变量与颜色' },
      { key: 'quickCommands.folders', label: '指令文件夹', description: '快捷指令的文件夹' },
    ],
  },
  {
    key: 'appearance',
    label: '外观样式',
    description: '终端配色、字体、背景图与界面外观',
    items: [
      { key: 'appearance.terminalTheme', label: '终端配色主题', description: '当前配色主题与自定义主题' },
      { key: 'appearance.font', label: '字体与字号', description: '终端/编辑器字体、字号' },
      { key: 'appearance.background', label: '背景图', description: '终端与页面背景图、遮罩透明度' },
      { key: 'appearance.textEffect', label: '文字特效', description: '文字描边与阴影' },
      { key: 'appearance.uiTheme', label: '自定义 UI 主题', description: '自定义界面配色变量' },
      { key: 'appearance.highlight', label: '高亮规则', description: '终端输出关键字高亮' },
      { key: 'appearance.misc', label: '其它外观设置', description: '未归入以上分类的外观项' },
    ],
  },
  {
    key: 'layout',
    label: '工作区布局',
    description: '面板布局、视图状态与界面设置',
    items: [
      { key: 'layout.presets', label: '布局预设', description: '布局预设及其「指定主机」绑定' },
      { key: 'layout.componentStates', label: '面板视图状态', description: '文件管理器平铺/路径同步、快捷指令视图等' },
      { key: 'layout.focusSwitcher', label: '焦点切换顺序', description: 'Alt+ 快捷键与切换顺序' },
      { key: 'layout.uiSettings', label: '界面设置', description: '其余界面偏好（主题模式、字号缩进等）' },
    ],
  },
  {
    key: 'commandHistory',
    label: '命令历史',
    description: '终端执行过的命令记录',
    items: [
      { key: 'commandHistory.history', label: '历史命令', description: '终端执行过的命令记录' },
    ],
  },
];

/** 所有子项（扁平） */
export const SYNC_ITEM_OPTIONS: SyncItemOption[] = SYNC_CATEGORIES.flatMap(c => c.items);
export const ALL_SYNC_ITEM_KEYS: SyncItemKey[] = SYNC_ITEM_OPTIONS.map(o => o.key);

/** 大类 → 子项 key */
export const SYNC_CATEGORY_ITEM_KEYS: Record<SyncCategoryKey, SyncItemKey[]> = SYNC_CATEGORIES.reduce(
  (acc, cat) => {
    acc[cat.key] = cat.items.map(i => i.key);
    return acc;
  },
  {} as Record<SyncCategoryKey, SyncItemKey[]>
);

const ITEM_KEY_SET = new Set<string>(ALL_SYNC_ITEM_KEYS);
const CATEGORY_KEY_SET = new Set<string>(SYNC_CATEGORIES.map(c => c.key));

/**
 * 把任意来源的选择归一化成子项 key 数组。
 * - 不传 / 空 → 全开
 * - 旧版本存下来的大类 key（'appearance' …）→ 展开成该大类的全部子项
 * - 无法识别的值直接忽略；一个都不认 → 全开（宁可多同步，也不要「同步完什么也没发生」）
 */
export function normalizeSyncSelection(input?: readonly string[] | null): SyncItemKey[] {
  if (!input || input.length === 0) return [...ALL_SYNC_ITEM_KEYS];
  const picked = new Set<SyncItemKey>();
  for (const raw of input) {
    if (!raw) continue;
    if (ITEM_KEY_SET.has(raw)) picked.add(raw as SyncItemKey);
    else if (CATEGORY_KEY_SET.has(raw)) {
      for (const item of SYNC_CATEGORY_ITEM_KEYS[raw as SyncCategoryKey]) picked.add(item);
    }
  }
  return picked.size > 0 ? ALL_SYNC_ITEM_KEYS.filter(k => picked.has(k)) : [...ALL_SYNC_ITEM_KEYS];
}

const STORAGE_KEY_SELECTED_MODULES = 'nexus_sync_selected_modules';

function loadPersistedModules(): SyncItemKey[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SELECTED_MODULES);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return normalizeSyncSelection(parsed.filter((v: unknown): v is string => typeof v === 'string'));
      }
    }
  } catch {}
  return [...ALL_SYNC_ITEM_KEYS];
}


export type SyncMode = 'bidirectional' | 'cloud_to_local' | 'local_to_cloud';

function loadPersistedSyncMode(): SyncMode {
  try {
    const raw = localStorage.getItem('nexus_sync_mode');
    if (raw && ['bidirectional', 'cloud_to_local', 'local_to_cloud'].includes(raw)) {
      return raw as SyncMode;
    }
  } catch {}
  return 'bidirectional';
}

export interface DesktopSyncStats {
  pushed: number;
  pulled: number;
  conflictsResolved: number;
}

export const useDesktopSyncStore = defineStore('desktopSync', () => {
  const isDesktop = ref(isDesktopApp());

  const vpsUrl = ref<string>('');
  const apiKey = ref<string>('');
  const hasApiKey = ref<boolean>(false);
  const apiKeyMasked = ref<string>('');
  const conflictStrategy = ref<string>('lww');
  const syncMode = ref<SyncMode>(loadPersistedSyncMode());
  const lastSyncTime = ref<number>(0);
  const autoSyncOnOpen = ref<boolean>(false);
  const selectedModules = ref<SyncItemKey[]>(loadPersistedModules());

  const setSyncMode = (mode: SyncMode) => {
    syncMode.value = mode;
    try {
      localStorage.setItem('nexus_sync_mode', mode);
    } catch {}
  };

  const setSelectedModules = (modules: SyncModuleKey[]) => {
    const normalized = normalizeSyncSelection(modules);
    selectedModules.value = normalized;
    try {
      localStorage.setItem(STORAGE_KEY_SELECTED_MODULES, JSON.stringify(normalized));
    } catch {}
  };

  const isTesting = ref<boolean>(false);
  const testLatency = ref<number | null>(null);
  const testError = ref<string | null>(null);

  const isSyncing = ref<boolean>(false);
  const syncStats = ref<DesktopSyncStats | null>(null);
  const syncError = ref<string | null>(null);
  const syncSuccessMessage = ref<string | null>(null);

  /**
   * 是否已配置有效的 VPS 域名与 API Key
   */
  const isConfigured = computed(() => {
    return vpsUrl.value.trim().length > 0 && (hasApiKey.value || apiKey.value.trim().length > 0);
  });

  /**
   * 从桌面端本地接口读取同步配置（后端仅返回掩码 apiKey，不暴露明文）
   */
  const fetchConfig = async (): Promise<void> => {
    if (!isDesktop.value) return;
    try {
      const res = await axios.get('/api/v1/desktop/sync/config');
      if (res.data?.success && res.data.config) {
        vpsUrl.value = res.data.config.vpsUrl || '';
        apiKeyMasked.value = res.data.config.apiKey || '';
        hasApiKey.value = Boolean(res.data.config.hasApiKey ?? (res.data.config.apiKey && res.data.config.apiKey.length > 0));
        // 明文输入框不预填掩码，仅在用户主动输入新密钥时携带
        apiKey.value = '';
        conflictStrategy.value = res.data.config.conflictStrategy || 'lww';
        if (res.data.config.syncMode) {
          setSyncMode(res.data.config.syncMode);
        }
        lastSyncTime.value = res.data.config.lastSyncTime || 0;
        autoSyncOnOpen.value = !!res.data.config.autoSyncOnOpen;
      }
    } catch (err: any) {
      console.warn('[DesktopSyncStore] 获取同步配置失败:', err);
    }
  };

  /**
   * 保存同步配置
   */
  const saveConfig = async (params: {
    vpsUrl: string;
    apiKey?: string;
    clearApiKey?: boolean;
    conflictStrategy?: string;
    syncMode?: SyncMode;
    autoSyncOnOpen?: boolean;
  }): Promise<boolean> => {
    try {
      const payload: Record<string, any> = {
        vpsUrl: params.vpsUrl.trim(),
        ...(params.conflictStrategy ? { conflictStrategy: params.conflictStrategy } : {}),
        ...(params.syncMode ? { syncMode: params.syncMode } : {}),
        ...(typeof params.autoSyncOnOpen === 'boolean' ? { autoSyncOnOpen: params.autoSyncOnOpen } : {}),
      };
      if (params.clearApiKey) {
        payload.clearApiKey = true;
      } else if (typeof params.apiKey === 'string' && params.apiKey.trim().length > 0) {
        payload.apiKey = params.apiKey.trim();
      }

      const res = await axios.post('/api/v1/desktop/sync/config', payload);
      if (res.data?.success) {
        vpsUrl.value = params.vpsUrl.trim();
        if (res.data.config) {
          apiKeyMasked.value = res.data.config.apiKey || '';
          hasApiKey.value = Boolean(res.data.config.hasApiKey);
        } else if (params.clearApiKey) {
          apiKeyMasked.value = '';
          hasApiKey.value = false;
        } else if (payload.apiKey) {
          hasApiKey.value = true;
        }
        apiKey.value = '';
        if (params.conflictStrategy) conflictStrategy.value = params.conflictStrategy;
        if (params.syncMode) setSyncMode(params.syncMode);
        if (typeof params.autoSyncOnOpen === 'boolean') autoSyncOnOpen.value = params.autoSyncOnOpen;
        return true;
      }
      return false;
    } catch (err: any) {
      console.error('[DesktopSyncStore] 保存同步配置失败:', err);
      throw new Error(err.response?.data?.error || err.message);
    }
  };

  /**
   * 测试与远程 VPS 的连通性
   */
  const testConnection = async (targetUrl?: string, targetKey?: string): Promise<{ success: boolean; latencyMs?: number; error?: string | null }> => {
    isTesting.value = true;
    testLatency.value = null;
    testError.value = null;

    try {
      const resolvedUrl = (targetUrl !== undefined ? targetUrl : vpsUrl.value).trim();
      const resolvedKey = (targetKey !== undefined ? targetKey : apiKey.value).trim();
      const payload: Record<string, string> = { vpsUrl: resolvedUrl };
      // 仅在用户输入新明文密钥时发送；留空则由后端在同源条件下安全复用本地已保存密钥
      if (resolvedKey.length > 0) {
        payload.apiKey = resolvedKey;
      }

      const res = await axios.post('/api/v1/desktop/sync/test', payload);

      if (res.data?.success) {
        testLatency.value = res.data.latencyMs;
        return { success: true, latencyMs: res.data.latencyMs };
      } else {
        const errorMsg = res.data?.error || '连接测试失败';
        testError.value = errorMsg;
        return { success: false, error: errorMsg };
      }
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || err.message || '网络连接超时';
      testError.value = errorMsg;
      return { success: false, error: errorMsg };
    } finally {
      isTesting.value = false;
    }
  };

  /**
   * 触发一次双向增量同步
   */
  const showFirstSyncModal = ref(false);
  const isFirstSync = computed(() => !lastSyncTime.value || lastSyncTime.value === 0);

  /**
   * 触发一次同步 (支持模式: bidirectional, cloud_to_local, local_to_cloud，并支持按模块筛选)
   */
  const triggerSync = async (
    mode?: SyncMode,
    modulesOverride?: SyncModuleKey[]
  ): Promise<boolean> => {
    if (!isConfigured.value) {
      syncError.value = '未配置 VPS 域名或 API Key，无法执行同步';
      return false;
    }

    const activeMode = mode || syncMode.value || 'bidirectional';
    const activeModules = modulesOverride || selectedModules.value;
    if (activeModules.length === 0) {
      syncError.value = '请至少选择一个需要同步的数据模块';
      return false;
    }

    isSyncing.value = true;
    syncError.value = null;
    syncSuccessMessage.value = null;
    showFirstSyncModal.value = false;

    try {
      const payload: Record<string, any> = {
        vpsUrl: vpsUrl.value,
        mode: activeMode,
        modules: activeModules,
      };
      if (apiKey.value.trim().length > 0) {
        payload.apiKey = apiKey.value.trim();
      }
      const res = await axios.post('/api/v1/desktop/sync/trigger', payload);

      if (res.data?.success) {
        setSyncMode(activeMode);
        lastSyncTime.value = res.data.lastSyncTime;
        syncStats.value = res.data.stats;
        const pushedCount = res.data.stats?.pushed || 0;
        const pulledCount = res.data.stats?.pulled || 0;
        if (pushedCount === 0 && pulledCount === 0) {
          syncSuccessMessage.value = '同步完成：数据已是最新，无待同步变更';
        } else {
          syncSuccessMessage.value = `同步成功 (推送到云端: ${pushedCount}，拉取到本地: ${pulledCount})`;
        }

        // 按需刷新本地数据
        await refreshAllStores(activeModules);

        return true;
      } else {
        syncError.value = res.data?.error || '同步执行失败';
        return false;
      }
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || err.message || '同步请求失败';
      syncError.value = errorMsg;
      return false;
    } finally {
      isSyncing.value = false;
    }
  };

  /**
   * 请求同步：初次同步时弹出方向选择确认，否则直接执行双向合并
   */
  const requestSync = async (forcePrompt: boolean = false): Promise<boolean> => {
    if (forcePrompt) {
      showFirstSyncModal.value = true;
      return false;
    }
    if (!isConfigured.value) return false;
    if (isFirstSync.value) {
      showFirstSyncModal.value = true;
      return false;
    }
    return triggerSync(syncMode.value);
  };

  /**
   * 刷新本地各模块 Store 数据 (供 WS 实时同步完成通知或手动同步复用)
   */
  const refreshAllStores = async (modules?: SyncModuleKey[]) => {
    // 若未指定模块，默认全量刷新所有模块，确保界面绝对与数据库保持同步
    const items = new Set<SyncItemKey>(normalizeSyncSelection(modules ?? selectedModules.value));
    const has = (key: SyncItemKey) => items.has(key);
    const anyAppearance = SYNC_CATEGORY_ITEM_KEYS.appearance.some(k => items.has(k));
    const anyLayout = SYNC_CATEGORY_ITEM_KEYS.layout.some(k => items.has(k));
    console.log('[DesktopSyncStore] 正在无感刷新本地各模块 Store 数据...', [...items]);

    const refreshTasks: Promise<any>[] = [];

    if (has('connections.hosts')) {
      refreshTasks.push((async () => {
        const connectionsStore = useConnectionsStore();
        await connectionsStore.fetchConnections();
      })());
      refreshTasks.push((async () => {
        const { useFileColorHighlightsStore } = await import('./fileColorHighlights.store');
        const highlightsStore = useFileColorHighlightsStore();
        await highlightsStore.reloadLoadedHighlights();
      })());
    }
    if (has('connections.folders')) {
      refreshTasks.push((async () => {
        const { useFoldersStore } = await import('./folders.store');
        const foldersStore = useFoldersStore();
        await foldersStore.fetchFolders();
      })());
    }
    if (has('connections.keys')) {
      refreshTasks.push((async () => {
        const { useSshKeysStore } = await import('./sshKeys.store');
        const sshKeysStore = useSshKeysStore();
        await sshKeysStore.fetchSshKeys();
      })());
    }
    if (has('connections.proxies')) {
      refreshTasks.push((async () => {
        const { useProxiesStore } = await import('./proxies.store');
        const proxiesStore = useProxiesStore();
        await proxiesStore.fetchProxies();
      })());
    }
    if (has('connections.favoritePaths')) {
      refreshTasks.push((async () => {
        const { useFavoritePathsStore } = await import('./favoritePaths.store');
        const favoritePathsStore = useFavoritePathsStore();
        await favoritePathsStore.fetchFavoritePaths((_k, d) => d);
      })());
    }

    if (has('quickCommands.items')) {
      refreshTasks.push((async () => {
        const { useQuickCommandsStore } = await import('./quickCommands.store');
        const qcStore = useQuickCommandsStore();
        await qcStore.fetchQuickCommands(true);
      })());
    }
    if (has('quickCommands.folders')) {
      refreshTasks.push((async () => {
        const { useQuickCommandFoldersStore } = await import('./quickCommandFolders.store');
        const qcFoldersStore = useQuickCommandFoldersStore();
        await qcFoldersStore.fetchFolders();
      })());
    }

    if (anyAppearance) {
      refreshTasks.push((async () => {
        const { useAppearanceStore } = await import('./appearance.store');
        const appearanceStore = useAppearanceStore();
        await appearanceStore.loadInitialAppearanceData();
      })());
    }

    if (anyLayout) {
      // 界面设置（主题模式、缩进等）走 settings store 的初始化，
      // 只勾了「布局预设」时不必重拉整份设置。
      if (has('layout.uiSettings')) {
        refreshTasks.push((async () => {
          const { useSettingsStore } = await import('./settings.store');
          const settingsStore = useSettingsStore();
          await settingsStore.loadInitialSettings();
        })());
      }
      // 组件实例级状态（文件管理器平铺/路径同步、快捷指令视图与文件夹布局、目录树开关…）
      // 存在 settings 的 componentInstanceStates 里，loadInitialSettings 不会重建它。
      // 以前漏了这一块，所以另一台设备改了视图模式，这边必须整页刷新才看得到。
      if (has('layout.componentStates')) {
        refreshTasks.push((async () => {
          const { useComponentStateStore } = await import('./componentState.store');
          const componentStateStore = useComponentStateStore();
          await componentStateStore.reloadFromServer();
        })());
      }
      // 预设（含"指定连接"绑定）是独立的 settings 键，settings store 不会重建它，
      // 不显式重载的话，另一台设备新建的布局要刷新整页才出现。
      if (has('layout.presets')) {
        refreshTasks.push((async () => {
          const { useLayoutStore } = await import('./layout.store');
          const layoutStore = useLayoutStore();
          await layoutStore.reloadPresetsFromServer();
        })());
      }
      // 焦点切换顺序 + 各项 Alt+ 快捷键存在 settings.focusSwitcherSequence，
      // 数据本身会同步，但这个 store 只在实例化时拉一次自己的接口
      // （/settings/focus-switcher-sequence，不在 settings schema 里），
      // 不重载的话另一台改了顺序，这边按 Alt+Tab 还是老顺序，必须整页刷新。
      if (has('layout.focusSwitcher')) {
        refreshTasks.push((async () => {
          const { useFocusSwitcherStore } = await import('./focusSwitcher.store');
          const focusSwitcherStore = useFocusSwitcherStore();
          await focusSwitcherStore.loadConfigurationFromBackend();
        })());
      }
    }

    if (has('commandHistory.history')) {
      refreshTasks.push((async () => {
        const { useCommandHistoryStore } = await import('./commandHistory.store');
        const cmdHistStore = useCommandHistoryStore();
        await cmdHistStore.fetchHistory(true);
      })());
    }

    const results = await Promise.allSettled(refreshTasks);
    const rejected = results.filter(r => r.status === 'rejected');
    if (rejected.length > 0) {
      console.warn('[DesktopSyncStore] 部分模块 Store 刷新遇到警告:', rejected);
    } else {
      console.log('[DesktopSyncStore] 所有面板模块 Store 数据已全部完成最新重绘！');
    }
  };

  return {
    isDesktop,
    vpsUrl,
    apiKey,
    hasApiKey,
    apiKeyMasked,
    conflictStrategy,
    syncMode,
    setSyncMode,
    lastSyncTime,
    autoSyncOnOpen,
    selectedModules,
    setSelectedModules,
    isTesting,
    testLatency,
    testError,
    isSyncing,
    syncStats,
    syncError,
    syncSuccessMessage,
    isConfigured,
    isFirstSync,
    showFirstSyncModal,
    fetchConfig,
    saveConfig,
    testConnection,
    triggerSync,
    requestSync,
    refreshAllStores
  };
});
