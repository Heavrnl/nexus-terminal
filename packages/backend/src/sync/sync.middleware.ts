// packages/backend/src/sync/sync.middleware.ts
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { settingsRepository } from '../settings/settings.repository';

/**
 * 恒定时间字符串比较，防止时序侧信道攻击
 */
export function safeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 生成服务端随机同步 API Key（32 字节高熵十六进制字符串）
 */
export function generateSyncApiKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * 获取服务端配置的有效 API Key
 * 完全基于数据库 settings 表持久化；首次初始化由服务端随机生成，严禁使用硬编码默认密钥
 */
export async function getServerSyncApiKey(): Promise<string> {
  try {
    const settingValue = await settingsRepository.getSetting('syncApiKey');
    if (settingValue && settingValue.trim() !== '') {
      return settingValue.trim();
    }
    // 数据库中尚未配置时，由服务端自动生成强随机密钥并持久化
    const generatedKey = generateSyncApiKey();
    await settingsRepository.setSetting('syncApiKey', generatedKey);
    return generatedKey;
  } catch (err: any) {
    console.warn('[SyncMiddleware] 读取或初始化 syncApiKey 失败:', err.message);
    return '';
  }
}

/**
 * 验证云端同步请求的 API Key 中间件
 */
export async function requireSyncApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const clientKey = (
    req.headers['x-api-key'] ||
    req.headers['x-device-token'] ||
    req.headers['x-sync-api-key'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '')
  ) as string | undefined;

  if (!clientKey || typeof clientKey !== 'string' || clientKey.trim() === '') {
    res.status(401).json({
      success: false,
      error: '缺少 API Key 认证凭据，请在请求头提供 X-API-Key'
    });
    return;
  }

  const serverKey = await getServerSyncApiKey();

  if (!serverKey) {
    res.status(403).json({
      success: false,
      error: '服务端尚未开启或配置同步 API 密钥 (未设置 SYNC_API_KEY)'
    });
    return;
  }

  if (!safeCompare(clientKey.trim(), serverKey)) {
    res.status(401).json({
      success: false,
      error: 'API Key 无效或不匹配，认证失败'
    });
    return;
  }

  next();
}
