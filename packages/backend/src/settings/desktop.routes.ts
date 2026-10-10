// packages/backend/src/settings/desktop.routes.ts
import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { getDataDir } from '../services/storage-path.service';

const router = Router();

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
 * 获取桌面客户端配置
 */
router.get('/settings', (req: Request, res: Response) => {
  const settings = readDesktopSettings();
  if (!settings.closeBehavior) {
    settings.closeBehavior = 'minimize_to_tray';
  }
  if (typeof settings.rememberCloseChoice !== 'boolean') {
    settings.rememberCloseChoice = false;
  }
  res.json(settings);
});

/**
 * 更新桌面客户端配置
 */
router.put('/settings', (req: Request, res: Response): void => {
  const { closeBehavior, rememberCloseChoice, windowState, actionToExecute } = req.body;
  if (closeBehavior && !['minimize_to_tray', 'quit'].includes(closeBehavior)) {
    res.status(400).json({ error: '无效的 closeBehavior 参数，仅支持 minimize_to_tray 或 quit' });
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
    res.json({ success: true, settings: updated });
  } catch (err: any) {
    console.error('[DesktopSettings] 保存 desktop-settings.json 失败:', err);
    res.status(500).json({ error: '保存配置失败', details: err.message });
  }
});

/**
 * 退出应用程序接口 (由前端触发彻底关闭)
 */
router.post('/exit', (req: Request, res: Response): void => {
  res.json({ success: true, message: '正在退出桌面端应用...' });
  setTimeout(() => {
    console.log('🚪 [DesktopSettings] 收到前端退出请求，正在终止后端服务...');
    process.exit(0);
  }, 100);
});

export default router;
