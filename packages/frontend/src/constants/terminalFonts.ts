// packages/frontend/src/constants/terminalFonts.ts

/**
 * 终端字体预设选项接口
 */
export interface TerminalFontOption {
  id: string;
  name: string;
  value: string;
  category: 'recommended' | 'system' | 'cjk' | 'generic';
  categoryLabel: string;
  description: string;
}

/**
 * 终端字体分类列表
 */
export const TERMINAL_FONT_CATEGORIES = [
  { key: 'recommended', label: '⭐ 推荐现代编程字体' },
  { key: 'system', label: '🖥️ 操作系统经典内置' },
  { key: 'cjk', label: '🇨🇳 中英文混合推荐' },
  { key: 'generic', label: '🔤 通用等宽回退' },
] as const;

/**
 * 常用优质终端等宽字体全量预设
 */
export const TERMINAL_FONT_PRESETS: TerminalFontOption[] = [
  // --- 推荐现代编程字体 ---
  {
    id: 'jetbrains-mono',
    name: 'JetBrains Mono',
    value: "'JetBrains Mono', monospace",
    category: 'recommended',
    categoryLabel: '⭐ 推荐现代编程字体',
    description: 'JetBrains 官方开源编程字体，字形辨识度高，易读性强 (首选推荐)',
  },
  {
    id: 'fira-code',
    name: 'Fira Code',
    value: "'Fira Code', monospace",
    category: 'recommended',
    categoryLabel: '⭐ 推荐现代编程字体',
    description: '高人气编程等宽字体，支持精美连字特性 (Ligatures)',
  },
  {
    id: 'cascadia-code',
    name: 'Cascadia Code',
    value: "'Cascadia Code', monospace",
    category: 'recommended',
    categoryLabel: '⭐ 推荐现代编程字体',
    description: '微软现代编程字体，Windows Terminal 与 VS Code 官方默认',
  },
  {
    id: 'cascadia-mono',
    name: 'Cascadia Mono',
    value: "'Cascadia Mono', monospace",
    category: 'recommended',
    categoryLabel: '⭐ 推荐现代编程字体',
    description: '微软 Cascadia 字体无连字版本，标准整洁',
  },
  {
    id: 'source-code-pro',
    name: 'Source Code Pro',
    value: "'Source Code Pro', monospace",
    category: 'recommended',
    categoryLabel: '⭐ 推荐现代编程字体',
    description: 'Adobe 开源经典等宽字体，字形温和清晰',
  },
  {
    id: 'hack',
    name: 'Hack',
    value: "'Hack', monospace",
    category: 'recommended',
    categoryLabel: '⭐ 推荐现代编程字体',
    description: '专为代码显示打造的开源等宽字体，标点符号大而分明',
  },
  {
    id: 'inconsolata',
    name: 'Inconsolata',
    value: "'Inconsolata', monospace",
    category: 'recommended',
    categoryLabel: '⭐ 推荐现代编程字体',
    description: '紧凑美观的开源等宽字体，适合多窗口终端排版',
  },
  {
    id: 'victor-mono',
    name: 'Victor Mono',
    value: "'Victor Mono', monospace",
    category: 'recommended',
    categoryLabel: '⭐ 推荐现代编程字体',
    description: '现代等宽字体，特色手写风格斜体与连字',
  },

  // --- 操作系统经典内置 ---
  {
    id: 'consolas',
    name: 'Consolas',
    value: "Consolas, monospace",
    category: 'system',
    categoryLabel: '🖥️ 操作系统经典内置',
    description: 'Windows 经典内置等宽编程字体，高度清晰锐利',
  },
  {
    id: 'menlo',
    name: 'Menlo',
    value: "Menlo, monospace",
    category: 'system',
    categoryLabel: '🖥️ 操作系统经典内置',
    description: 'macOS 经典终端内置字体，结构均衡工整',
  },
  {
    id: 'monaco',
    name: 'Monaco',
    value: "Monaco, monospace",
    category: 'system',
    categoryLabel: '🖥️ 操作系统经典内置',
    description: 'macOS 传奇复古等宽字体，字形小巧紧凑',
  },
  {
    id: 'sf-mono',
    name: 'SF Mono',
    value: "'SF Mono', monospace",
    category: 'system',
    categoryLabel: '🖥️ 操作系统经典内置',
    description: 'Apple 官方 San Francisco 等宽字体 (macOS 10.15+ 内置)',
  },
  {
    id: 'dejavu-sans-mono',
    name: 'DejaVu Sans Mono',
    value: "'DejaVu Sans Mono', monospace",
    category: 'system',
    categoryLabel: '🖥️ 操作系统经典内置',
    description: 'Linux / Unix 发行版广泛预装的标准等宽字体',
  },
  {
    id: 'ubuntu-mono',
    name: 'Ubuntu Mono',
    value: "'Ubuntu Mono', monospace",
    category: 'system',
    categoryLabel: '🖥️ 操作系统经典内置',
    description: 'Ubuntu 官方等宽字体，圆润柔和，字符区分度极佳',
  },
  {
    id: 'lucida-console',
    name: 'Lucida Console',
    value: "'Lucida Console', monospace",
    category: 'system',
    categoryLabel: '🖥️ 操作系统经典内置',
    description: 'Windows 命令提示符传统内置经典字体',
  },
  {
    id: 'courier-new',
    name: 'Courier New',
    value: "'Courier New', monospace",
    category: 'system',
    categoryLabel: '🖥️ 操作系统经典内置',
    description: '跨平台老牌打字机风格等宽字体，全平台通用',
  },

  // --- 中英文混合推荐 ---
  {
    id: 'jetbrains-yahei',
    name: 'JetBrains Mono + 微软雅黑',
    value: "'JetBrains Mono', 'Microsoft YaHei', monospace",
    category: 'cjk',
    categoryLabel: '🇨🇳 中英文混合推荐',
    description: '英文优先使用 JetBrains Mono，中文回退至微软雅黑',
  },
  {
    id: 'cascadia-yahei',
    name: 'Cascadia Code + 微软雅黑',
    value: "'Cascadia Code', 'Microsoft YaHei', monospace",
    category: 'cjk',
    categoryLabel: '🇨🇳 中英文混合推荐',
    description: '英文使用 Cascadia Code，中文回退至微软雅黑',
  },
  {
    id: 'fira-pingfang',
    name: 'Fira Code + 苹方 (macOS)',
    value: "'Fira Code', 'PingFang SC', monospace",
    category: 'cjk',
    categoryLabel: '🇨🇳 中英文混合推荐',
    description: '英文使用 Fira Code，中文回退至 Apple 苹方',
  },
  {
    id: 'consolas-yahei',
    name: 'Consolas + 微软雅黑',
    value: "Consolas, 'Microsoft YaHei', monospace",
    category: 'cjk',
    categoryLabel: '🇨🇳 中英文混合推荐',
    description: '经典 Consolas 英文，配合微软雅黑中文',
  },

  // --- 通用等宽回退 ---
  {
    id: 'generic-monospace',
    name: '系统默认等宽 (monospace)',
    value: "monospace",
    category: 'generic',
    categoryLabel: '🔤 通用等宽回退',
    description: '使用当前操作系统与浏览器设置的全局默认等宽字体',
  },
];

/**
 * 快速常用推荐精选标签列表 (供快速药丸按钮点击)
 */
export const QUICK_FONT_PILLS: { name: string; value: string }[] = [
  { name: 'JetBrains Mono', value: "'JetBrains Mono', monospace" },
  { name: 'Fira Code', value: "'Fira Code', monospace" },
  { name: 'Cascadia Code', value: "'Cascadia Code', monospace" },
  { name: 'Consolas', value: "Consolas, monospace" },
  { name: 'Source Code Pro', value: "'Source Code Pro', monospace" },
  { name: 'Monaco', value: "Monaco, monospace" },
  { name: 'Ubuntu Mono', value: "'Ubuntu Mono', monospace" },
  { name: '系统默认', value: "monospace" },
];

/**
 * 清理并格式化字体名称 (去除首尾空格与包裹的引号)
 */
export function cleanFontName(fontFamily: string): string {
  if (!fontFamily) return '';
  return fontFamily
    .split(',')[0]
    .trim()
    .replace(/^["']|["']$/g, '');
}

/**
 * 检测当前浏览器环境中某个字体是否可用/已安装
 */
export function isFontAvailableInBrowser(fontName: string): boolean {
  if (typeof document === 'undefined' || !document.fonts || !document.fonts.check) {
    return true; // 环境不支持检测时默认当作可用
  }
  try {
    const clean = cleanFontName(fontName);
    if (!clean || clean.toLowerCase() === 'monospace') return true;
    return document.fonts.check(`16px "${clean}"`);
  } catch (e) {
    return true;
  }
}

/**
 * 判断当前配置值是否与某个预设相匹配
 */
export function findMatchingPreset(currentValue: string): TerminalFontOption | undefined {
  if (!currentValue) return undefined;
  const normalized = currentValue.trim().toLowerCase();
  
  // 1. 完全匹配 value
  const exact = TERMINAL_FONT_PRESETS.find(p => p.value.toLowerCase() === normalized);
  if (exact) return exact;

  // 2. 匹配主字体名
  const primaryName = cleanFontName(currentValue).toLowerCase();
  return TERMINAL_FONT_PRESETS.find(p => cleanFontName(p.value).toLowerCase() === primaryName || p.name.toLowerCase() === primaryName);
}
