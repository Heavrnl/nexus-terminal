import express from 'express';
import crypto from 'crypto';
import { workspaceSyncController } from './workspace-sync.controller';
import { isAuthenticated } from '../auth/auth.middleware';
import { getServerSyncApiKey } from '../sync/sync.middleware';

const router = express.Router();

function safeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const isAuthenticatedOrSyncApiKey = async (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
  // 1. 若拥有会话 Session，直接放行
  if (req.session && req.session.userId) {
    return next();
  }

  // 2. 检查是否携带有效的 Sync API Key
  const clientKey = (
    req.headers['x-api-key'] ||
    req.headers['x-device-token'] ||
    req.headers['x-sync-api-key'] ||
    req.query.apiKey
  ) as string | undefined;

  if (clientKey && typeof clientKey === 'string' && clientKey.trim() !== '') {
    try {
      const serverKey = await getServerSyncApiKey();
      if (serverKey && safeCompare(clientKey.trim(), serverKey.trim())) {
        if (!req.session) {
          (req as any).session = {};
        }
        req.session.userId = 1;
        return next();
      }
    } catch (err) {
      console.warn('[WorkspaceSyncRoutes] 校验 API Key 异常:', err);
    }
  }

  // 3. 否则交由默认 isAuthenticated 认证拦截
  return isAuthenticated(req, res, next);
};

router.get('/mode', isAuthenticatedOrSyncApiKey, (req, res) => workspaceSyncController.getRuntimeMode(req, res));
router.get('/', isAuthenticatedOrSyncApiKey, (req, res) => workspaceSyncController.getState(req, res));
router.post('/claim', isAuthenticatedOrSyncApiKey, (req, res) => workspaceSyncController.claimLease(req, res));
router.post('/save', isAuthenticatedOrSyncApiKey, (req, res) => workspaceSyncController.saveState(req, res));
router.delete('/sessions/:sessionId', isAuthenticatedOrSyncApiKey, (req, res) => workspaceSyncController.destroySession(req, res));

export default router;
