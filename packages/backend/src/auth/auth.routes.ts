import { Router } from 'express';
import {
  login,
  verifyLogin2FA,
  changePassword,
  setup2FA,
  verifyAndActivate2FA,
  disable2FA,
  getAuthStatus,
  // Removed Passkey imports
  needsSetup,
  setupAdmin,
  logout,
  getPublicCaptchaConfig,
  enableAutoLoginForCurrentIp // <-- 导入新的控制器方法
} from './auth.controller';
import { isAuthenticated } from './auth.middleware';
import { ipBlacklistCheckMiddleware } from './ipBlacklistCheck.middleware';
import { autoLoginMiddleware } from './autoLogin.middleware'; // <-- 导入新的自动登录中间件

const router = Router();

// --- Public CAPTCHA Configuration ---
// GET /api/v1/auth/captcha/config - 获取公共 CAPTCHA 配置 (公开访问)
router.get('/captcha/config', getPublicCaptchaConfig);

// --- Setup Routes (Public) ---
// GET /api/v1/auth/needs-setup - 检查是否需要初始设置 (公开访问)
router.get('/needs-setup', needsSetup);

// POST /api/v1/auth/setup - 执行初始管理员设置 (公开访问，控制器内部检查)
router.post('/setup', setupAdmin);

// POST /api/v1/auth/login - 用户登录接口 (添加自动登录和黑名单检查)
// autoLoginMiddleware 应该在 ipBlacklistCheckMiddleware 之前，因为它可能直接完成登录并返回响应
router.post('/login', autoLoginMiddleware, ipBlacklistCheckMiddleware, login);

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

// --- Passkey routes removed ---

// POST /api/v1/auth/logout - 用户登出接口 (公开访问)
router.post('/logout', logout);

// POST /api/v1/auth/settings/enable-auto-login-ip - 为当前IP启用自动登录白名单 (需要认证)
router.post('/settings/enable-auto-login-ip', isAuthenticated, enableAutoLoginForCurrentIp);


export default router;
