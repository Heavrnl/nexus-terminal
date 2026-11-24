/**
 * 双端同步的「细项」清单。
 *
 * 以前只有 5 个大模块（appearance / layout / commandHistory / quickCommands / connections），
 * 勾了就整块同步，用户没法只同步「终端主题」而不同步「背景图」。这里把每个大类拆成
 * 用户能理解的子项，前后端各持一份同样的 key（前端那份在 stores/desktopSync.store.ts），
 * 后端所有同步判定都必须走这个文件，别再出现「UI 里勾掉了但后端还是全推」。
 *
 * key 格式固定为 `<大类>.<子项>`，旧配置里的 5 个大类 key 由 resolveSyncItems 自动展开。
 */

export const SYNC_CATEGORY_KEYS = [
  'connections',
  'quickCommands',
  'appearance',
  'layout',
  'commandHistory',
] as const;

export type SyncCategoryKey = (typeof SYNC_CATEGORY_KEYS)[number];

export const SYNC_ITEM_KEYS = [
  // 连接与资产
  'connections.hosts',
  'connections.folders',
  'connections.keys',
  'connections.proxies',
  'connections.favoritePaths',
  // 快捷指令
  'quickCommands.items',
  'quickCommands.folders',
  // 外观样式
  'appearance.terminalTheme',
  'appearance.font',
  'appearance.background',
  'appearance.textEffect',
  'appearance.uiTheme',
  'appearance.highlight',
  'appearance.misc',
  // 工作区布局
  'layout.presets',
  'layout.componentStates',
  'layout.focusSwitcher',
  'layout.uiSettings',
  // 命令历史
  'commandHistory.history',
] as const;

export type SyncItemKey = (typeof SYNC_ITEM_KEYS)[number];

/** 大类 → 子项，前端渲染分组也按这个顺序 */
export const CATEGORY_ITEMS: Record<SyncCategoryKey, readonly SyncItemKey[]> = {
  connections: [
    'connections.hosts',
    'connections.folders',
    'connections.keys',
    'connections.proxies',
    'connections.favoritePaths',
  ],
  quickCommands: ['quickCommands.items', 'quickCommands.folders'],
  appearance: [
    'appearance.terminalTheme',
    'appearance.font',
    'appearance.background',
    'appearance.textEffect',
    'appearance.uiTheme',
    'appearance.highlight',
    'appearance.misc',
  ],
  layout: [
    'layout.presets',
    'layout.componentStates',
    'layout.focusSwitcher',
    'layout.uiSettings',
  ],
  commandHistory: ['commandHistory.history'],
};

const ALL_ITEMS: SyncItemKey[] = [...SYNC_ITEM_KEYS];

function isCategoryKey(value: string): value is SyncCategoryKey {
  return (SYNC_CATEGORY_KEYS as readonly string[]).includes(value);
}

function isItemKey(value: string): value is SyncItemKey {
  return (SYNC_ITEM_KEYS as readonly string[]).includes(value);
}

/**
 * 把请求里的字符串数组归一化成「启用的子项集合」。
 * - 不传 / 空数组 → 全开（历史行为：没指定就是全同步）
 * - 传旧的大类 key（appearance）→ 展开成该大类下所有子项
 * - 一个都识别不了 → 也按全开处理（前后端版本不一致时宁可多同步，也不要「同步完什么也没发生」）
 */
export function resolveSyncItems(input?: readonly string[] | null): Set<SyncItemKey> {
  if (!input || input.length === 0) return new Set(ALL_ITEMS);

  const enabled = new Set<SyncItemKey>();
  for (const raw of input) {
    if (!raw) continue;
    if (isCategoryKey(raw)) {
      for (const item of CATEGORY_ITEMS[raw]) enabled.add(item);
    } else if (isItemKey(raw)) {
      enabled.add(raw);
    }
  }
  return enabled.size > 0 ? enabled : new Set(ALL_ITEMS);
}

export function isItemEnabled(enabled: Set<SyncItemKey>, key: SyncItemKey): boolean {
  return enabled.has(key);
}

/** 表名 → 子项。v2 的 sync_changes 只有表名，没有业务语义 */
export const TABLE_SYNC_ITEM: Record<string, SyncItemKey> = {
  connections: 'connections.hosts',
  connection_folders: 'connections.hosts',
  port_forwards: 'connections.hosts',
  file_color_highlights: 'connections.hosts',
  remote_hosted_sessions: 'connections.hosts',
  folders: 'connections.folders',
  ssh_keys: 'connections.keys',
  proxies: 'connections.proxies',
  favorite_paths: 'connections.favoritePaths',
  quick_commands: 'quickCommands.items',
  quick_command_folders: 'quickCommands.folders',
  terminal_themes: 'appearance.terminalTheme',
  command_history: 'commandHistory.history',
};

/**
 * appearance_settings 是 key-value 表，要按 key 再分一次组。
 * 未登记的键统一落到 appearance.misc —— 以后新加外观设置不会被静默漏掉。
 */
export const APPEARANCE_KEY_ITEM: Record<string, SyncItemKey> = {
  activeTerminalThemeId: 'appearance.terminalTheme',

  terminalFontFamily: 'appearance.font',
  terminalFontFamilyMobile: 'appearance.font',
  terminalFontSize: 'appearance.font',
  terminalFontSizeMobile: 'appearance.font',
  editorFontFamily: 'appearance.font',
  editorFontSize: 'appearance.font',
  mobileEditorFontSize: 'appearance.font',

  terminalBackgroundEnabled: 'appearance.background',
  terminalBackgroundImage: 'appearance.background',
  terminalBackgroundOverlayOpacity: 'appearance.background',
  pageBackgroundImage: 'appearance.background',

  terminalTextShadowEnabled: 'appearance.textEffect',
  terminalTextShadowColor: 'appearance.textEffect',
  terminalTextShadowBlur: 'appearance.textEffect',
  terminalTextShadowOffsetX: 'appearance.textEffect',
  terminalTextShadowOffsetY: 'appearance.textEffect',
  terminalTextStrokeEnabled: 'appearance.textEffect',
  terminalTextStrokeColor: 'appearance.textEffect',
  terminalTextStrokeWidth: 'appearance.textEffect',

  customUiTheme: 'appearance.uiTheme',

  terminalHighlightEnabled: 'appearance.highlight',
  terminalHighlightRules: 'appearance.highlight',
};

/**
 * settings 表同样要按 key 分组：布局、组件状态、焦点切换顺序各自独立，
 * 剩下的界面设置归到 layout.uiSettings。
 */
export const SETTINGS_KEY_ITEM: Record<string, SyncItemKey> = {
  layoutPresets: 'layout.presets',
  componentInstanceStates: 'layout.componentStates',
  focusSwitcherSequence: 'layout.focusSwitcher',
};

export function itemForTable(table: string): SyncItemKey | undefined {
  return TABLE_SYNC_ITEM[table];
}

export function itemForAppearanceKey(key: string): SyncItemKey {
  return APPEARANCE_KEY_ITEM[key] || 'appearance.misc';
}

export function itemForSettingsKey(key: string): SyncItemKey {
  return SETTINGS_KEY_ITEM[key] || 'layout.uiSettings';
}

/** 某张表是否允许同步（appearance_settings / settings 要用下面的按 key 版本） */
export function isTableEnabled(enabled: Set<SyncItemKey>, table: string): boolean {
  if (table === 'appearance_settings' || table === 'settings') {
    // 这两张表是混合内容，调用方应该用 isAppearanceKeyEnabled / isSettingsKeyEnabled
    return true;
  }
  const item = itemForTable(table);
  return item ? enabled.has(item) : true;
}

export function isAppearanceKeyEnabled(enabled: Set<SyncItemKey>, key: string): boolean {
  return enabled.has(itemForAppearanceKey(key));
}

export function isSettingsKeyEnabled(enabled: Set<SyncItemKey>, key: string): boolean {
  return enabled.has(itemForSettingsKey(key));
}

/** 给日志用：把启用的子项压成一行 */
export function describeSyncItems(enabled: Set<SyncItemKey>): string {
  if (enabled.size >= ALL_ITEMS.length) return 'ALL';
  return ALL_ITEMS.filter(item => enabled.has(item)).join(', ') || 'NONE';
}
