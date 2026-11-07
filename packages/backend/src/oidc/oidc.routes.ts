import { Router } from 'express';
import { isAuthenticated } from '../auth/auth.middleware';
import {
    getOidcProvidersHandler,
    oidcAuthorizeHandler,
    oidcCallbackHandler,
    getOidcLinksHandler,
    deleteOidcLinkHandler,
    getOidcSettingsHandler,
    updateOidcSettingsHandler,
} from './oidc.controller';

/**
 * OIDC 路由，挂载于 `/api/v1/auth/oidc`（见 auth.routes.ts）。
 *
 * 公开 / 受保护的边界与契约 §2 严格一致：
 * - 登录页要能列 provider、要能发起授权、IdP 要能回调 —— 这三条必须公开。
 * - 绑定列表与 provider 配置读写涉及账号数据与密钥 —— 一律 `isAuthenticated`。
 * 公开段写在 `router.use(isAuthenticated)` 之前，与 settings.routes.ts 的做法一致。
 */
const router = Router();

// --- 公开 ---
router.get('/providers', getOidcProvidersHandler);
router.get('/providers/:id/authorize', oidcAuthorizeHandler);
router.get('/providers/:id/callback', oidcCallbackHandler);

// --- 需登录 ---
router.use(isAuthenticated);
router.get('/links', getOidcLinksHandler);
router.delete('/links/:linkId', deleteOidcLinkHandler);
router.get('/settings', getOidcSettingsHandler);
router.put('/settings', updateOidcSettingsHandler);

export default router;
