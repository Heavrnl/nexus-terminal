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
 * 正则特殊字符转义
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 语义类型特异性权重表 (Semantic Specificity Weights)
 * 当两个规则发生重叠冲突时，用于确定谁更具有语义排他性
 */
export const SPECIFICITY_WEIGHTS: Record<string, number> = {
  url: 100,         // Web URL 结构最长且最具体
  date: 95,         // 日期时间具有明确结构
  ip: 85,           // IPv4 地址
  regex: 70,        // 自定义或内置正则模式
  keyword_whole: 60,// 全词关键词
  keyword_partial: 40, // 模糊包含关键词
};

/**
 * 预编译后的匹配器单元 (Compiled Matcher)
 */
export interface CompiledMatcher {
  groupId: string;
  regex: RegExp;
  priority: number;     // 用户指定的优先级 (1~3)
  specificity: number;  // 语义特异性 (40~100)
  prefix: string;       // 注入的 ANSI 序列
  suffix: string;       // 复原的 ANSI 序列
}

export type CompiledHighlightPipeline = CompiledMatcher[];
export type CompiledHighlightRule = CompiledMatcher;

/**
 * 构建分组对应的 ANSI 开头与结尾序列
 */
export function buildAnsiStyleTokens(group: Partial<TerminalHighlightGroup>): { prefix: string; suffix: string } {
  const prefixes: string[] = [];
  const suffixes: string[] = [];

  // 1. 前景色 (24-bit TrueColor)
  if (group.color) {
    const rgb = hexToRgb(group.color);
    if (rgb) {
      prefixes.push(`\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`);
      suffixes.unshift('\x1b[39m'); // 镜像对称至最后
    }
  }

  // 2. 背景色 (24-bit TrueColor)
  if (group.bgColor) {
    const bgRgb = hexToRgb(group.bgColor);
    if (bgRgb) {
      prefixes.push(`\x1b[48;2;${bgRgb.r};${bgRgb.g};${bgRgb.b}m`);
      suffixes.unshift('\x1b[49m'); // 恢复默认背景色
    }
  }

  // 3. 加粗
  if (group.bold) {
    prefixes.push('\x1b[1m');
    suffixes.unshift('\x1b[22m'); // 关闭粗体
  }

  // 4. 下划线
  if (group.underline) {
    prefixes.push('\x1b[4m');
    suffixes.unshift('\x1b[24m'); // 关闭下划线
  }

  return {
    prefix: prefixes.join(''),
    suffix: suffixes.join(''),
  };
}

/**
 * 内置语义分类默认模式库
 */
export function getBuiltinDefaultPatterns(type?: string): string[] {
  switch (type) {
    case 'date':
      return [
        '\\b\\d{4}-\\d{2}-\\d{2}[T\\s]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?\\b',
        '\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?\\b',
      ];
    case 'ip':
      return [
        '\\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?::\\d{1,5})?\\b',
      ];
    case 'url':
      return ['https?:\\/\\/[^\\s/$.?#].[^\\s]*'];
    case 'error':
      return ['\\bexit code [1-9]\\d*\\b', '\\bcontainer .*? exited\\b'];
    default:
      return [];
  }
}

/**
 * 预编译分组列表为 Matcher 集合 (全面支持 matchers 列表多规则混配)
 */
export function compileHighlightGroups(groups: TerminalHighlightGroup[]): CompiledMatcher[] {
  const matchers: CompiledMatcher[] = [];

  for (const group of groups) {
    if (!group.enabled) continue;

    const { prefix, suffix } = buildAnsiStyleTokens(group);
    if (!prefix) continue;

    const priority = group.priority || 2;
    const flags = group.flags && group.flags.includes('g') ? group.flags : `${group.flags || ''}g`;

    // 1. 编译 matchers 列表中的每一项规则 (支持任意数量、任意类型)
    if (Array.isArray(group.matchers) && group.matchers.length > 0) {
      for (const item of group.matchers) {
        if (item.type === 'keyword' && item.keyword) {
          const kw = item.keyword.trim();
          if (!kw) continue;
          const isWhole = item.wholeWord !== false;
          const isCase = !!item.caseSensitive;
          const kwFlags = isCase ? flags.replace(/i/g, '') : (flags.includes('i') ? flags : `${flags}i`);
          const esc = escapeRegExp(kw);
          const pat = isWhole ? `(?<![a-zA-Z0-9_-])(?:${esc})(?![a-zA-Z0-9_-])` : `(?:${esc})`;
          try {
            matchers.push({
              groupId: group.id,
              regex: new RegExp(pat, kwFlags),
              priority,
              specificity: isWhole ? SPECIFICITY_WEIGHTS.keyword_whole : SPECIFICITY_WEIGHTS.keyword_partial,
              prefix,
              suffix,
            });
          } catch (e) {
            console.warn(`[Highlighter] 关键词匹配项编译失败 (${group.name}: ${kw}):`, e);
          }
        } else if (item.type === 'regex' && item.pattern) {
          try {
            matchers.push({
              groupId: group.id,
              regex: new RegExp(item.pattern, flags),
              priority,
              specificity: SPECIFICITY_WEIGHTS.regex,
              prefix,
              suffix,
            });
          } catch (e) {
            console.warn(`[Highlighter] 正则匹配项编译失败 (${group.name}: ${item.pattern}):`, e);
          }
        } else if (item.type === 'builtin' && item.builtinType) {
          const patterns = getBuiltinDefaultPatterns(item.builtinType);
          const spec = SPECIFICITY_WEIGHTS[item.builtinType] || SPECIFICITY_WEIGHTS.regex;
          for (const p of patterns) {
            try {
              matchers.push({
                groupId: group.id,
                regex: new RegExp(p, flags),
                priority,
                specificity: spec,
                prefix,
                suffix,
              });
            } catch (e) {
              console.warn(`[Highlighter] 内置匹配项编译失败 (${group.name}: ${item.builtinType}):`, e);
            }
          }
        }
      }
    }

    // 2. 兼容顶层 keywords 列表
    if (Array.isArray(group.keywords) && group.keywords.length > 0) {
      // 避免与 matchers 重复编译
      const existingKw = new Set(
        (group.matchers || []).filter((m) => m.type === 'keyword' && m.keyword).map((m) => m.keyword!.toLowerCase())
      );
      const validKeywords = group.keywords
        .map((k) => (typeof k === 'string' ? k.trim() : ''))
        .filter((k) => k.length > 0 && !existingKw.has(k.toLowerCase()));

      if (validKeywords.length > 0) {
        validKeywords.sort((a, b) => b.length - a.length);
        const isWhole = group.keywordWholeWord !== false;
        const isCase = !!group.keywordCaseSensitive;
        const kwFlags = isCase ? flags.replace(/i/g, '') : (flags.includes('i') ? flags : `${flags}i`);
        const escapedList = validKeywords.map((k) => escapeRegExp(k));
        const patternBody = escapedList.join('|');
        const fullPattern = isWhole ? `(?<![a-zA-Z0-9_-])(?:${patternBody})(?![a-zA-Z0-9_-])` : `(?:${patternBody})`;
        try {
          matchers.push({
            groupId: group.id,
            regex: new RegExp(fullPattern, kwFlags),
            priority,
            specificity: isWhole ? SPECIFICITY_WEIGHTS.keyword_whole : SPECIFICITY_WEIGHTS.keyword_partial,
            prefix,
            suffix,
          });
        } catch (e) {
          console.warn(`[Highlighter] 关键词组编译失败 (${group.name}):`, e);
        }
      }
    }

    // 3. 兼容顶层 patterns 列表
    if (Array.isArray(group.patterns) && group.patterns.length > 0) {
      const existingPatterns = new Set(
        (group.matchers || []).filter((m) => m.type === 'regex' && m.pattern).map((m) => m.pattern!)
      );
      for (const pattern of group.patterns) {
        if (!pattern || typeof pattern !== 'string' || existingPatterns.has(pattern)) continue;
        try {
          matchers.push({
            groupId: group.id,
            regex: new RegExp(pattern, flags),
            priority,
            specificity: SPECIFICITY_WEIGHTS.regex,
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

export const compileHighlightRules = compileHighlightGroups as any;

/**
 * 匹配区间 (Span) 结构
 */
export interface MatchSpan {
  start: number;
  end: number;
  length: number;
  priority: number;
  specificity: number;
  prefix: string;
  suffix: string;
}

/**
 * 对纯文本片段执行多 Matcher 扫描、Span 冲突仲裁与单次切片装配
 */
export function highlightPlainTextSegmentWithSpans(text: string, matchers: CompiledMatcher[]): string {
  if (!text || matchers.length === 0) return text;

  // 1. 多 Matcher 扫描收集命中的候选 Spans
  const candidateSpans: MatchSpan[] = [];

  for (const matcher of matchers) {
    matcher.regex.lastIndex = 0;
    let match: RegExpExecArray | null;

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
        specificity: matcher.specificity,
        prefix: matcher.prefix,
        suffix: matcher.suffix,
      });

      if (!matcher.regex.global) break;
    }
  }

  if (candidateSpans.length === 0) return text;

  // 2. 冲突仲裁排序：
  // 综合排序策略：priority (用户权重) -> specificity (语义特异性) -> length (长匹配优先) -> start (先出现优先)
  candidateSpans.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (b.specificity !== a.specificity) return b.specificity - a.specificity;
    if (b.length !== a.length) return b.length - a.length;
    return a.start - b.start;
  });

  const acceptedSpans: MatchSpan[] = [];

  for (const candidate of candidateSpans) {
    // 检查是否与已采纳的更高优先/更具特异性的区间发生重叠
    const isOverlapping = acceptedSpans.some(
      (accepted) => candidate.start < accepted.end && candidate.end > accepted.start
    );

    if (!isOverlapping) {
      acceptedSpans.push(candidate);
    }
  }

  // 3. 将最终采纳的 Spans 按文本起始位置升序排列
  acceptedSpans.sort((a, b) => a.start - b.start);

  // 4. 单次线性无损切片组装 (Single-pass Assembly)
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
 * 对终端输出字符串进行 ANSI 保护并执行 Span 仲裁语法着色
 */
export function highlightTerminalString(input: string, matchers: CompiledMatcher[]): string {
  if (!input || matchers.length === 0) return input;
  if (input.length < 2) return input;

  ANSI_PATTERN.lastIndex = 0;
  if (!ANSI_PATTERN.test(input)) {
    // 纯文本无 ANSI 控制符，直接全量执行 Span 仲裁高亮
    return highlightPlainTextSegmentWithSpans(input, matchers);
  }

  // 包含已有 ANSI 序列：按控制码分割保护，仅对纯文本段执行高亮，原生控制序列 100% 原样保留
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
