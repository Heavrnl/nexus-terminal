/* eslint-disable */
// 此文件由 tools/gen-settings-schema.mjs 自动生成，请勿手动编辑。
// 唯一来源：packages/backend/src/settings/settings.schema.data.json
// 重新生成：npm run settings:gen

export interface SettingSchemaEntry {
  type: 'boolean' | 'string' | 'number' | 'json';
  default?: string;
  writable?: boolean;
  desc?: string;
}

/** 全部设置项定义（顺序与 schema 一致） */
export const SETTINGS_SCHEMA = {
  language: { type: 'string' },
  ipWhitelist: { type: 'string' },
  maxLoginAttempts: { type: 'string', default: '5' },
  loginBanDuration: { type: 'string', default: '300' },
  showPopupFileEditor: { type: 'boolean', default: 'true' },
  showPopupFileManager: { type: 'boolean', default: 'false' },
  shareFileEditorTabs: { type: 'boolean', default: 'true' },
  fileEditorLargeFileConfirm: { type: 'boolean', default: 'true' },
  ipWhitelistEnabled: { type: 'boolean', default: 'false' },
  ipBlacklistEnabled: { type: 'boolean', default: 'true' },
  autoCopyOnSelect: { type: 'boolean', default: 'false' },
  dockerStatusIntervalSeconds: { type: 'number', default: '2' },
  dockerDefaultExpand: { type: 'boolean', default: 'false' },
  statusMonitorIntervalSeconds: { type: 'number', default: '3' },
  connectionTestTimeoutSeconds: { type: 'number', default: '15' },
  showStatusMonitorIpAddress: { type: 'boolean', default: 'false' },
  workspaceSidebarPersistent: { type: 'boolean', default: 'false' },
  sidebarPaneWidths: { type: 'json' },
  fileManagerRowSizeMultiplier: { type: 'number', default: '1.0' },
  fileManagerColWidths: { type: 'json' },
  fileManagerShowDeleteConfirmation: { type: 'boolean', default: 'true' },
  fileManagerDoubleClickToOpen: { type: 'boolean', default: 'false' },
  fileManagerHighlightChanges: { type: 'boolean', default: 'true' },
  fileManagerSearchFixed: { type: 'boolean', default: 'false' },
  fileManagerShowHidden: { type: 'boolean', default: 'false' },
  quickCommandRowSizeMultiplier: { type: 'number', default: '1.0' },
  quickCommandsCompactMode: { type: 'boolean', default: 'false' },
  commandInputSyncTarget: { type: 'string', default: 'none' },
  timezone: { type: 'string', default: 'UTC' },
  dashboardSortBy: { type: 'string', default: 'last_connected_at' },
  dashboardSortOrder: { type: 'string', default: 'desc' },
  showConnectionFolders: { type: 'boolean', default: 'true' },
  showQuickCommandFolders: { type: 'boolean', default: 'true' },
  layoutLocked: { type: 'boolean', default: 'false' },
  terminalScrollbackLimit: { type: 'number', default: '5000' },
  terminalEnableRightClickPaste: { type: 'boolean', default: 'true' },
  terminalRightClickBehavior: { type: 'string' },
  terminalContextMenuItems: { type: 'json' },
  terminalNoWrap: { type: 'boolean', default: 'false' },
  terminalSwitchPaneShortcut: { type: 'string', default: 'Alt+`' },
  fileEditorModalWidth: { type: 'string' },
  fileEditorModalHeight: { type: 'string' },
  desktopFileOpenMode: { type: 'string', default: 'builtin' },
  markdownDefaultViewMode: { type: 'string', default: 'split' },
  markdownDefaultViewModeMobile: { type: 'string', default: 'preview' },
  rememberLastRoute: { type: 'boolean' },
  componentInstanceStates: { type: 'json' },
  oidcProviders: { type: 'json', writable: false },
} as const satisfies Record<string, SettingSchemaEntry>;

export type SettingKey = keyof typeof SETTINGS_SCHEMA;

/** 允许通过 PUT /api/v1/settings 写入的键 */
export const WRITABLE_SETTING_KEYS = [
  'language',
  'ipWhitelist',
  'maxLoginAttempts',
  'loginBanDuration',
  'showPopupFileEditor',
  'showPopupFileManager',
  'shareFileEditorTabs',
  'fileEditorLargeFileConfirm',
  'ipWhitelistEnabled',
  'ipBlacklistEnabled',
  'autoCopyOnSelect',
  'dockerStatusIntervalSeconds',
  'dockerDefaultExpand',
  'statusMonitorIntervalSeconds',
  'connectionTestTimeoutSeconds',
  'showStatusMonitorIpAddress',
  'workspaceSidebarPersistent',
  'sidebarPaneWidths',
  'fileManagerRowSizeMultiplier',
  'fileManagerColWidths',
  'fileManagerShowDeleteConfirmation',
  'fileManagerDoubleClickToOpen',
  'fileManagerHighlightChanges',
  'fileManagerSearchFixed',
  'fileManagerShowHidden',
  'quickCommandRowSizeMultiplier',
  'quickCommandsCompactMode',
  'commandInputSyncTarget',
  'timezone',
  'dashboardSortBy',
  'dashboardSortOrder',
  'showConnectionFolders',
  'showQuickCommandFolders',
  'layoutLocked',
  'terminalScrollbackLimit',
  'terminalEnableRightClickPaste',
  'terminalRightClickBehavior',
  'terminalContextMenuItems',
  'terminalNoWrap',
  'terminalSwitchPaneShortcut',
  'fileEditorModalWidth',
  'fileEditorModalHeight',
  'desktopFileOpenMode',
  'markdownDefaultViewMode',
  'markdownDefaultViewModeMobile',
  'rememberLastRoute',
  'componentInstanceStates',
] as const;

export type WritableSettingKey = (typeof WRITABLE_SETTING_KEYS)[number];

const WRITABLE_KEY_SET: ReadonlySet<string> = new Set(WRITABLE_SETTING_KEYS);

export function isWritableSettingKey(key: string): boolean {
  return WRITABLE_KEY_SET.has(key);
}

/** 带默认值的键 -> 默认值（字符串，与数据库存储一致） */
export const SETTING_DEFAULTS: Readonly<Record<string, string>> = {
  maxLoginAttempts:                   '5',
  loginBanDuration:                   '300',
  showPopupFileEditor:                'true',
  showPopupFileManager:               'false',
  shareFileEditorTabs:                'true',
  fileEditorLargeFileConfirm:         'true',
  ipWhitelistEnabled:                 'false',
  ipBlacklistEnabled:                 'true',
  autoCopyOnSelect:                   'false',
  dockerStatusIntervalSeconds:        '2',
  dockerDefaultExpand:                'false',
  statusMonitorIntervalSeconds:       '3',
  connectionTestTimeoutSeconds:       '15',
  showStatusMonitorIpAddress:         'false',
  workspaceSidebarPersistent:         'false',
  fileManagerRowSizeMultiplier:       '1.0',
  fileManagerShowDeleteConfirmation:  'true',
  fileManagerDoubleClickToOpen:       'false',
  fileManagerHighlightChanges:        'true',
  fileManagerSearchFixed:             'false',
  fileManagerShowHidden:              'false',
  quickCommandRowSizeMultiplier:      '1.0',
  quickCommandsCompactMode:           'false',
  commandInputSyncTarget:             'none',
  timezone:                           'UTC',
  dashboardSortBy:                    'last_connected_at',
  dashboardSortOrder:                 'desc',
  showConnectionFolders:              'true',
  showQuickCommandFolders:            'true',
  layoutLocked:                       'false',
  terminalScrollbackLimit:            '5000',
  terminalEnableRightClickPaste:      'true',
  terminalNoWrap:                     'false',
  terminalSwitchPaneShortcut:         'Alt+`',
  desktopFileOpenMode:                'builtin',
  markdownDefaultViewMode:            'split',
  markdownDefaultViewModeMobile:      'preview',
};
