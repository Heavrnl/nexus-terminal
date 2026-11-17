import { Router } from 'express';
import {
  login,
  verifyLogin2FA,
  changePassword,
  setup2FA,
  verifyAndActivate2FA,
  disable2FA,
  getAuthStatus,
  needsSetup,
  setupAdmin,
  desktopAutoLogin,
  logout,
  getPublicCaptchaConfig,
  // Passkey handlers
  generatePasskeyRegistrationOptionsHandler,
  verifyPasskeyRegistrationHandler,
  generatePasskeyAuthenticationOptionsHandler,
  verifyPasskeyAuthenticationHandler,
  // 新的 Passkey 管理处理器
  listUserPasskeysHandler,
  deleteUserPasskeyHandler,
  updateUserPasskeyNameHandler, // 更新 Passkey 名称的处理器
  checkHasPasskeys
} from './auth.controller';
import { isAuthenticated } from './auth.middleware';
import { ipBlacklistCheckMiddleware } from './ipBlacklistCheck.middleware';
import oidcRouter from '../oidc/oidc.routes';

const router = Router();

// --- Public CAPTCHA Configuration ---
// GET /api/v1/auth/captcha/config - 获取公共 CAPTCHA 配置 (公开访问)
router.get('/captcha/config', getPublicCaptchaConfig);

// --- Setup Routes (Public) ---
// GET /api/v1/auth/needs-setup - 检查是否需要初始设置 (公开访问)
router.get('/needs-setup', needsSetup);

// POST /api/v1/auth/setup - 执行初始管理员设置 (公开访问，控制器内部检查)
router.post('/setup', setupAdmin);

// POST /api/v1/auth/login - 用户登录接口 (添加黑名单检查)
router.post('/login', ipBlacklistCheckMiddleware, login);

// POST /api/v1/auth/auto-login - 桌面端免密账号自动登录 (公开访问；控制器内部判桌面端 + 本机)
router.post('/auto-login', ipBlacklistCheckMiddleware, desktopAutoLogin);

// PUT /api/v1/auth/password - 修改密码接口 (需要认证)
router.put('/password', isAuthenticated, changePassword);

// POST /api/v1/auth/login/2fa - 登录时的 2FA 验证接口 (添加黑名单检查)
// (不需要单独的 isAuthenticated，依赖 login 接口设置的临时 session)
router.post('/login/2fa', ipBlacklistCheckMiddleware, verifyLogin2FA);

// --- 2FA 管理接口 (都需要认证) ---
// POST /api/v1/auth/2fa/setup - 开始 2FA 设置，生成密钥和二维码
router.post('/2fa/setup', isAuthenticated, setup2FA);

// POST /api/v1/auth/2fa/verify - 验证设置时的 TOTP 码并激活
router.post('/2fa/verify', isAuthenticated, verifyAndActivate2FA);

// DELETE /api/v1/auth/2fa - 禁用 2FA (需要验证当前密码，在控制器中处理)
router.delete('/2fa', isAuthenticated, disable2FA);

// GET /api/v1/auth/status - 获取当前认证状态 (需要认证)
router.get('/status', isAuthenticated, getAuthStatus);

// --- Passkey Routes ---
// POST /api/v1/auth/passkey/registration-options - 生成 Passkey 注册选项 (需要认证)
router.post('/passkey/registration-options', isAuthenticated, generatePasskeyRegistrationOptionsHandler);

// POST /api/v1/auth/passkey/register - 验证并保存新的 Passkey (需要认证，因为通常在已登录会话中添加新凭据)
router.post('/passkey/register', isAuthenticated, verifyPasskeyRegistrationHandler);

// POST /api/v1/auth/passkey/authentication-options - 生成 Passkey 认证选项 (公开或半公开，取决于是否提供了用户名)
router.post('/passkey/authentication-options', generatePasskeyAuthenticationOptionsHandler);


// POST /api/v1/auth/passkey/authenticate - 验证 Passkey 并登录用户 (公开)
router.post('/passkey/authenticate', ipBlacklistCheckMiddleware, verifyPasskeyAuthenticationHandler);

// GET /api/v1/auth/passkey/has-configured - 检查是否配置了 Passkey (公开)
router.get('/passkey/has-configured', checkHasPasskeys);

// --- User's Passkey Management Routes (New) ---
// GET /api/v1/auth/user/passkeys - 获取当前用户的所有 Passkey (需要认证)
router.get('/user/passkeys', isAuthenticated, listUserPasskeysHandler);

// DELETE /api/v1/auth/user/passkeys/:credentialID - 删除当前用户指定的 Passkey (需要认证)
router.delete('/user/passkeys/:credentialID', isAuthenticated, deleteUserPasskeyHandler);

// PUT /api/v1/auth/user/passkeys/:credentialID/name - 更新当前用户指定的 Passkey 名称 (需要认证)
router.put('/user/passkeys/:credentialID/name', isAuthenticated, updateUserPasskeyNameHandler);
 
 
// --- OIDC Routes ---
// 挂载到 /api/v1/auth/oidc，公开/受保护边界由 oidc.routes.ts 内部控制（见契约 §2）
router.use('/oidc', oidcRouter);

// POST /api/v1/auth/logout - 用户登出接口 (公开访问)
router.post('/logout', logout);


export default router;
