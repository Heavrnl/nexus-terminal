// packages/backend/src/services/storage-path.service.ts
import path from 'path';
import fs from 'fs';

/**
 * 检测当前进程是否运行在 Docker 容器环境中
 */
export function isDockerEnvironment(): boolean {
  try {
    return (
      fs.existsSync('/.dockerenv') ||
      process.env.DOCKER_CONTAINER === 'true' ||
      (process.platform === 'linux' && fs.existsSync('/app/data'))
    );
  } catch {
    return false;
  }
}

function ensureDir(dirPath: string): string {
  if (!fs.existsSync(dirPath)) {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
    } catch (e: any) {
      console.warn(`[StoragePath] 创建数据目录失败: ${dirPath}, error: ${e.message}`);
    }
  }
  return dirPath;
}

/**
 * 获取全局统一的数据存储根目录 (data/)
 * 优先级规则（三重隔离设计）：
 * 1. 显式环境变量 NEXUS_DATA_DIR (如桌面端或 Docker 指定)
 * 2. 容器环境自动识别：若是 Docker 容器，强制锁定 /app/data 挂载卷
 * 3. 桌面端/便携模式：当前程序/工作目录同级的 data 目录 (process.cwd()/data)
 * 4. 源码开发默认路径：回退至 backend/data
 */
export function getDataDir(): string {
  // 1. 显式环境变量具有最高优先级
  if (process.env.NEXUS_DATA_DIR && process.env.NEXUS_DATA_DIR.trim()) {
    return ensureDir(path.resolve(process.env.NEXUS_DATA_DIR.trim()));
  }

  // 2. Docker 容器环境严格隔离：默认绑定容器挂载卷 /app/data
  if (isDockerEnvironment()) {
    return ensureDir('/app/data');
  }

  // 3. 便携桌面端：检查当前工作目录同级是否已有 data 目录
  const cwdData = path.resolve(process.cwd(), 'data');
  if (fs.existsSync(cwdData)) {
    return ensureDir(cwdData);
  }

  // 4. 默认本地开发回退：源码目录下的 data
  return ensureDir(path.resolve(__dirname, '../../data'));
}

/**
 * 获取 SQLite 数据库文件绝对路径
 */
export function getDbPath(): string {
  return path.join(getDataDir(), 'nexus-terminal.db');
}

/**
 * 获取用户 Session 会话持久化存储目录
 */
export function getSessionsDir(): string {
  const dir = path.join(getDataDir(), 'sessions');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * 获取数据密钥环境变量文件绝对路径 (.env)
 */
export function getDataEnvPath(): string {
  return path.join(getDataDir(), '.env');
}

/**
 * 获取临时上传文件存储目录 (temp-uploads/)
 */
export function getTempUploadsDir(): string {
  const dir = path.join(getDataDir(), 'temp-uploads');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * 获取数据子目录或文件绝对路径
 */
export function getDataPath(subPath: string): string {
  return path.join(getDataDir(), subPath);
}

/**
 * 获取服务运行日志存储目录 (data/logs)
 */
export function getLogsDir(): string {
  const dir = path.join(getDataDir(), 'logs');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * 获取用户自定义 HTML 背景主题目录 (data/custom_html_theme)
 */
export function getCustomHtmlThemesDir(): string {
  const dir = path.join(getDataDir(), 'custom_html_theme');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

