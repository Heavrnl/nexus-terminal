// packages/frontend/src/types/appearance.types.ts

// 前端使用的外观设置结构 (对应 API 响应)
export interface AppearanceSettings {
  // 注意：前端可能不需要 _id, userId, updatedAt 等数据库相关的字段
  // 但为了与后端导入保持一致，暂时保留，后续可根据 API 精简
  customUiTheme?: string; // CSS 变量 JSON 字符串
  activeTerminalThemeId?: number | null; // 终端主题 ID
  terminalFontFamily?: string;
  terminalFontFamilyMobile?: string; // 移动端终端字体偏好
  terminalFontSize?: number;
  terminalFontSizeMobile?: number; // 移动端字体大小
  terminalBackgroundImage?: string;
  pageBackgroundImage?: string;
  editorFontSize?: number; // 桌面端编辑器字号
  mobileEditorFontSize?: number; // 移动端编辑器字号
  editorFontFamily?: string | null; // Monaco Editor 字体偏好
  terminalBackgroundEnabled?: boolean; // 终端背景是否启用
  terminalBackgroundOverlayOpacity?: number; // 终端背景蒙版透明度 (0-1)
  terminal_custom_html?: string | null; // 终端自定义 HTML
  remoteHtmlPresetsUrl?: string | null; // 远程 HTML 主题仓库链接

  // 文字描边
  terminalTextStrokeEnabled?: boolean;
  terminalTextStrokeWidth?: number;
  terminalTextStrokeColor?: string;

  // 文字阴影
  terminalTextShadowEnabled?: boolean;
  terminalTextShadowOffsetX?: number;
  terminalTextShadowOffsetY?: number;
  terminalTextShadowBlur?: number;
  terminalTextShadowColor?: string;
}
 
// 前端用于更新外观设置的数据结构 (对应 API 请求体)
// 使用 Partial<AppearanceSettings> 也可以，但明确定义更清晰
export type UpdateAppearanceDto = Partial<AppearanceSettings>;