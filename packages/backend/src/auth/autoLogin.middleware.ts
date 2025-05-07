import { Request, Response, NextFunction } from 'express';
import { settingsService } from '../services/settings.service';
import { userRepository } from '../repositories/user.repository';
import { createSessionForUser } from './auth.utils';

export const autoLoginMiddleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => { // 显式声明返回 Promise<void>
    console.log('[AutoLoginMiddleware] 自动登录检查开始...');

    const autoLoginSettings = await settingsService.getAutoLoginSettings();


    // 应用自身 IP 白名单自动登录
    if (autoLoginSettings.ipWhitelist?.enabled) {
        console.log('[AutoLoginMiddleware] 应用 IP 白名单自动登录已启用，开始检查...');
        const clientIp = req.ip || req.socket?.remoteAddress;
        console.log(`[AutoLoginMiddleware] 检查 IP 白名单，客户端 IP: '${clientIp}'`);

        if (clientIp && autoLoginSettings.ipWhitelist.allowedIPs.includes(clientIp)) {
            console.log(`[AutoLoginMiddleware] IP '${clientIp}' 在应用 IP 白名单中。尝试自动登录...`);
            try {
                const adminUser = await userRepository.findAdminUser();
                if (adminUser) {
                     // 在 autoLogin.middleware.ts 中调用 createSessionForUser 时传递 username
                    await createSessionForUser(req, adminUser.id, adminUser.username, 'IP Whitelist');
                    console.log(`[AutoLoginMiddleware] 已为管理员 '${adminUser.username}' 创建会话 (IP 白名单)。`);
                    res.status(200).json({
                        message: '通过 IP 白名单自动登录成功。',
                        user: { id: adminUser.id, username: adminUser.username }
                    });
                    return; // 函数在此处结束执行
                } else {
                    console.warn('[AutoLoginMiddleware] IP 白名单验证通过但未找到管理员用户。');
                }
            } catch (error) {
                console.error('[AutoLoginMiddleware] IP 白名单自动登录过程中创建会话失败:', error);
            }
        } else {
            console.log(`[AutoLoginMiddleware] IP '${clientIp}' 不在应用 IP 白名单中或无法获取 IP。`);
        }
    } else {
        console.log('[AutoLoginMiddleware] 应用 IP 白名单自动登录已禁用。');
    }

    // 3. 如果以上自动登录条件都不满足，则继续到标准登录流程
    console.log('[AutoLoginMiddleware] 未满足自动登录条件，继续执行后续中间件...');
    next();
};