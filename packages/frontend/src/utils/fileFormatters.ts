/**
 * 文件管理器通用格式化纯函数工具库
 */

/**
 * 格式化文件大小为可读字符串
 */
export function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * 格式化 Unix 文件权限模式为 rwxr-xr-x 形式
 */
export function formatFileMode(mode: number): string {
  const perm = mode & 0o777;
  let str = '';
  str += (perm & 0o400) ? 'r' : '-';
  str += (perm & 0o200) ? 'w' : '-';
  str += (perm & 0o100) ? 'x' : '-';
  str += (perm & 0o040) ? 'r' : '-';
  str += (perm & 0o020) ? 'w' : '-';
  str += (perm & 0o010) ? 'x' : '-';
  str += (perm & 0o004) ? 'r' : '-';
  str += (perm & 0o002) ? 'w' : '-';
  str += (perm & 0o001) ? 'x' : '-';
  return str;
}

// 简单的短周期时间格式化缓存，避免上千个文件渲染时重复 new Date() 和 toLocaleString()
const dateCache = new Map<number, string>();
const MAX_CACHE_SIZE = 1000;

/**
 * 格式化文件最后修改时间
 */
export function formatFileDate(mtime: number | string | Date): string {
  let timestamp: number;
  if (typeof mtime === 'number') {
    timestamp = mtime;
  } else if (mtime instanceof Date) {
    timestamp = mtime.getTime();
  } else {
    timestamp = new Date(mtime).getTime();
  }

  if (isNaN(timestamp)) return '';

  const cached = dateCache.get(timestamp);
  if (cached) return cached;

  const formatted = new Date(timestamp).toLocaleString();
  if (dateCache.size >= MAX_CACHE_SIZE) {
    dateCache.clear();
  }
  dateCache.set(timestamp, formatted);
  return formatted;
}
