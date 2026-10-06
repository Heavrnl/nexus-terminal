export interface TerminalKeywordHighlightRule {
  id: string;
  name: string;
  pattern: string;
  isRegex: boolean;
  isCaseSensitive: boolean;
  color: string; // 前景十六进制颜色，如 #10b981
  bgColor?: string; // 背景十六进制颜色（可选），如 #1f2937 或空
  enabled: boolean;
  isPreset?: boolean; // 是否为内置预设
}

export const DEFAULT_TERMINAL_HIGHLIGHT_RULES: TerminalKeywordHighlightRule[] = [
  {
    id: 'preset-status-success',
    name: '运行与成功状态 (UP / OK / SUCCESS)',
    pattern: '\\b(UP|RUNNING|OK|SUCCESS|ACTIVE|ONLINE|HEALTHY|TRUE)\\b',
    isRegex: true,
    isCaseSensitive: false,
    color: '#10b981', // 亮绿色
    bgColor: '',
    enabled: true,
    isPreset: true,
  },
  {
    id: 'preset-status-error',
    name: '异常与退出状态 (ERROR / FAIL / EXITED)',
    pattern: '\\b(ERROR|FAIL|FAILED|FATAL|EXCEPTION|CRITICAL|DOWN|EXITED|STOPPED|FALSE)\\b',
    isRegex: true,
    isCaseSensitive: false,
    color: '#ef4444', // 醒目红
    bgColor: '',
    enabled: true,
    isPreset: true,
  },
  {
    id: 'preset-status-warn',
    name: '警告与重试 (WARN / PENDING / TIMEOUT)',
    pattern: '\\b(WARN|WARNING|TIMEOUT|PENDING|WAITING|RETRY|DEPRECATED)\\b',
    isRegex: true,
    isCaseSensitive: false,
    color: '#f59e0b', // 橙黄色
    bgColor: '',
    enabled: true,
    isPreset: true,
  },
  {
    id: 'preset-net-ip',
    name: 'IPv4 地址识别',
    pattern: '\\b(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\b',
    isRegex: true,
    isCaseSensitive: false,
    color: '#06b6d4', // 青色
    bgColor: '',
    enabled: true,
    isPreset: true,
  },
  {
    id: 'preset-net-ports',
    name: '端口与协议映射 (如 80->80/tcp)',
    pattern: '\\b(?:\\d+->)?\\d+\\/(?:tcp|udp)\\b',
    isRegex: true,
    isCaseSensitive: false,
    color: '#a855f7', // 紫色
    bgColor: '',
    enabled: true,
    isPreset: true,
  },
  {
    id: 'preset-log-info',
    name: '常规调试日志等级 (INFO / DEBUG)',
    pattern: '\\b(INFO|DEBUG|NOTICE)\\b',
    isRegex: true,
    isCaseSensitive: false,
    color: '#38bdf8', // 浅蓝天蓝
    bgColor: '',
    enabled: false, // 默认不干扰大篇幅日志，用户可自行勾选
    isPreset: true,
  }
];
