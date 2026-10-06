/**
 * 终端代码与关键字高亮规则定义
 */
export interface TerminalHighlightRule {
  id: string;
  name: string;
  pattern: string; // 正则表达式源文本
  flags?: string; // 默认 'g'
  color: string; // 前景色 Hex (如 #22c55e)
  bgColor?: string; // 背景色 Hex (可选)
  bold?: boolean; // 是否加粗
  underline?: boolean; // 是否下划线
  enabled: boolean; // 是否启用该条规则
  isBuiltin?: boolean; // 是否为系统内置预设
  description?: string; // 规则说明
}

/**
 * 终端高亮全量配置结构
 */
export interface TerminalHighlightConfig {
  enabled: boolean;
  rules: TerminalHighlightRule[];
}

// 向后兼容类型别名与常量引用
export type TerminalKeywordHighlightRule = TerminalHighlightRule;
export { DEFAULT_HIGHLIGHT_RULES as DEFAULT_TERMINAL_HIGHLIGHT_RULES } from '../constants/terminal-highlight-presets';

