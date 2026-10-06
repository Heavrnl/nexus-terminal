/**
 * 终端高亮匹配模式
 */
export type HighlightMatchType = 'builtin' | 'keywords' | 'regex';

/**
 * 内置语义分类 Matcher 类型
 */
export type BuiltinMatcherType =
  | 'date'
  | 'error'
  | 'warning'
  | 'success'
  | 'info'
  | 'ip'
  | 'url';

/**
 * 规则执行优先级 (数值越大越优先仲裁)
 * 3: 高 (如时间戳、URL)
 * 2: 普通 (如特定关键词、错误状态)
 * 1: 低 (常规词组)
 */
export type HighlightPriority = 1 | 2 | 3;

/**
 * 终端高亮语义分组卡片定义 (统一内置与自定义卡片的数据模型)
 */
export interface TerminalHighlightGroup {
  id: string;
  name: string;
  description?: string;
  isBuiltin: boolean;
  enabled: boolean;
  color: string;
  bgColor?: string;
  bold?: boolean;
  underline?: boolean;
  priority: HighlightPriority;
  matchType: HighlightMatchType;
  builtinType?: BuiltinMatcherType;
  keywords: string[]; // 关键词列表，如 ['container', 'docker', 'podman']
  patterns: string[]; // 正则表达式列表，如 ['exit code \\d+']
  flags?: string;     // 正则 flags，如 'g' 或 'gi'
}

/**
 * 终端高亮全局配置
 */
export interface TerminalHighlightConfig {
  enabled: boolean;
  groups: TerminalHighlightGroup[];
  rules?: any[]; // 兼容旧版配置迁移
}

// 向后兼容类型别名与导出
export type TerminalHighlightRule = TerminalHighlightGroup;
export type TerminalKeywordHighlightRule = TerminalHighlightGroup;
export { DEFAULT_HIGHLIGHT_GROUPS as DEFAULT_HIGHLIGHT_RULES } from '../constants/terminal-highlight-presets';
export { DEFAULT_HIGHLIGHT_GROUPS as DEFAULT_TERMINAL_HIGHLIGHT_RULES } from '../constants/terminal-highlight-presets';
