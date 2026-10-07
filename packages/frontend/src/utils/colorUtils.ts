/**
 * 颜色处理与半透明背景辅助工具
 */

export const PRESET_COLORS = [
  '#3b82f6', // 经典蓝
  '#06b6d4', // 湖水青
  '#10b981', // 翡翠绿
  '#84cc16', // 青柠绿
  '#eab308', // 琥珀黄
  '#f97316', // 活力橙
  '#ef4444', // 珊瑚红
  '#ec4899', // 霓虹粉
  '#a855f7', // 罗兰紫
  '#6366f1', // 靛蓝
  '#14b8a6', // 松石绿
  '#64748b', // 蓝灰色
];

/**
 * 将十六进制颜色 (Hex) 转换为 RGBA 字符串
 * @param hex 十六进制颜色代码 (#RGB, #RRGGBB)
 * @param alpha 不透明度 (0 ~ 1)
 */
export function hexToRgba(hex: string, alpha: number = 1): string {
  if (!hex || typeof hex !== 'string') {
    return `rgba(59, 130, 246, ${alpha})`;
  }

  let cleanHex = hex.trim().replace('#', '');
  if (cleanHex.length === 3) {
    cleanHex = cleanHex
      .split('')
      .map(char => char + char)
      .join('');
  }

  if (cleanHex.length !== 6) {
    return `rgba(59, 130, 246, ${alpha})`;
  }

  const r = parseInt(cleanHex.substring(0, 2), 16);
  const g = parseInt(cleanHex.substring(2, 4), 16);
  const b = parseInt(cleanHex.substring(4, 6), 16);

  if (isNaN(r) || isNaN(g) || isNaN(b)) {
    return `rgba(59, 130, 246, ${alpha})`;
  }

  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 随机获取一个预设颜色
 */
export function getRandomPresetColor(excludeColor?: string): string {
  const available = excludeColor 
    ? PRESET_COLORS.filter(c => c.toLowerCase() !== excludeColor.toLowerCase())
    : PRESET_COLORS;
  const list = available.length > 0 ? available : PRESET_COLORS;
  const index = Math.floor(Math.random() * list.length);
  return list[index];
}

/**
 * 根据背景色生成连接项的内联样式对象
 * @param backgroundColor 自定义背景色 hex
 * @param isHighlighted 是否处于键盘高亮/选中状态
 */
export function getConnectionItemStyle(backgroundColor?: string | null, isHighlighted: boolean = false): Record<string, string> {
  if (!backgroundColor) {
    return {};
  }

  const bgAlpha = isHighlighted ? 0.28 : 0.12;
  const hoverBgAlpha = 0.22;
  const borderAlpha = 0.28;

  return {
    '--conn-custom-bg': hexToRgba(backgroundColor, bgAlpha),
    '--conn-custom-hover-bg': hexToRgba(backgroundColor, hoverBgAlpha),
    '--conn-custom-border': hexToRgba(backgroundColor, borderAlpha),
    backgroundColor: `var(--conn-custom-bg)`,
    borderColor: `var(--conn-custom-border)`,
  };
}
