import type { TerminalHighlightRule } from '../types/terminal-highlight.types';

/**
 * 十六进制颜色转 RGB
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const cleanHex = hex.replace('#', '').trim();
  if (cleanHex.length === 3) {
    const r = parseInt(cleanHex[0] + cleanHex[0], 16);
    const g = parseInt(cleanHex[1] + cleanHex[1], 16);
    const b = parseInt(cleanHex[2] + cleanHex[2], 16);
    return isNaN(r) || isNaN(g) || isNaN(b) ? null : { r, g, b };
  }
  if (cleanHex.length === 6) {
    const r = parseInt(cleanHex.substring(0, 2), 16);
    const g = parseInt(cleanHex.substring(2, 4), 16);
    const b = parseInt(cleanHex.substring(4, 6), 16);
    return isNaN(r) || isNaN(g) || isNaN(b) ? null : { r, g, b };
  }
  return null;
}

/**
 * 预编译后的高亮规则项
 */
export interface CompiledHighlightRule {
  id: string;
  regex: RegExp;
  prefix: string; // 注入的 ANSI 序列
  suffix: string; // 复原的 ANSI 序列
}

export type CompiledHighlightPipeline = CompiledHighlightRule[];

/**
 * 构建高亮规则对应的 ANSI 开头与结尾序列
 */
export function buildAnsiStyleTokens(rule: TerminalHighlightRule): { prefix: string; suffix: string } {
  let prefix = '';
  let suffix = '';

  // 1. 前景色 (24-bit TrueColor)
  if (rule.color) {
    const rgb = hexToRgb(rule.color);
    if (rgb) {
      prefix += `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`;
      suffix += '\x1b[39m'; // 恢复默认前景色
    }
  }

  // 2. 背景色 (24-bit TrueColor)
  if (rule.bgColor) {
    const bgRgb = hexToRgb(rule.bgColor);
    if (bgRgb) {
      prefix += `\x1b[48;2;${bgRgb.r};${bgRgb.g};${bgRgb.b}m`;
      suffix += '\x1b[49m'; // 恢复默认背景色
    }
  }

  // 3. 加粗
  if (rule.bold) {
    prefix += '\x1b[1m';
    suffix += '\x1b[22m'; // 关闭粗体
  }

  // 4. 下划线
  if (rule.underline) {
    prefix += '\x1b[4m';
    suffix += '\x1b[24m'; // 关闭下划线
  }

  return { prefix, suffix };
}

/**
 * 编译并缓存激活规则
 */
export function compileHighlightRules(rules: TerminalHighlightRule[]): CompiledHighlightRule[] {
  const compiled: CompiledHighlightRule[] = [];

  for (const rule of rules) {
    if (!rule.enabled || !rule.pattern) continue;

    try {
      const flags = rule.flags && rule.flags.includes('g') ? rule.flags : `${rule.flags || ''}g`;
      const regex = new RegExp(rule.pattern, flags);
      const { prefix, suffix } = buildAnsiStyleTokens(rule);

      if (prefix) {
        compiled.push({
          id: rule.id,
          regex,
          prefix,
          suffix,
        });
      }
    } catch (e) {
      console.warn(`[TerminalHighlighter] 忽略无效的高亮正则规则 "${rule.name}":`, e);
    }
  }

  return compiled;
}

/**
 * ANSI 转义字符序列正则，涵盖标准 CSI、OSC 以及常见控制字符
 */
const ANSI_PATTERN = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/**
 * 对纯文本片段安全应用高亮规则替换
 */
function highlightPlainTextSegment(text: string, rules: CompiledHighlightRule[]): string {
  if (!text || rules.length === 0) return text;

  let result = text;
  for (const rule of rules) {
    rule.regex.lastIndex = 0;
    result = result.replace(rule.regex, (match) => {
      // 若匹配文本包含控制符则原样保留
      if (!match || match.includes('\x1b')) return match;
      return `${rule.prefix}${match}${rule.suffix}`;
    });
  }
  return result;
}

/**
 * 对传入的终端输出进行 ANSI 保护并执行规则高亮
 * @param input 终端数据 (string)
 * @param rules 编译后的高亮规则数组
 */
export function highlightTerminalString(input: string, rules: CompiledHighlightRule[]): string {
  if (!input || rules.length === 0) return input;

  // 性能快速检查：如果完全不包含任何英文字母/数字或符号，直接跳过
  if (input.length < 2) return input;

  // 检查是否包含已有 ANSI 转义序列
  ANSI_PATTERN.lastIndex = 0;
  if (!ANSI_PATTERN.test(input)) {
    // 纯文本没有任何 ANSI 控制字符，直接全量安全高亮
    return highlightPlainTextSegment(input, rules);
  }

  // 包含 ANSI 控制序列：按 ANSI 转义码分割分段处理，保护所有控制符不受破坏
  ANSI_PATTERN.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const segments: string[] = [];

  while ((match = ANSI_PATTERN.exec(input)) !== null) {
    const matchIndex = match.index;
    if (matchIndex > lastIndex) {
      const plainText = input.substring(lastIndex, matchIndex);
      segments.push(highlightPlainTextSegment(plainText, rules));
    }
    // 原样保留 ANSI 序列
    segments.push(match[0]);
    lastIndex = ANSI_PATTERN.lastIndex;
  }

  if (lastIndex < input.length) {
    const plainText = input.substring(lastIndex);
    segments.push(highlightPlainTextSegment(plainText, rules));
  }

  return segments.join('');
}

/**
 * HTML 特殊字符转义
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * 将包含 ANSI 颜色序列的终端输出转换为安全 HTML 标记 (供预览组件实时渲染)
 */
export function ansiToHtml(ansiText: string): string {
  if (!ansiText) return '';

  let html = '';
  let openSpanCount = 0;

  // 正则匹配 ANSI 序列与常规文本
  const tokens = ansiText.split(/(\x1b\[[0-9;]*m|\x1b\[[0-9;?]*[a-zA-Z]|\r?\n)/g);

  for (const token of tokens) {
    if (!token) continue;

    if (token === '\n' || token === '\r\n') {
      html += '<br/>';
      continue;
    }

    // 处理颜色与样式 SGR 序列 (e.g. \x1b[38;2;R;G;Bm, \x1b[1m, \x1b[0m)
    if (token.startsWith('\x1b[') && token.endsWith('m')) {
      const codeStr = token.slice(2, -1);
      const codes = codeStr ? codeStr.split(';').map((c) => parseInt(c, 10)) : [0];

      let i = 0;
      while (i < codes.length) {
        const c = codes[i];
        if (c === 0) {
          // 重置所有
          while (openSpanCount > 0) {
            html += '</span>';
            openSpanCount--;
          }
        } else if (c === 1) {
          // 加粗
          html += '<span style="font-weight: 700;">';
          openSpanCount++;
        } else if (c === 4) {
          // 下划线
          html += '<span style="text-decoration: underline;">';
          openSpanCount++;
        } else if (c === 22) {
          // 取消加粗
          if (openSpanCount > 0) {
            html += '</span>';
            openSpanCount--;
          }
        } else if (c === 24) {
          // 取消下划线
          if (openSpanCount > 0) {
            html += '</span>';
            openSpanCount--;
          }
        } else if (c === 39) {
          // 恢复默认前景色
          if (openSpanCount > 0) {
            html += '</span>';
            openSpanCount--;
          }
        } else if (c === 49) {
          // 恢复默认背景色
          if (openSpanCount > 0) {
            html += '</span>';
            openSpanCount--;
          }
        } else if (c === 38 && codes[i + 1] === 2 && i + 4 < codes.length) {
          // 24位 TrueColor 前景: 38;2;R;G;B
          const r = codes[i + 2];
          const g = codes[i + 3];
          const b = codes[i + 4];
          html += `<span style="color: rgb(${r}, ${g}, ${b});">`;
          openSpanCount++;
          i += 4;
        } else if (c === 48 && codes[i + 1] === 2 && i + 4 < codes.length) {
          // 24位 TrueColor 背景: 48;2;R;G;B
          const r = codes[i + 2];
          const g = codes[i + 3];
          const b = codes[i + 4];
          html += `<span style="background-color: rgb(${r}, ${g}, ${b});">`;
          openSpanCount++;
          i += 4;
        }
        i++;
      }
    } else if (token.startsWith('\x1b')) {
      // 其它控制符忽略
      continue;
    } else {
      // 普通文本
      html += escapeHtml(token);
    }
  }

  while (openSpanCount > 0) {
    html += '</span>';
    openSpanCount--;
  }

  return html;
}

