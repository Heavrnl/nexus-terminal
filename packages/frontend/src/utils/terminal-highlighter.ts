import type { TerminalKeywordHighlightRule } from '../types/terminal-highlight.types';

// ANSI 转义序列切分正则 (兼容 VT100 / xterm 常用控制码)
const ANSI_SPLIT_REGEX = /(\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]))/g;

// 正则特殊字符转义工具
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 十六进制颜色转 RGB
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  if (!hex) return null;
  let cleanHex = hex.trim().replace(/^#/, '');
  if (cleanHex.length === 3) {
    cleanHex = cleanHex.split('').map(c => c + c).join('');
  }
  if (cleanHex.length !== 6) return null;
  const num = parseInt(cleanHex, 16);
  if (isNaN(num)) return null;
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255
  };
}

// 构建 ANSI 24-bit TrueColor 前景色代码
function getFgAnsi(hexColor: string): string {
  const rgb = hexToRgb(hexColor);
  if (!rgb) return '';
  return `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`;
}

// 构建 ANSI 24-bit TrueColor 背景色代码
function getBgAnsi(hexColor: string): string {
  const rgb = hexToRgb(hexColor);
  if (!rgb) return '';
  return `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m`;
}

export interface CompiledHighlightPipeline {
  combinedRegex: RegExp;
  activeRules: TerminalKeywordHighlightRule[];
}

/**
 * 将启用的规则列表编译为一个高效的单次匹配正则表达式管道
 */
export function compileHighlightRules(rules: TerminalKeywordHighlightRule[]): CompiledHighlightPipeline | null {
  if (!rules || rules.length === 0) return null;

  const validParts: string[] = [];
  const activeRules: TerminalKeywordHighlightRule[] = [];

  for (const rule of rules) {
    if (!rule.enabled || !rule.pattern?.trim()) continue;
    try {
      let subPattern = rule.pattern.trim();
      if (!rule.isRegex) {
        // 普通关键字模式，支持中英文逗号、空格或竖线分隔
        const tokens = subPattern.split(/[,，|\s]+/).map(t => t.trim()).filter(Boolean);
        if (tokens.length === 0) continue;
        subPattern = `\\b(?:${tokens.map(escapeRegex).join('|')})\\b`;
      }
      // 验证子模式合法性
      new RegExp(subPattern);
      validParts.push(`(${subPattern})`);
      activeRules.push(rule);
    } catch (err) {
      console.warn(`[TerminalHighlighter] 跳过语法错误的规则: ${rule.name}`, err);
    }
  }

  if (validParts.length === 0) return null;

  // 合并为单次扫描正则 (g 全局匹配，i 默认不区分大小写，针对单项可微调)
  const combinedRegex = new RegExp(validParts.join('|'), 'gi');
  return { combinedRegex, activeRules };
}

/**
 * 对终端文本段落应用关键字高亮着色
 */
export function applyTerminalHighlight(text: string, pipeline: CompiledHighlightPipeline | null): string {
  if (!text || !pipeline || pipeline.activeRules.length === 0) {
    return text;
  }

  const { combinedRegex, activeRules } = pipeline;

  // 将文本按 ANSI 转义控制字符安全切分，保护控制序列不被替换破坏
  const chunks = text.split(ANSI_SPLIT_REGEX);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;

    // 如果该片段本身是 ANSI 控制序列，原样保留跳过
    if (chunk.charCodeAt(0) === 0x1b) {
      continue;
    }

    // 重置正则状态
    combinedRegex.lastIndex = 0;

    // 单次扫描替换纯文本片段中的关键字
    chunks[i] = chunk.replace(combinedRegex, (match, ...args) => {
      // args 中前面 activeRules.length 项对应各个捕获组
      for (let ruleIndex = 0; ruleIndex < activeRules.length; ruleIndex++) {
        if (args[ruleIndex] !== undefined && args[ruleIndex] !== '') {
          const rule = activeRules[ruleIndex];
          const fgCode = getFgAnsi(rule.color);
          const bgCode = rule.bgColor ? getBgAnsi(rule.bgColor) : '';
          const resetBg = bgCode ? '\x1b[49m' : '';
          const resetFg = fgCode ? '\x1b[39m' : '';

          return `${fgCode}${bgCode}${match}${resetBg}${resetFg}`;
        }
      }
      return match;
    });
  }

  return chunks.join('');
}
