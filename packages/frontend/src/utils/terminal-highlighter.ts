import type { TerminalHighlightGroup } from '../types/terminal-highlight.types';

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
 * 转义正则特殊字符
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 预编译后的匹配器单元 (Compiled Matcher)
 */
export interface CompiledMatcher {
  groupId: string;
  regex: RegExp;
  priority: number;
  prefix: string; // 注入的 ANSI 序列
  suffix: string; // 复原的 ANSI 序列
}

export type CompiledHighlightPipeline = CompiledMatcher[];

// 兼容别名导出
export type CompiledHighlightRule = CompiledMatcher;

/**
 * 构建分组对应的 ANSI 开头与结尾序列
 */
export function buildAnsiStyleTokens(group: Partial<TerminalHighlightGroup>): { prefix: string; suffix: string } {
  let prefix = '';
  let suffix = '';

  // 1. 前景色 (24-bit TrueColor)
  if (group.color) {
    const rgb = hexToRgb(group.color);
    if (rgb) {
      prefix += `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`;
      suffix += '\x1b[39m'; // 恢复默认前景色
    }
  }

  // 2. 背景色 (24-bit TrueColor)
  if (group.bgColor) {
    const bgRgb = hexToRgb(group.bgColor);
    if (bgRgb) {
      prefix += `\x1b[48;2;${bgRgb.r};${bgRgb.g};${bgRgb.b}m`;
      suffix += '\x1b[49m'; // 恢复默认背景色
    }
  }

  // 3. 加粗
  if (group.bold) {
    prefix += '\x1b[1m';
    suffix += '\x1b[22m'; // 关闭粗体
  }

  // 4. 下划线
  if (group.underline) {
    prefix += '\x1b[4m';
    suffix += '\x1b[24m'; // 关闭下划线
  }

  return { prefix, suffix };
}

/**
 * 预编译所有激活的语义分组为 Matcher 集合
 */
export function compileHighlightGroups(groups: TerminalHighlightGroup[]): CompiledMatcher[] {
  const matchers: CompiledMatcher[] = [];

  for (const group of groups) {
    if (!group.enabled) continue;

    const { prefix, suffix } = buildAnsiStyleTokens(group);
    if (!prefix) continue;

    const priority = group.priority || 2;
    const flags = group.flags && group.flags.includes('g') ? group.flags : `${group.flags || ''}g`;

    // 1. 关键词规则编译为词边界正则: \b(?:word1|word2)\b
    if (Array.isArray(group.keywords) && group.keywords.length > 0) {
      const validKeywords = group.keywords
        .map((k) => (typeof k === 'string' ? k.trim() : ''))
        .filter((k) => k.length > 0);

      if (validKeywords.length > 0) {
        // 按长度降序排，避免前缀误抢
        validKeywords.sort((a, b) => b.length - a.length);

        // 分类处理纯英文词与带特殊符号词
        const escaped = validKeywords.map((k) => {
          const esc = escapeRegExp(k);
          return /^\w+$/.test(k) ? `\\b${esc}\\b` : esc;
        });

        try {
          const kwRegex = new RegExp(`(?:${escaped.join('|')})`, flags);
          matchers.push({
            groupId: group.id,
            regex: kwRegex,
            priority,
            prefix,
            suffix,
          });
        } catch (e) {
          console.warn(`[Highlighter] 关键词组合正则编译失败 (${group.name}):`, e);
        }
      }
    }

    // 2. 正则表达式编译
    if (Array.isArray(group.patterns) && group.patterns.length > 0) {
      for (const pattern of group.patterns) {
        if (!pattern || typeof pattern !== 'string') continue;
        try {
          const pRegex = new RegExp(pattern, flags);
          matchers.push({
            groupId: group.id,
            regex: pRegex,
            priority,
            prefix,
            suffix,
          });
        } catch (e) {
          console.warn(`[Highlighter] 正则规则编译失败 (${group.name}: ${pattern}):`, e);
        }
      }
    }
  }

  return matchers;
}

// 兼容别名
export const compileHighlightRules = compileHighlightGroups as any;

/**
 * 匹配区间 (Span) 结构
 */
interface MatchSpan {
  start: number;
  end: number;
  length: number;
  priority: number;
  prefix: string;
  suffix: string;
}

/**
 * 对纯文本片段执行多 Matcher 扫描、Span 冲突仲裁与单次线性装配
 */
export function highlightPlainTextSegmentWithSpans(text: string, matchers: CompiledMatcher[]): string {
  if (!text || matchers.length === 0) return text;

  // 1. 并发扫描所有 Matcher 收集命中的候选 Spans
  const candidateSpans: MatchSpan[] = [];

  for (const matcher of matchers) {
    matcher.regex.lastIndex = 0;
    let match: RegExpExecArray | null;

    // 避免空匹配导致无限循环
    while ((match = matcher.regex.exec(text)) !== null) {
      const matchText = match[0];
      if (!matchText || matchText.length === 0) {
        matcher.regex.lastIndex++;
        continue;
      }

      candidateSpans.push({
        start: match.index,
        end: match.index + matchText.length,
        length: matchText.length,
        priority: matcher.priority,
        prefix: matcher.prefix,
        suffix: matcher.suffix,
      });

      // 未带 g 标记则跳出
      if (!matcher.regex.global) break;
    }
  }

  if (candidateSpans.length === 0) return text;

  // 2. 冲突仲裁与区间合并 (Interval Conflict Resolution)
  // 排序规则：优先比 priority (降序)，次要比 length (降序，越长越具体)，再次比 start (升序)
  candidateSpans.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (b.length !== a.length) return b.length - a.length;
    return a.start - b.start;
  });

  const acceptedSpans: MatchSpan[] = [];

  for (const candidate of candidateSpans) {
    // 检查是否与已采纳的更高优先级区间发生重叠
    const isOverlapping = acceptedSpans.some(
      (accepted) => candidate.start < accepted.end && candidate.end > accepted.start
    );

    if (!isOverlapping) {
      acceptedSpans.push(candidate);
    }
  }

  // 3. 将采纳的 Spans 按文本起始位置升序排序
  acceptedSpans.sort((a, b) => a.start - b.start);

  // 4. 单次遍历无损切片组装 (Single-pass Assembly)
  let result = '';
  let lastIndex = 0;

  for (const span of acceptedSpans) {
    if (span.start > lastIndex) {
      result += text.substring(lastIndex, span.start);
    }
    result += `${span.prefix}${text.substring(span.start, span.end)}${span.suffix}`;
    lastIndex = span.end;
  }

  if (lastIndex < text.length) {
    result += text.substring(lastIndex);
  }

  return result;
}

/**
 * ANSI 转义字符序列正则，涵盖标准 CSI、OSC 以及常见控制字符
 */
const ANSI_PATTERN = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/**
 * 对终端输出字符串进行 ANSI 保护并执行工业级区间高亮
 */
export function highlightTerminalString(input: string, matchers: CompiledMatcher[]): string {
  if (!input || matchers.length === 0) return input;
  if (input.length < 2) return input;

  ANSI_PATTERN.lastIndex = 0;
  if (!ANSI_PATTERN.test(input)) {
    // 纯文本无 ANSI 控制符，直接全量执行 Span 仲裁高亮
    return highlightPlainTextSegmentWithSpans(input, matchers);
  }

  // 包含已有 ANSI 序列：按 ANSI 控制码分割保护，仅对纯文本段执行高亮
  ANSI_PATTERN.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const segments: string[] = [];

  while ((match = ANSI_PATTERN.exec(input)) !== null) {
    const matchIndex = match.index;
    if (matchIndex > lastIndex) {
      const plainText = input.substring(lastIndex, matchIndex);
      segments.push(highlightPlainTextSegmentWithSpans(plainText, matchers));
    }
    // 原样保留原生 ANSI 序列
    segments.push(match[0]);
    lastIndex = ANSI_PATTERN.lastIndex;
  }

  if (lastIndex < input.length) {
    const plainText = input.substring(lastIndex);
    segments.push(highlightPlainTextSegmentWithSpans(plainText, matchers));
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

  const tokens = ansiText.split(/(\x1b\[[0-9;]*m|\x1b\[[0-9;?]*[a-zA-Z]|\r?\n)/g);

  for (const token of tokens) {
    if (!token) continue;

    if (token === '\n' || token === '\r\n') {
      html += '<br/>';
      continue;
    }

    if (token.startsWith('\x1b[') && token.endsWith('m')) {
      const codeStr = token.slice(2, -1);
      const codes = codeStr ? codeStr.split(';').map((c) => parseInt(c, 10)) : [0];

      let i = 0;
      while (i < codes.length) {
        const c = codes[i];
        if (c === 0) {
          while (openSpanCount > 0) {
            html += '</span>';
            openSpanCount--;
          }
        } else if (c === 1) {
          html += '<span style="font-weight: 700;">';
          openSpanCount++;
        } else if (c === 4) {
          html += '<span style="text-decoration: underline;">';
          openSpanCount++;
        } else if (c === 22) {
          if (openSpanCount > 0) {
            html += '</span>';
            openSpanCount--;
          }
        } else if (c === 24) {
          if (openSpanCount > 0) {
            html += '</span>';
            openSpanCount--;
          }
        } else if (c === 39) {
          if (openSpanCount > 0) {
            html += '</span>';
            openSpanCount--;
          }
        } else if (c === 49) {
          if (openSpanCount > 0) {
            html += '</span>';
            openSpanCount--;
          }
        } else if (c === 38 && codes[i + 1] === 2 && i + 4 < codes.length) {
          const r = codes[i + 2];
          const g = codes[i + 3];
          const b = codes[i + 4];
          html += `<span style="color: rgb(${r}, ${g}, ${b});">`;
          openSpanCount++;
          i += 4;
        } else if (c === 48 && codes[i + 1] === 2 && i + 4 < codes.length) {
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
      continue;
    } else {
      html += escapeHtml(token);
    }
  }

  while (openSpanCount > 0) {
    html += '</span>';
    openSpanCount--;
  }

  return html;
}
