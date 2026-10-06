/**
 * 文件类型与媒体格式常量及辅助工具函数
 */

export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'bmp',
  'ico',
  'avif',
]);

/**
 * 获取文件小写扩展名（不含点）
 */
export function getFileExtension(filePath?: string | null): string {
  if (!filePath) return '';
  const cleanPath = filePath.split('?')[0].split('#')[0];
  const lastDotIndex = cleanPath.lastIndexOf('.');
  if (lastDotIndex === -1) return '';
  return cleanPath.slice(lastDotIndex + 1).toLowerCase();
}

/**
 * 判断指定文件路径是否属于支持的图片格式
 */
export function isImageFilePath(filePath?: string | null): boolean {
  const ext = getFileExtension(filePath);
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * 根据文件路径或扩展名获取标准的 Image MIME 类型
 */
export function getImageMimeType(filePath?: string | null): string {
  const ext = getFileExtension(filePath);
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    case 'ico':
      return 'image/x-icon';
    case 'avif':
      return 'image/avif';
    default:
      return 'image/png';
  }
}

/**
 * 人类可读的文件大小格式化工具
 */
export function formatFileSize(bytes?: number | null): string {
  if (bytes === undefined || bytes === null || isNaN(bytes) || bytes < 0) {
    return '0 B';
  }
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const unitIndex = Math.min(i, units.length - 1);
  const size = bytes / Math.pow(k, unitIndex);
  return `${size >= 100 || unitIndex === 0 ? Math.round(size) : size.toFixed(1)} ${units[unitIndex]}`;
}
