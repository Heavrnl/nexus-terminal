import type { TerminalHighlightGroup } from '../types/terminal-highlight.types';

/**
 * 经典终端高亮语义分组预设列表 (内置语义分类卡片)
 * 每个分组都可以自由组合：内置分类、关键词列表与正则表达式
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
    priority: 3, // 高优先级锁定
    builtinType: 'date',
    keywords: [],
    keywordWholeWord: true,
    patterns: [
      // ISO 8601 及常见日期时间 (支持点号与逗号毫秒、Z 以及带或不带冒号的时区偏移)
      '\\b\\d{4}-\\d{2}-\\d{2}[T\\s]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?\\b',
      // Syslog 传统日期时间格式 (例如: Oct  6 19:36:39 或 Oct 16 19:36:39.123)
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
    builtinType: 'error',
    keywordWholeWord: true,
    keywordCaseSensitive: false,
    keywords: [
      'ERROR',
      'FATAL',
      'CRITICAL',
      'FAIL',
      'FAILED',
      'failure',
      'Exited',
      'dead',
      'unhealthy',
      'stopped',
      'down',
      'refused',
      'denied',
      'invalid',
      'inactive',
    ],
    patterns: [
      '\\bexit code [1-9]\\d*\\b',
      '\\bcontainer .*? exited\\b',
    ],
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
    builtinType: 'warning',
    keywordWholeWord: true,
    keywordCaseSensitive: false,
    keywords: ['WARN', 'WARNING', 'ALERT', 'caution', 'timeout', 'retry', 'pending', 'degraded'],
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
    builtinType: 'success',
    keywordWholeWord: true,
    keywordCaseSensitive: false,
    keywords: ['Up', 'running', 'healthy', 'SUCCESS', 'OK', 'active', 'enabled', 'connected', 'PASSED', 'true'],
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
    builtinType: 'info',
    keywordWholeWord: true,
    keywordCaseSensitive: false,
    keywords: ['INFO', 'NOTICE', 'DEBUG', 'TRACE', 'VERBOSE'],
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
    priority: 3, // 高优先级区间
    builtinType: 'ip',
    keywordWholeWord: true,
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
    priority: 3, // 高优先级区间
    builtinType: 'url',
    keywords: [],
    patterns: ['https?:\\/\\/[^\\s/$.?#].[^\\s]*'],
  },
];

// 向后兼容导出
export const DEFAULT_HIGHLIGHT_RULES = DEFAULT_HIGHLIGHT_GROUPS;
