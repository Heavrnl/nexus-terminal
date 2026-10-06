import type { ITheme } from 'xterm';

// 定义所有可用面板的名称 (后端独立定义)
export type PaneName = 'connections' | 'terminal' | 'commandBar' | 'fileManager' | 'editor' | 'statusMonitor' | 'commandHistory' | 'quickCommands' | 'dockerManager';

/**
 * 外观设置数据结构
 */
export interface AppearanceSettings {
  _id?: string; // 通常只有一个文档，ID 固定或不使用
  userId?: string; // 如果需要区分用户设置 (当前假设为全局)
  customUiTheme?: string; // UI 主题 (CSS 变量 JSON 字符串)
  activeTerminalThemeId?: number | null; // 修改为数字 ID 或 null
  terminalFontFamily?: string; // 终端字体列表字符串
  terminalFontFamilyMobile?: string; // 移动端终端字体列表字符串
  terminalFontSize?: number; // 终端字体大小 (px)
  terminalFontSizeMobile?: number; // 移动端终端字体大小 (px)
  terminalBackgroundImage?: string; // 终端背景图片 URL 或路径
  pageBackgroundImage?: string; // 页面背景图片 URL 或路径
  editorFontSize?: number; // 编辑器字体大小 (px)
  editorFontFamily?: string | null; // Monaco Editor 字体偏好
  mobileEditorFontSize?: number; // 移动端 Monaco 编辑器字体大小 (px)
  terminalBackgroundEnabled?: boolean; // 终端背景是否启用
  terminalBackgroundOverlayOpacity?: number; // 终端背景蒙版透明度 (0-1)
  terminal_custom_html?: string; // 用户自定义终端背景 HTML
  remoteHtmlPresetsUrl?: string | null; // 远程 HTML 预设仓库 URL
  terminalTextStrokeEnabled?: boolean;
  terminalTextStrokeWidth?: number;
  terminalTextStrokeColor?: string;
  terminalTextShadowEnabled?: boolean;
  terminalTextShadowOffsetX?: number;
  terminalTextShadowOffsetY?: number;
  terminalTextShadowBlur?: number;
  terminalTextShadowColor?: string;
  updatedAt?: number;
}
 
/**
 * 用于更新外观设置的数据结构 (所有字段可选)
 */
export type UpdateAppearanceDto = Partial<Omit<AppearanceSettings, '_id' | 'userId' | 'updatedAt'>>;
