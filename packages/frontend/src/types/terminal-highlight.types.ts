/**
 * Matcher 类型：内置语义分类 / 关键词 / 正则表达式
 */
export type MatcherItemType = 'builtin' | 'keyword' | 'regex';

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
 * 单个 Matcher 规则定义
 */
export interface HighlightMatcherItem {
  id: string;
  type: MatcherItemType;
  // 内置分类关联 (type === 'builtin')
  builtinType?: BuiltinMatcherType;
  // 关键词文本及词边界选项 (type === 'keyword')
  keyword?: string;
  wholeWord?: boolean; // 默认 true (全词匹配)
  caseSensitive?: boolean; // 默认 false (大小写敏感)
  // 正则表达式文本及标志 (type === 'regex')
  pattern?: string;
  flags?: string; // 默认 'g'
}

/**
 * 终端高亮语义分组卡片定义 (统一内置与自定义卡片的数据模型)
 * 一个分组下可添加任意数量、任意类型的 Matcher，所有 Matcher 共享该分组的样式与优先级
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

  // 核心：统一的 Matcher 规则条目列表 (可混合内置、关键词、正则表达式)
  matchers: HighlightMatcherItem[];

  // 兼容辅助字段
  matchType?: string;
  keywords?: string[];
  patterns?: string[];
  builtinType?: BuiltinMatcherType;
  keywordWholeWord?: boolean;
  keywordCaseSensitive?: boolean;
  flags?: string;
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
