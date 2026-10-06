import type { TerminalHighlightGroup } from '../types/terminal-highlight.types';

/**
 * 经典终端高亮语义分组预设列表
 * 每个 Group 内部都是一套 matchers 列表，支持混配内置规则、多个关键词和多个正则表达式
 */
export const DEFAULT_HIGHLIGHT_GROUPS: TerminalHighlightGroup[] = [
  {
    id: 'group_date',
    name: '时间戳 (Date & Time)',
    description: '自动识别标准 ISO8601、点号/逗号毫秒、带时区偏移以及 Syslog 传统格式日志时间',
    isBuiltin: true,
    enabled: true,
    color: '#94a3b8', // 石板灰蓝
    bold: false,
    underline: false,
    priority: 3,
    matchers: [
      {
        id: 'date_iso',
        type: 'builtin',
        builtinType: 'date',
        pattern: '\\b\\d{4}-\\d{2}-\\d{2}[T\\s]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?\\b',
      },
      {
        id: 'date_syslog',
        type: 'builtin',
        builtinType: 'date',
        pattern: '\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?\\b',
      },
    ],
    keywords: [],
    patterns: [
      '\\b\\d{4}-\\d{2}-\\d{2}[T\\s]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?\\b',
      '\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?\\b',
    ],
  },
  {
    id: 'group_error',
    name: '错误与异常 (Error / Failure)',
    description: '匹配常见错误日志级别、服务挂掉、拒绝连接与非零退出码状态',
    isBuiltin: true,
    enabled: true,
    color: '#ef4444', // 鲜红
    bold: true,
    underline: false,
    priority: 2,
    matchers: [
      { id: 'err_builtin', type: 'builtin', builtinType: 'error' },
      { id: 'err_kw_1', type: 'keyword', keyword: 'ERROR', wholeWord: true, caseSensitive: false },
      { id: 'err_kw_2', type: 'keyword', keyword: 'FATAL', wholeWord: true, caseSensitive: false },
      { id: 'err_kw_3', type: 'keyword', keyword: 'CRITICAL', wholeWord: true, caseSensitive: false },
      { id: 'err_kw_4', type: 'keyword', keyword: 'FAIL', wholeWord: true, caseSensitive: false },
      { id: 'err_kw_5', type: 'keyword', keyword: 'FAILED', wholeWord: true, caseSensitive: false },
      { id: 'err_kw_6', type: 'keyword', keyword: 'Exited', wholeWord: true, caseSensitive: false },
      { id: 'err_kw_7', type: 'keyword', keyword: 'refused', wholeWord: true, caseSensitive: false },
      { id: 'err_kw_8', type: 'keyword', keyword: 'unhealthy', wholeWord: true, caseSensitive: false },
      { id: 'err_regex_exitcode', type: 'regex', pattern: '\\bexit code [1-9]\\d*\\b' },
      { id: 'err_regex_container', type: 'regex', pattern: '\\bcontainer .*? exited\\b' },
    ],
    keywords: ['ERROR', 'FATAL', 'CRITICAL', 'FAIL', 'FAILED', 'Exited', 'refused', 'unhealthy'],
    patterns: ['\\bexit code [1-9]\\d*\\b', '\\bcontainer .*? exited\\b'],
    flags: 'gi',
  },
  {
    id: 'group_warning',
    name: '警告与告警 (Warning / Alert)',
    description: '匹配警告日志级别、超时、重试、性能降级与挂起状态',
    isBuiltin: true,
    enabled: true,
    color: '#f59e0b', // 琥珀黄
    bold: true,
    underline: false,
    priority: 2,
    matchers: [
      { id: 'warn_builtin', type: 'builtin', builtinType: 'warning' },
      { id: 'warn_kw_1', type: 'keyword', keyword: 'WARN', wholeWord: true, caseSensitive: false },
      { id: 'warn_kw_2', type: 'keyword', keyword: 'WARNING', wholeWord: true, caseSensitive: false },
      { id: 'warn_kw_3', type: 'keyword', keyword: 'ALERT', wholeWord: true, caseSensitive: false },
      { id: 'warn_kw_4', type: 'keyword', keyword: 'timeout', wholeWord: true, caseSensitive: false },
      { id: 'warn_kw_5', type: 'keyword', keyword: 'retry', wholeWord: true, caseSensitive: false },
      { id: 'warn_kw_6', type: 'keyword', keyword: 'pending', wholeWord: true, caseSensitive: false },
    ],
    keywords: ['WARN', 'WARNING', 'ALERT', 'timeout', 'retry', 'pending'],
    patterns: [],
    flags: 'gi',
  },
  {
    id: 'group_success',
    name: '成功与运行状态 (Success / Running)',
    description: '匹配 Docker 容器正常运行、服务健康、测试通过或连接成功状态',
    isBuiltin: true,
    enabled: true,
    color: '#22c55e', // 明亮绿
    bold: true,
    underline: false,
    priority: 2,
    matchers: [
      { id: 'succ_builtin', type: 'builtin', builtinType: 'success' },
      { id: 'succ_kw_1', type: 'keyword', keyword: 'Up', wholeWord: true, caseSensitive: false },
      { id: 'succ_kw_2', type: 'keyword', keyword: 'running', wholeWord: true, caseSensitive: false },
      { id: 'succ_kw_3', type: 'keyword', keyword: 'healthy', wholeWord: true, caseSensitive: false },
      { id: 'succ_kw_4', type: 'keyword', keyword: 'SUCCESS', wholeWord: true, caseSensitive: false },
      { id: 'succ_kw_5', type: 'keyword', keyword: 'OK', wholeWord: true, caseSensitive: false },
      { id: 'succ_kw_6', type: 'keyword', keyword: 'active', wholeWord: true, caseSensitive: false },
    ],
    keywords: ['Up', 'running', 'healthy', 'SUCCESS', 'OK', 'active'],
    patterns: [],
  },
  {
    id: 'group_info',
    name: '日志级别 (Info / Debug)',
    description: '匹配常规信息通知、调试以及链路追踪输出',
    isBuiltin: true,
    enabled: true,
    color: '#06b6d4', // 青色
    bold: false,
    underline: false,
    priority: 1,
    matchers: [
      { id: 'info_builtin', type: 'builtin', builtinType: 'info' },
      { id: 'info_kw_1', type: 'keyword', keyword: 'INFO', wholeWord: true, caseSensitive: false },
      { id: 'info_kw_2', type: 'keyword', keyword: 'NOTICE', wholeWord: true, caseSensitive: false },
      { id: 'info_kw_3', type: 'keyword', keyword: 'DEBUG', wholeWord: true, caseSensitive: false },
      { id: 'info_kw_4', type: 'keyword', keyword: 'TRACE', wholeWord: true, caseSensitive: false },
    ],
    keywords: ['INFO', 'NOTICE', 'DEBUG', 'TRACE'],
    patterns: [],
  },
  {
    id: 'group_ip',
    name: 'IP 地址与端口 (Network IP)',
    description: '匹配标准 IPv4 主机地址以及端口号 (如 192.168.1.1:8080)',
    isBuiltin: true,
    enabled: true,
    color: '#c084fc', // 亮紫色
    bold: false,
    underline: false,
    priority: 3,
    matchers: [
      {
        id: 'ip_builtin',
        type: 'builtin',
        builtinType: 'ip',
        pattern: '\\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?::\\d{1,5})?\\b',
      },
    ],
    keywords: [],
    patterns: [
      '\\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?::\\d{1,5})?\\b',
    ],
  },
  {
    id: 'group_url',
    name: 'Web 链接 (URLs)',
    description: '匹配标准 HTTP / HTTPS 网址协议与外部超链接',
    isBuiltin: true,
    enabled: true,
    color: '#38bdf8', // 天蓝色
    bold: false,
    underline: true,
    priority: 3,
    matchers: [
      {
        id: 'url_builtin',
        type: 'builtin',
        builtinType: 'url',
        pattern: 'https?:\\/\\/[^\\s/$.?#].[^\\s]*',
      },
    ],
    keywords: [],
    patterns: ['https?:\\/\\/[^\\s/$.?#].[^\\s]*'],
  },
];

// 向后兼容导出
export const DEFAULT_HIGHLIGHT_RULES = DEFAULT_HIGHLIGHT_GROUPS;
