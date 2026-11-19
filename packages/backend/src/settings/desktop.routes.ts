import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { getDataDir } from '../services/storage-path.service';
import { isAuthenticated } from '../auth/auth.middleware';
import { isDesktopRuntime, isLocalRequest } from '../auth/desktop-bootstrap';
import { syncService, type SyncModuleKey } from '../sync/sync.service';
import { syncV2Service } from '../sync/sync.v2.service';
import { syncThrottleScheduler } from '../sync/sync.scheduler';
import { syncWsClient } from '../sync/sync.ws-client';
import { resolveSyncItems } from '../sync/sync.items';
import {
  assertSafeSyncOutboundUrl,
  isSafeDesktopRoute,
  isSameOriginUrl,
  maskSecret,
} from '../sync/outbound-url';

import { settingsRepository } from './settings.repository';

const router = Router();

/**
 * 桌面端专属路由访问守卫：
 * 1. 所有接口必须先通过会话鉴权（isAuthenticated，未登录返回 401）；
 * 2. 生产 Web / Docker 部署（非桌面运行时）一律拒绝访问（403）；
 * 3. 必须来自本机回环 socket（使用不可伪造的 socket.remoteAddress，拒绝 X-Forwarded-For 伪造）。
 */
function requireLocalDesktopAccess(req: Request, res: Response, next: NextFunction): void {
  if (process.env.NODE_ENV === 'production' && !isDesktopRuntime()) {
    res.status(403).json({ success: false, error: '当前运行模式未启用桌面端接口' });
    return;
  }
  if (!isLocalRequest(req)) {
    res.status(403).json({ success: false, error: '仅允许本机桌面客户端访问该接口' });
    return;
  }
  next();
}

router.use(isAuthenticated);
router.use(requireLocalDesktopAccess);

export interface WindowState {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
}

export interface DesktopSettings {
  closeBehavior?: 'minimize_to_tray' | 'quit';
  rememberCloseChoice?: boolean;
  windowState?: WindowState;
  lastRoute?: string;
  syncMode?: 'bidirectional' | 'cloud_to_local' | 'local_to_cloud';
  [key: string]: any;
}

function getSettingsFilePath(): string {
  return path.join(getDataDir(), 'desktop-settings.json');
}

function readDesktopSettings(): DesktopSettings {
  const filePath = getSettingsFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn('[DesktopSettings] 读取 desktop-settings.json 失败:', err);
  }
  return {
    closeBehavior: 'minimize_to_tray',
    rememberCloseChoice: false,
  };
}

function writeDesktopSettings(settings: DesktopSettings): void {
  const filePath = getSettingsFilePath();
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8');
}

/**
 * 脱敏桌面端配置对象，防止 syncApiKey 明文通过 /settings 或 /sync/config 响应泄露
 */
function sanitizeDesktopSettings(settings: DesktopSettings): DesktopSettings {
  const { syncApiKey, ...rest } = settings;
  const hasApiKey = typeof syncApiKey === 'string' && syncApiKey.trim().length > 0;
  return {
    ...rest,
    hasSyncApiKey: hasApiKey,
    ...(hasApiKey ? { syncApiKeyMasked: maskSecret(syncApiKey) } : {}),
  };
}

/**
 * 构造脱敏后的云端同步配置响应体（永不返回明文 apiKey）
 */
function buildPublicSyncConfig(settings: DesktopSettings) {
  const rawKey = typeof settings.syncApiKey === 'string' ? settings.syncApiKey.trim() : '';
  return {
    vpsUrl: settings.syncVpsUrl || '',
    apiKey: maskSecret(rawKey),
    hasApiKey: rawKey.length > 0,
    conflictStrategy: settings.syncConflictStrategy || 'lww',
    syncMode: settings.syncMode || 'bidirectional',
    lastSyncTime: settings.syncLastTime || 0,
    autoSyncOnOpen: settings.syncAutoOnOpen ?? false,
  };
}

/**
 * 解析调用方传入的 apiKey（忽略空值和脱敏掩码回传），
 * 且在未传入新 apiKey 时仅允许同源目标复用已保存密钥，严禁把密钥发往其他主机。
 */
function resolveOutboundApiKey(
  providedApiKey: unknown,
  targetUrl: string,
  settings: DesktopSettings
): { apiKey: string; error?: string } {
  const savedKey = typeof settings.syncApiKey === 'string' ? settings.syncApiKey.trim() : '';
  const savedMask = maskSecret(savedKey);
  const rawProvided = typeof providedApiKey === 'string' ? providedApiKey.trim() : '';
  const isNewKeyProvided = rawProvided.length > 0 && rawProvided !== savedMask;

  if (isNewKeyProvided) {
    return { apiKey: rawProvided };
  }

  if (!savedKey) {
    return { apiKey: '', error: '请输入同步 API Key' };
  }

  if (!isSameOriginUrl(targetUrl, settings.syncVpsUrl)) {
    return { apiKey: '', error: '目标服务器地址已变更，请重新输入对应的同步 API Key' };
  }

  return { apiKey: savedKey };
}

/**
 * 获取桌面客户端配置
 */
router.get('/settings', (_req: Request, res: Response) => {
  const settings = readDesktopSettings();
  if (!settings.closeBehavior) {
    settings.closeBehavior = 'minimize_to_tray';
  }
  if (typeof settings.rememberCloseChoice !== 'boolean') {
    settings.rememberCloseChoice = false;
  }
  res.json(sanitizeDesktopSettings(settings));
});

/**
 * 更新桌面客户端配置
 */
router.put('/settings', (req: Request, res: Response): void => {
  const { closeBehavior, rememberCloseChoice, windowState, actionToExecute } = req.body || {};
  if (closeBehavior && !['minimize_to_tray', 'quit'].includes(closeBehavior)) {
    res.status(400).json({ error: '无效的 closeBehavior 参数，仅支持 minimize_to_tray 或 quit' });
    return;
  }
  if (actionToExecute !== undefined && !['minimize_to_tray', 'quit'].includes(actionToExecute)) {
    res.status(400).json({ error: '无效的 actionToExecute 参数，仅支持 minimize_to_tray 或 quit' });
    return;
  }

  const current = readDesktopSettings();
  const updated: DesktopSettings = {
    ...current,
    closeBehavior: closeBehavior !== undefined ? closeBehavior : (current.closeBehavior || 'minimize_to_tray'),
    rememberCloseChoice: typeof rememberCloseChoice === 'boolean' ? rememberCloseChoice : (current.rememberCloseChoice || false),
  };

  if (actionToExecute) {
    updated.actionToExecute = actionToExecute;
  }

  if (windowState && typeof windowState === 'object') {
    updated.windowState = {
      ...current.windowState,
      ...windowState,
    };
  }

  try {
    writeDesktopSettings(updated);
    res.json({ success: true, settings: sanitizeDesktopSettings(updated) });
  } catch (err: any) {
    console.error('[DesktopSettings] 保存 desktop-settings.json 失败:', err);
    res.status(500).json({ error: '保存配置失败' });
  }
});

/**
 * 记录用户当前停留的路由页面 (用于桌面端下次启动直达，传入空字符串或clear可清除)
 */
router.post('/route', (req: Request, res: Response): void => {
  const { route, clear, enabled } = req.body || {};
  const current = readDesktopSettings();
  if (typeof enabled === 'boolean') {
    current.rememberLastRoute = enabled;
  }
  if (clear || route === '' || route === null || enabled === false) {
    delete current.lastRoute;
    current.rememberLastRoute = false;
    try {
      writeDesktopSettings(current);
      console.log('🧹 [DesktopSettings] 已清空桌面端上次停留路由并标记关闭记忆');
    } catch (err) {
      console.warn('[DesktopSettings] 清空上次停留路由失败:', err);
    }
  } else if (route !== undefined) {
    if (!isSafeDesktopRoute(route)) {
      res.status(400).json({ success: false, error: '无效的站内路由路径' });
      return;
    }
    const trimmed = route.trim();
    if (!trimmed.includes('/login') && !trimmed.includes('/setup')) {
      current.lastRoute = trimmed;
      current.rememberLastRoute = true;
      try {
        writeDesktopSettings(current);
      } catch (err) {
        console.warn('[DesktopSettings] 记录上次停留路由失败:', err);
      }
    }
  }
  res.json({ success: true });
});

/**
 * 退出应用程序接口 (仅限已登录的本机桌面端运行时调用)
 */
router.post('/exit', (req: Request, res: Response): void => {
  if (!isDesktopRuntime() || !isLocalRequest(req)) {
    res.status(403).json({ success: false, error: '仅桌面端本机运行时允许执行退出操作' });
    return;
  }
  res.json({ success: true, message: '正在退出桌面端应用...' });
  setTimeout(() => {
    console.log('🚪 [DesktopSettings] 收到前端退出请求，正在终止后端服务...');
    process.exit(0);
  }, 100);
});

// ==========================================
// 桌面端专属：VPS 云端数据同步本地接口
// ==========================================

/**
 * 获取桌面端云端同步配置（apiKey 仅返回掩码，不暴露明文）
 */
router.get('/sync/config', (_req: Request, res: Response): void => {
  const settings = readDesktopSettings();
  res.json({
    success: true,
    config: buildPublicSyncConfig(settings),
  });
});

/**
 * 保存桌面端云端同步配置
 */
router.post('/sync/config', async (req: Request, res: Response): Promise<void> => {
  const { vpsUrl, apiKey, clearApiKey, conflictStrategy, autoSyncOnOpen, syncMode } = req.body || {};
  const current = readDesktopSettings();

  const nextVpsUrl = vpsUrl !== undefined ? String(vpsUrl).trim() : (current.syncVpsUrl || '');
  if (nextVpsUrl) {
    try {
      assertSafeSyncOutboundUrl(nextVpsUrl);
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message || '同步服务器地址不合法' });
      return;
    }
  }

  const currentKey = typeof current.syncApiKey === 'string' ? current.syncApiKey.trim() : '';
  const currentMask = maskSecret(currentKey);

  let nextApiKey = currentKey;
  if (clearApiKey === true) {
    nextApiKey = '';
  } else if (apiKey !== undefined) {
    const incomingKey = String(apiKey).trim();
    // 忽略空字符串或前端意外回传的掩码，仅在传入新明文密钥时覆盖
    if (incomingKey.length > 0 && incomingKey !== currentMask) {
      nextApiKey = incomingKey;
    } else if (nextVpsUrl && currentKey && !isSameOriginUrl(nextVpsUrl, current.syncVpsUrl)) {
      // 严禁在未提供新密钥的情况下，将已保存的旧密钥直接绑定到不同源的新服务器
      res.status(400).json({
        success: false,
        error: '更换同步服务器地址时，请重新输入对应的 API Key',
      });
      return;
    }
  } else if (nextVpsUrl && currentKey && !isSameOriginUrl(nextVpsUrl, current.syncVpsUrl)) {
    res.status(400).json({
      success: false,
      error: '更换同步服务器地址时，请重新输入对应的 API Key',
    });
    return;
  }

  const updated: DesktopSettings = {
    ...current,
    syncVpsUrl: nextVpsUrl,
    syncApiKey: nextApiKey,
    syncConflictStrategy: conflictStrategy || current.syncConflictStrategy || 'lww',
    syncMode: syncMode || current.syncMode || 'bidirectional',
    syncAutoOnOpen: typeof autoSyncOnOpen === 'boolean' ? autoSyncOnOpen : current.syncAutoOnOpen,
  };

  try {
    writeDesktopSettings(updated);
    if (updated.syncVpsUrl && updated.syncApiKey) {
      void settingsRepository.setSetting(
        'desktop_sync_config',
        JSON.stringify({ vpsUrl: updated.syncVpsUrl, apiKey: updated.syncApiKey })
      );
      syncThrottleScheduler.notifyChange();
      void syncWsClient.restart();
    } else {
      void settingsRepository.setSetting('desktop_sync_config', '');
      syncWsClient.stop();
    }
    res.json({
      success: true,
      message: '云端同步配置已保存',
      config: buildPublicSyncConfig(updated),
    });
  } catch (err: any) {
    console.error('[DesktopSync] 保存配置失败:', err);
    res.status(500).json({ success: false, error: '保存配置失败' });
  }
});

/**
 * 测试与 VPS 云端服务器的连通性
 */
router.post('/sync/test', async (req: Request, res: Response): Promise<void> => {
  try {
    const { vpsUrl, apiKey } = req.body || {};
    const settings = readDesktopSettings();
    const targetUrl = (typeof vpsUrl === 'string' && vpsUrl.trim() ? vpsUrl : (settings.syncVpsUrl || '')).trim();

    if (!targetUrl) {
      res.status(400).json({ success: false, error: '请输入 VPS 服务器地址' });
      return;
    }

    try {
      assertSafeSyncOutboundUrl(targetUrl);
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message || '同步服务器地址不合法' });
      return;
    }

    const keyResolution = resolveOutboundApiKey(apiKey, targetUrl, settings);
    if (!keyResolution.apiKey) {
      res.status(400).json({ success: false, error: keyResolution.error || '请输入同步 API Key' });
      return;
    }

    const testResult = await syncService.testRemoteConnection(targetUrl, keyResolution.apiKey);
    res.json({
      success: true,
      latencyMs: testResult.latencyMs,
      serverInfo: testResult.data,
    });
  } catch (err: any) {
    console.warn('[DesktopSync] 连通性测试失败:', err.message);
    res.status(502).json({
      success: false,
      error: `无法连接到 VPS 服务器: ${err.message}`,
    });
  }
});

/**
 * 触发一次全量双向增量同步或按需模块同步
 */
router.post('/sync/trigger', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body || {};
    const settings = readDesktopSettings();
    const vpsUrl = (typeof body.vpsUrl === 'string' && body.vpsUrl.trim() ? body.vpsUrl : (settings.syncVpsUrl || '')).trim();

    if (!vpsUrl) {
      res.status(400).json({
        success: false,
        error: '未配置 VPS 域名或 API Key，无法执行同步',
      });
      return;
    }

    try {
      assertSafeSyncOutboundUrl(vpsUrl);
    } catch (err: any) {
      res.status(400).json({
        success: false,
        error: err.message || '同步服务器地址不合法',
      });
      return;
    }

    const keyResolution = resolveOutboundApiKey(body.apiKey, vpsUrl, settings);
    if (!keyResolution.apiKey) {
      res.status(400).json({
        success: false,
        error: keyResolution.error || '未配置 VPS 域名或 API Key，无法执行同步',
      });
      return;
    }
    const apiKey = keyResolution.apiKey;

    const lastSyncTime = settings.syncLastTime || 0;
    const mode = body.mode || 'bidirectional';
    const modules = Array.isArray(body.modules)
      ? (body.modules.filter((m: unknown) => typeof m === 'string') as SyncModuleKey[])
      : undefined;

    // 同步范围（细项）发生变化时要退游标，否则「关掉的子项」期间的变更永久错过，
    // 重新勾上也得等下一次全量快照才会有数据。
    // 只比「新增了哪些子项」——收窄范围不需要重对齐，那样只是白跑一轮。
    const nextItems = [...resolveSyncItems(modules)];
    const prevItems = Array.isArray(settings.syncItems) ? (settings.syncItems as string[]) : null;
    if (prevItems && nextItems.some(item => !prevItems.includes(item))) {
      await syncV2Service.resetSyncCursors();
    }
    settings.syncItems = nextItems;

    const result = await syncService.triggerClientSync(vpsUrl, apiKey, lastSyncTime, mode, modules);

    // 同步成功，更新本地最后同步时间戳与当前同步模式偏好
    settings.syncLastTime = result.serverTime;
    if (body.mode) {
      settings.syncMode = body.mode;
    }
    writeDesktopSettings(settings);

    // 双向合并时协同执行 v2 增量游标同步。
    if (mode === 'bidirectional') {
      try {
        const v2Stats = await syncV2Service.executeSyncCycle(vpsUrl, apiKey, apiKey, modules);
        result.stats.pushed += v2Stats.pushed;
        result.stats.pulled += v2Stats.pulled;
      } catch (v2Err: any) {
        console.warn('[DesktopSync] 协同 v2 增量同步告警:', v2Err.message);
      }
    }

    res.json({
      success: true,
      message: '数据同步成功',
      lastSyncTime: result.serverTime,
      stats: result.stats,
    });
  } catch (err: any) {
    console.error('[DesktopSync] 执行同步失败:', err);
    res.status(500).json({
      success: false,
      error: `数据同步执行失败: ${err.message}`,
    });
  }
});

export default router;
