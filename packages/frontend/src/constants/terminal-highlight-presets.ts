import type { TerminalHighlightRule } from '../types/terminal-highlight.types';

/**
 * 经典终端高亮预设规则列表 (借鉴 WindTerm / MobaXterm / GRC 等热门仓库的最佳实践)
 */
export const DEFAULT_HIGHLIGHT_RULES: TerminalHighlightRule[] = [
  {
    id: 'status_success',
    name: '运行状态 / 成功 (Up/Running/OK)',
    pattern: '\\b(Up|running|healthy|SUCCESS|OK|active|enabled|connect|connected|true|PASSED)\\b',
    flags: 'g',
    color: '#22c55e', // 明亮绿色
    bold: true,
    underline: false,
    enabled: true,
    isBuiltin: true,
    description: '匹配 Docker 容器正常运行、服务健康、成功或通过状态',
  },
  {
    id: 'status_error',
    name: '异常状态 / 失败 (Error/Exited/Fail)',
    pattern: '\\b(Exited|dead|unhealthy|stopped|shutdown|down|error|errors|failed|failure|invalid|deny|denied|inactive|disabled|refused|FATAL|CRITICAL|FAIL|false|FAILED)\\b',
    flags: 'gi',
    color: '#ef4444', // 鲜明红色
    bold: true,
    underline: false,
    enabled: true,
    isBuiltin: true,
    description: '匹配 Docker 容器退出、服务挂掉、错误与拒绝异常',
  },
  {
    id: 'status_warning',
    name: '警告状态 / 重试 (Warn/Degraded)',
    pattern: '\\b(WARN|WARNING|timeout|retry|pending|degraded|caution|ALERT)\\b',
    flags: 'gi',
    color: '#f59e0b', // 琥珀黄
    bold: true,
    underline: false,
    enabled: true,
    isBuiltin: true,
    description: '匹配警告日志、超时、重试或待处理状态',
  },
  {
    id: 'log_level_info',
    name: '日志级别 (Info/Debug/Trace)',
    pattern: '\\b(INFO|NOTICE|DEBUG|TRACE|VERBOSE)\\b',
    flags: 'g',
    color: '#06b6d4', // 青色
    bold: false,
    underline: false,
    enabled: true,
    isBuiltin: true,
    description: '匹配常规信息、通知及调试跟踪日志级别',
  },
  {
    id: 'network_ip_port',
    name: 'IPv4 地址与端口',
    pattern: '\\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?::\\d{1,5})?\\b',
    flags: 'g',
    color: '#c084fc', // 亮紫色
    bold: false,
    underline: false,
    enabled: true,
    isBuiltin: true,
    description: '匹配标准 IPv4 地址及可选的端口号 (如 192.168.1.1:8080)',
  },
  {
    id: 'web_url',
    name: 'HTTP / Web 链接',
    pattern: 'https?:\\/\\/[^\\s/$.?#].[^\\s]*',
    flags: 'g',
    color: '#38bdf8', // 天蓝色
    bold: false,
    underline: true,
    enabled: true,
    isBuiltin: true,
    description: '匹配 http:// 或 https:// 协议网址',
  },
  {
    id: 'timestamp_iso',
    name: '时间戳 (ISO / 日期时间)',
    pattern: '\\b\\d{4}-\\d{2}-\\d{2}[T\\s]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?\\b',
    flags: 'g',
    color: '#94a3b8', // 石板灰蓝
    bold: false,
    underline: false,
    enabled: true,
    isBuiltin: true,
    description: '匹配标准 ISO 8601 或服务器日志带时间戳格式',
  },
];
